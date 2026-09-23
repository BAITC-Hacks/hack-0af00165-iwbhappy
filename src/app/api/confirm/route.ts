import { consumeProposal, getCart } from "@/lib/db";
import { log, newTraceId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Путь А раздела 6: подтверждение кнопкой.
 *
 * Идёт из интерфейса прямо в сервер, минуя модель. Модель в этом вызове
 * не участвует и подделать его не может — поэтому нажатие «Да» является
 * самым надёжным из двух путей подтверждения.
 */
export async function POST(req: Request) {
  const traceId = newTraceId();
  const body = (await req.json().catch(() => ({}))) as { sessionId?: string; proposalId?: string };

  const sessionId = (body.sessionId || "").trim();
  const proposalId = (body.proposalId || "").trim();
  if (!sessionId || !proposalId) {
    return Response.json({ error: "нужны sessionId и proposalId" }, { status: 400 });
  }

  const res = await consumeProposal(sessionId, proposalId);

  if (!res.ok) {
    const human: Record<string, string> = {
      NOT_FOUND: "Предложение не найдено. Попросите агента предложить товар заново.",
      ALREADY_USED: "Это предложение уже подтверждено.",
      NO_STOCK: "Товара не осталось в наличии.",
      PRODUCT_GONE: "Товар пропал из каталога.",
    };
    log({ kind: "tool", event: "confirm_button.reject", traceId, detail: { sessionId, proposalId, reason: res.error } });
    return Response.json({ error: human[res.error], code: res.error, cart: await getCart(sessionId) }, { status: 409 });
  }

  log({
    kind: "tool", event: "confirm_button.ok", traceId,
    detail: { sessionId, proposalId, added: res.added, capped: res.capped },
  });

  return Response.json({
    cart: res.cart,
    added: res.added,
    capped: res.capped,
    availableQty: res.availableQty,
  });
}
