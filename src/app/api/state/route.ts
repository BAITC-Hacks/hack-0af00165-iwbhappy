import { CONFIG, hasLiveKey } from "@/lib/config";
import { CATALOG_SIZE, DB_INFO, getCart, pickDemoSkus } from "@/lib/db";
import { fillDemoPrompts } from "@/lib/agent/prompts";
import { recentLogs } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Состояние сессии для панели корзины + диагностика для демо. */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) return Response.json({ error: "нужен sessionId" }, { status: 400 });

  const [cart, demo] = await Promise.all([getCart(sessionId), pickDemoSkus()]);

  return Response.json({
    cart,
    demoPrompts: fillDemoPrompts(demo.inStock, demo.outOfStock),
    demoSkus: demo,
    env: {
      llmMode: CONFIG.llm.mode,
      hasKey: hasLiveKey(),
      model: CONFIG.llm.model,
      catalogSize: CATALOG_SIZE,
      dbEphemeral: DB_INFO.ephemeral,
    },
    logs: recentLogs(30),
  });
}
