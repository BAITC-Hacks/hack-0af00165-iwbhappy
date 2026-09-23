import { runAgent, type AgentEvent } from "@/lib/agent/loop";
import type { Msg } from "@/lib/llm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Агентный цикл, отданный наружу как SSE.
 * Каждое событие цикла — одна строка data: с JSON внутри.
 */

type Body = { sessionId?: string; message?: string; history?: Msg[] };

/**
 * Обрезает историю, не разрывая связку «assistant с tool_calls -> tool-ответы».
 * Если резать просто по -N, в начало может попасть осиротевший tool-ответ,
 * и провайдер вернёт 400 прямо во время демо. Поэтому сдвигаемся вперёд
 * до ближайшей реплики пользователя — она всегда безопасная граница.
 */
function trimHistory(history: Msg[], keep: number): Msg[] {
  if (history.length <= keep) return history;
  let start = history.length - keep;
  while (start < history.length && history[start].role !== "user") start++;
  return history.slice(start);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "ожидался JSON" }, { status: 400 });
  }

  const sessionId = (body.sessionId || "").trim();
  const message = (body.message || "").trim();
  if (!sessionId) return Response.json({ error: "нужен sessionId" }, { status: 400 });
  if (!message) return Response.json({ error: "пустое сообщение" }, { status: 400 });

  // Историю храним на клиенте, но обрезаем: длинный хвост диалога —
  // самый дешёвый способ упереться в лимит токенов посреди демо.
  const history = trimHistory((body.history ?? []).filter((m) => m.role !== "system"), 24);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        for await (const event of runAgent({ sessionId, history, message, origin: new URL(req.url).origin })) send(event);
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
