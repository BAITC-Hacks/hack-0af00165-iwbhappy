import { redactForLog } from "./redact";

/**
 * Лог вызовов модели и инструментов. Пишется в stdout (виден в `vercel logs`)
 * и в кольцевой буфер в памяти, который отдаётся на /api/state — удобно
 * показывать жюри, не открывая терминал.
 */

export type LogEntry = {
  ts: string;
  kind: "llm" | "tool" | "agent" | "error";
  event: string;
  traceId: string;
  ms?: number;
  detail?: Record<string, unknown>;
};

const RING_SIZE = 200;
const ring: LogEntry[] = [];

/** Все строки в detail проходят маскирование: журнал — это тоже хранение. */
function scrub(v: unknown): unknown {
  if (typeof v === "string") return redactForLog(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

export function log(entry: Omit<LogEntry, "ts">): void {
  const full: LogEntry = {
    ts: new Date().toISOString(),
    ...entry,
    detail: entry.detail ? (scrub(entry.detail) as Record<string, unknown>) : undefined,
  };
  ring.push(full);
  if (ring.length > RING_SIZE) ring.shift();

  const head = `[${full.kind}] ${full.event}`;
  const tail = full.ms !== undefined ? ` ${full.ms}ms` : "";
  // eslint-disable-next-line no-console
  console.log(`${head}${tail}`, JSON.stringify({ traceId: full.traceId, ...full.detail }));
}

export function recentLogs(limit = 50): LogEntry[] {
  return ring.slice(-limit);
}

export function newTraceId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}
