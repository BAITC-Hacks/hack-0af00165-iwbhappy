/**
 * Единственное место, где настраивается модель, ключ и все лимиты.
 * В день хакатона правится только этот файл (или переменные в Vercel).
 */

export type LlmMode = "live" | "mock" | "auto";

export const CONFIG = {
  llm: {
    /** live — только сеть; mock — только записанные ответы; auto — live с откатом в mock */
    mode: (process.env.LLM_MODE as LlmMode) || "auto",
    apiKey: process.env.OPENAI_API_KEY || "",
    /** пусто = api.openai.com. Сюда же вписывается NVIDIA NIM / OpenRouter / любой OpenAI-совместимый шлюз */
    baseUrl: process.env.OPENAI_BASE_URL || undefined,
    model: process.env.LLM_MODEL || "gpt-4.1-mini",
    /** на что падаем при 429/5xx на основной модели */
    fallbackModel: process.env.LLM_FALLBACK_MODEL || "gpt-4.1-nano",
    temperature: 0.2,
    maxTokens: 900,
    /** таймаут одного обращения к модели, мс */
    requestTimeoutMs: 25_000,
    /** сколько раз повторяем одно обращение (не считая первой попытки) */
    maxRetries: 2,
    retryBaseDelayMs: 400,
    retryMaxDelayMs: 4_000,
  },

  agent: {
    /** максимум витков цикла «модель -> инструменты -> модель» за один запрос */
    maxSteps: 6,
    /** сколько раз даём модели переписать невалидные аргументы инструмента */
    maxArgRepairs: 1,
    /** общий бюджет времени на запрос, мс — чтобы демо не висло */
    totalBudgetMs: 60_000,
  },

  db: {
    url: process.env.DB_URL || "file:./.data/hack.db",
    authToken: process.env.DB_AUTH_TOKEN || undefined,
  },

  demo: {
    /** курс отображения: цены в базе хранятся в тенге */
    currency: "₸",
  },
} as const;

export function hasLiveKey(): boolean {
  return CONFIG.llm.apiKey.trim().length > 0;
}

/** Разрешено ли вообще ходить в сеть при текущем режиме. */
export function liveAllowed(): boolean {
  return CONFIG.llm.mode !== "mock" && hasLiveKey();
}

/** Разрешено ли откатиться на записанные ответы. */
export function mockAllowed(): boolean {
  return CONFIG.llm.mode !== "live";
}
