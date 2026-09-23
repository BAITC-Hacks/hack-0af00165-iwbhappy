import { CONFIG, hasLiveKey } from "@/lib/config";
import { CATALOG_SIZE, DB_INFO, getCart, pickDemoSkus } from "@/lib/db";
import { fillDemoPrompts } from "@/lib/agent/prompts";
import { recentLogs } from "@/lib/logger";
import { cartUrl } from "@/lib/agent/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Состояние сессии для панели корзины + диагностика для демо. */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) return Response.json({ error: "нужен sessionId" }, { status: 400 });

  const origin = new URL(req.url).origin;
  const [cart, demo, link] = await Promise.all([getCart(sessionId), pickDemoSkus(), cartUrl(sessionId, origin)]);

  return Response.json({
    cart,
    cartUrl: link,
    demoPrompts: fillDemoPrompts(demo.inStock, demo.outOfStock),
    demoSkus: demo,
    env: {
      llmMode: CONFIG.llm.mode,
      hasKey: hasLiveKey(),
      model: CONFIG.llm.model,
      catalogSize: CATALOG_SIZE,
      dbEphemeral: DB_INFO.ephemeral,
    },
    // Журнал общий для всех сессий: в нём чужие реплики и чужие sessionId,
    // а sessionId — ключ к корзине. Наружу — только при локальной разработке.
    logs: process.env.NODE_ENV === "production" ? [] : recentLogs(30),
  });
}
