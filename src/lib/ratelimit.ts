/**
 * Ограничение частоты запросов к платным маршрутам (чат, распознавание фото).
 *
 * Публичная ссылка + ключ к модели = любой может сжечь бюджет. Окно
 * скользящее, в памяти процесса. На serverless у каждого экземпляра своя
 * память, так что это защита от одного назойливого клиента, а не от
 * распределённой атаки: для прода — WAF Vercel или Redis-лимитер.
 * Честно так и написано в README.
 */

const buckets = new Map<string, number[]>();

export function allow(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  buckets.set(key, hits);
  // Не даём карте расти бесконечно.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
  }
  return { ok: true, retryAfterSec: 0 };
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
}

export const LIMITS = {
  chatPerMinute: 20,
  uploadPerMinute: 6,
  maxMessageChars: 2000,
};
