import { CONFIG, hasLiveKey } from "@/lib/config";
import { DB_INFO, getCart, listOrders } from "@/lib/db";
import { recentLogs } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Состояние сессии для панели справа + диагностика для демо. */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) return Response.json({ error: "нужен sessionId" }, { status: 400 });

  const [cart, orders] = await Promise.all([getCart(sessionId), listOrders(sessionId)]);

  return Response.json({
    cart,
    orders,
    env: {
      llmMode: CONFIG.llm.mode,
      hasKey: hasLiveKey(),
      model: CONFIG.llm.model,
      fallbackModel: CONFIG.llm.fallbackModel,
      dbEphemeral: DB_INFO.ephemeral,
    },
    logs: recentLogs(30),
  });
}
