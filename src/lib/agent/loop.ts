import { CONFIG } from "../config";
import { getCart, type Cart } from "../db";
import { completeStream } from "../llm/client";
import { bridgeTokens } from "./bridge";
import type { Msg } from "../llm/types";
import { log, newTraceId } from "../logger";
import { SYSTEM_PROMPT } from "./prompts";
import { executeTool, TOOL_SPECS } from "./tools";

/**
 * Единственный агентный цикл приложения.
 *
 *   модель -> (вызовы инструментов) -> результаты -> модель -> ... -> ответ
 *
 * Наружу отдаётся поток событий: интерфейс рисует по ним и текст,
 * и ленту вызовов инструментов, и состояние корзины/заказов.
 * Именно эта лента доказывает жюри, что агент действительно
 * что-то делает, а не пересказывает каталог.
 */

export type AgentEvent =
  | { type: "status"; phase: "thinking" | "tools" | "answering" }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; ms: number; client?: Record<string, unknown> }
  | { type: "token"; text: string }
  | { type: "state"; cart: Cart }
  | { type: "history"; messages: Msg[] }
  | { type: "done"; traceId: string; steps: number; ms: number; source: "live" | "mock"; model: string }
  | { type: "error"; message: string };

export type AgentInput = {
  sessionId: string;
  /** История без системного сообщения: её хранит клиент, сервер не держит состояние диалога. */
  history: Msg[];
  message: string;
};

// Корзину меняет ровно один инструмент — это и есть инвариант раздела 6.
const CART_TOUCHING = new Set(["confirm_add"]);

export async function* runAgent(input: AgentInput): AsyncGenerator<AgentEvent, void, unknown> {
  const traceId = newTraceId();
  const startedAt = Date.now();
  // Сырую реплику клиента и границу хода фиксирует сервер. Инструмент
  // confirm_add опирается на них, а не на то, что скажет модель.
  const turnStartedAt = new Date().toISOString();
  const ctx = {
    sessionId: input.sessionId,
    lastUserMessage: input.message,
    turnStartedAt,
  };

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...input.history,
    { role: "user", content: input.message },
  ];

  // Всё, что дописано за этот ход: реплика пользователя, вызовы инструментов
  // и их результаты. Отдаём клиенту, чтобы на следующем ходу модель помнила
  // id показанных товаров, а не искала их заново.
  const deltaFrom = messages.length - 1;

  let steps = 0;
  let repairs = 0;
  let source: "live" | "mock" = "mock";
  let model = "—";

  log({ kind: "agent", event: "start", traceId, detail: { sessionId: input.sessionId, message: input.message } });

  try {
    while (steps < CONFIG.agent.maxSteps) {
      if (Date.now() - startedAt > CONFIG.agent.totalBudgetMs) {
        yield { type: "error", message: "Агент не уложился в бюджет времени. Попробуйте переформулировать короче." };
        break;
      }

      steps++;
      yield { type: "status", phase: steps === 1 ? "thinking" : "answering" };

      const bridge = bridgeTokens((onToken) => completeStream(traceId, messages, TOOL_SPECS, onToken));
      for await (const text of bridge.tokens()) yield { type: "token", text };

      const turn = await bridge.result();
      source = turn.source;
      model = turn.model;

      // Инструментов нет — модель ответила, цикл закончен.
      if (turn.toolCalls.length === 0) {
        messages.push({ role: "assistant", content: turn.content });
        break;
      }

      messages.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls });
      yield { type: "status", phase: "tools" };

      let touchedState = false;

      for (const call of turn.toolCalls) {
        yield { type: "tool_call", id: call.id, name: call.name, args: safeParse(call.arguments) };

        const t0 = Date.now();
        let outcome;
        try {
          outcome = await executeTool(call.name, call.arguments, ctx);
        } catch (e) {
          // Падение инструмента не роняет диалог: модель получает текст ошибки
          // и обычно сама предлагает пользователю обходной путь.
          const message = (e as Error).message;
          log({ kind: "error", event: "tool_threw", traceId, detail: { tool: call.name, message } });
          outcome = { kind: "ok" as const, result: { ok: false, data: { error: `внутренняя ошибка: ${message}` }, summary: `сбой: ${message}` } };
        }
        const ms = Date.now() - t0;

        if (outcome.kind === "invalid_args") {
          repairs++;
          const exhausted = repairs > CONFIG.agent.maxArgRepairs;
          const content = exhausted
            ? JSON.stringify({ error: `аргументы снова не валидны (${outcome.message}). Не вызывай этот инструмент больше — объясни пользователю, что не хватает, и спроси недостающее.` })
            : JSON.stringify({ error: `неверные аргументы: ${outcome.message}. Исправь и вызови инструмент ещё раз.` });

          log({ kind: "tool", event: "invalid_args", traceId, ms, detail: { tool: call.name, repairs, exhausted, message: outcome.message } });
          yield { type: "tool_result", id: call.id, name: call.name, ok: false, summary: `аргументы отклонены: ${outcome.message}`, ms };
          messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
          continue;
        }

        const { result } = outcome;
        if (CART_TOUCHING.has(call.name)) touchedState = true;

        log({ kind: "tool", event: call.name, traceId, ms, detail: { ok: result.ok, summary: result.summary } });
        yield {
          type: "tool_result", id: call.id, name: call.name,
          ok: result.ok, summary: result.summary, ms,
          ...(result.client ? { client: result.client } : {}),
        };
        messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(result.data) });
      }

      if (touchedState) {
        yield { type: "state", cart: await getCart(input.sessionId) };
      }
    }

    if (steps >= CONFIG.agent.maxSteps) {
      log({ kind: "agent", event: "max_steps", traceId, detail: { steps } });
    }
  } catch (e) {
    const message = (e as Error).message;
    log({ kind: "error", event: "agent_failed", traceId, detail: { message } });
    yield { type: "error", message };
  }

  // Финальное состояние отдаём всегда — интерфейс не должен зависеть
  // от того, угадали ли мы, какой инструмент что поменял.
  yield { type: "state", cart: await getCart(input.sessionId) };
  yield { type: "history", messages: messages.slice(deltaFrom) };
  yield { type: "done", traceId, steps, ms: Date.now() - startedAt, source, model };

  log({ kind: "agent", event: "done", traceId, ms: Date.now() - startedAt, detail: { steps, source, model } });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
