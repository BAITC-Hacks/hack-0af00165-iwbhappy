import { getCart, listOrders, resetSession } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Кнопка «сброс» — чтобы прогонять демо подряд без перезапуска. */
export async function POST(req: Request) {
  const { sessionId } = (await req.json().catch(() => ({}))) as { sessionId?: string };
  if (!sessionId) return Response.json({ error: "нужен sessionId" }, { status: 400 });
  await resetSession(sessionId);
  return Response.json({ cart: await getCart(sessionId), orders: await listOrders(sessionId) });
}
