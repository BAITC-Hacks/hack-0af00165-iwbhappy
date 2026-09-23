import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { CONFIG, liveAllowed, mockAllowed } from "../config";
import { log } from "../logger";
import { mockTurn } from "./mock";
import { LlmError, type ModelTurn, type Msg, type ToolSpec } from "./types";

/**
 * Обвязка над моделью: таймаут, ретраи с backoff, запасная модель,
 * лог каждого вызова и откат на записанные ответы.
 *
 * Наружу торчит одна функция — completeStream(). Она стримит текст
 * и одновременно собирает вызовы инструментов из дельт, так что
 * агентному циклу не нужно выбирать между «видно, как печатает»
 * и «умеет звать инструменты».
 */

let sdk: OpenAI | null = null;
function client(): OpenAI {
  if (!sdk) {
    sdk = new OpenAI({
      apiKey: CONFIG.llm.apiKey,
      baseURL: CONFIG.llm.baseUrl,
      timeout: CONFIG.llm.requestTimeoutMs,
      maxRetries: 0, // ретраим сами: нужно логировать и уметь сменить модель
    });
  }
  return sdk;
}

function toOpenAiMessages(messages: Msg[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        ...(m.tool_calls?.length
          ? {
              tool_calls: m.tool_calls.map((t) => ({
                id: t.id,
                type: "function" as const,
                function: { name: t.name, arguments: t.arguments },
              })),
            }
          : {}),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAiTools(tools: ToolSpec[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function classify(err: unknown): LlmError {
  const e = err as { status?: number; message?: string; name?: string; code?: string };
  const status = e?.status;
  const msg = e?.message || String(err);
  if (e?.name === "AbortError" || e?.code === "ETIMEDOUT" || /timeout|timed out/i.test(msg)) {
    return new LlmError(`таймаут модели: ${msg}`, 408, true);
  }
  if (status === 429) return new LlmError("rate limit", 429, true);
  if (status !== undefined && status >= 500) return new LlmError(`сервер модели: ${status}`, status, true);
  if (status === 401 || status === 403) return new LlmError("ключ отклонён", status, false);
  if (status === 400) return new LlmError(`некорректный запрос: ${msg}`, 400, false);
  return new LlmError(msg, status, status === undefined); // сетевые сбои без статуса повторяем
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number): number {
  const base = CONFIG.llm.retryBaseDelayMs * 2 ** attempt;
  const jitter = Math.random() * CONFIG.llm.retryBaseDelayMs;
  return Math.min(base + jitter, CONFIG.llm.retryMaxDelayMs);
}

type StreamAcc = { id: string; name: string; arguments: string };

/** Один живой проход по сети. Токены уходят в onToken по мере прихода. */
async function liveAttempt(
  model: string,
  messages: Msg[],
  tools: ToolSpec[],
  onToken: (t: string) => void,
  markEmitted: () => void,
): Promise<ModelTurn> {
  const stream = await client().chat.completions.create({
    model,
    messages: toOpenAiMessages(messages),
    tools: toOpenAiTools(tools),
    tool_choice: "auto",
    temperature: CONFIG.llm.temperature,
    max_tokens: CONFIG.llm.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  });

  let content = "";
  const acc: StreamAcc[] = [];
  let usage: ModelTurn["usage"];

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = { prompt: chunk.usage.prompt_tokens ?? 0, completion: chunk.usage.completion_tokens ?? 0 };
    }
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      markEmitted();
      onToken(delta.content);
    }

    // Вызовы инструментов приходят кусками: id и имя один раз, аргументы по частям.
    for (const tc of delta.tool_calls ?? []) {
      const slot = (acc[tc.index] ??= { id: "", name: "", arguments: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
    }
  }

  return {
    content: content || null,
    toolCalls: acc.filter((a) => a.name).map((a) => ({ id: a.id || `call_${a.name}`, name: a.name, arguments: a.arguments })),
    model,
    source: "live",
    usage,
  };
}

/**
 * Ход модели со стримингом.
 *
 * Повторы и смена модели разрешены только пока ни одного токена
 * не ушло наружу — иначе пользователь увидит склейку двух ответов.
 * После первого токена сбой честно превращается в ошибку.
 */
export async function completeStream(
  traceId: string,
  messages: Msg[],
  tools: ToolSpec[],
  onToken: (t: string) => void,
): Promise<ModelTurn> {
  let emitted = false;
  const markEmitted = () => { emitted = true; };

  if (liveAllowed()) {
    const chain = [CONFIG.llm.model, CONFIG.llm.fallbackModel].filter((m, i, a) => m && a.indexOf(m) === i);
    let last: LlmError | null = null;

    outer: for (const model of chain) {
      for (let attempt = 0; attempt <= CONFIG.llm.maxRetries; attempt++) {
        const t0 = Date.now();
        try {
          const turn = await liveAttempt(model, messages, tools, onToken, markEmitted);
          log({
            kind: "llm", event: "complete.ok", traceId, ms: Date.now() - t0,
            detail: { model, attempt, tools: turn.toolCalls.map((t) => t.name), usage: turn.usage },
          });
          return turn;
        } catch (raw) {
          last = classify(raw);
          log({
            kind: "llm", event: "complete.fail", traceId, ms: Date.now() - t0,
            detail: { model, attempt, status: last.status, retryable: last.retryable, emitted, message: last.message },
          });
          if (emitted) break outer;         // часть ответа уже у пользователя — не переигрываем
          if (!last.retryable) break;       // 400/401 повторять бессмысленно
          if (attempt < CONFIG.llm.maxRetries) await sleep(backoff(attempt));
        }
      }
      if (!emitted) log({ kind: "llm", event: "complete.switch_model", traceId, detail: { from: model } });
    }

    if (!mockAllowed() || emitted) throw last ?? new LlmError("модель недоступна");
    log({ kind: "llm", event: "fallback_to_mock", traceId, detail: { reason: last?.message } });
  } else if (!mockAllowed()) {
    throw new LlmError("LLM_MODE=live, но OPENAI_API_KEY пуст");
  }

  // ---- записанный режим ----
  const turn = mockTurn(messages);
  if (turn.content) {
    for (const piece of turn.content.match(/.{1,18}/gs) ?? []) {
      await sleep(16);
      onToken(piece);
    }
  }
  log({ kind: "llm", event: "mock.ok", traceId, detail: { tools: turn.toolCalls.map((t) => t.name) } });
  return turn;
}
