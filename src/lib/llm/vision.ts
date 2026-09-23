import OpenAI from "openai";
import { CONFIG, hasLiveKey } from "../config";
import { log } from "../logger";

/**
 * Распознавание фото товара — раздел 5 ТЗ («вход: фото и файлы»).
 *
 * Принципиально отдельный одноразовый вызов, а не часть агентного цикла:
 * картинка никогда не попадает в поток сообщений модели, и стриминг с
 * ретраями в llm/client.ts остаётся нетронутым.
 *
 * Сравнения изображений здесь нет и не будет. В каталоге электротехника,
 * где все модульные автоматы выглядят одинаково, — визуальное сходство
 * почти не несёт сигнала. Зато на фото почти всегда виден текст: артикул,
 * бренд, номинал. Модель читает его и отдаёт короткий JSON, а дальше
 * работает обычный поиск по каталогу.
 */

export type VisionExtract = {
  /** Артикул, если он читается на фото. */
  sku: string | null;
  brand: string | null;
  /** Тип изделия словами: «автоматический выключатель», «УЗО», «кабель». */
  kind: string | null;
  /** Характеристики, различимые на фото: «16А», «1P», «230В». */
  specs: string[];
  /** Строка для поиска по каталогу — то, что уйдёт в search_catalog. */
  query: string;
  ok: boolean;
  note: string | null;
};

const EMPTY: VisionExtract = {
  sku: null, brand: null, kind: null, specs: [], query: "", ok: false,
  note: "Не удалось разобрать фото.",
};

const PROMPT = `На фото — электротехническое изделие или его упаковка.

Прочитай всё, что написано на изделии и этикетке, и верни СТРОГО JSON:
{"sku": "артикул или null", "brand": "производитель или null", "kind": "тип изделия словами или null", "specs": ["16А", "1P", "230В"], "query": "строка для поиска по каталогу"}

Правила:
- Переписывай надписи буквально, ничего не додумывай. Не видно — ставь null.
- В specs клади только то, что реально читается на фото.
- В query собери 3-6 слов для поиска: тип изделия, бренд, номинал. Без лишних слов.
- Никакого текста вокруг JSON.`;

let sdk: OpenAI | null = null;
function client(): OpenAI {
  if (!sdk) {
    sdk = new OpenAI({
      apiKey: CONFIG.llm.apiKey,
      baseURL: CONFIG.llm.baseUrl,
      timeout: CONFIG.llm.requestTimeoutMs,
      maxRetries: 1,
    });
  }
  return sdk;
}

/**
 * @param dataUrl изображение как data:image/...;base64,...
 */
export async function extractFromImage(traceId: string, dataUrl: string): Promise<VisionExtract> {
  if (!hasLiveKey()) {
    return { ...EMPTY, note: "Распознавание фото требует ключа к модели. Сейчас он не задан." };
  }
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
    return { ...EMPTY, note: "Поддерживаются только изображения PNG, JPEG, WebP и GIF." };
  }

  const t0 = Date.now();
  try {
    const res = await client().chat.completions.create({
      model: CONFIG.llm.model,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
          ],
        },
      ],
    });

    const raw = res.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as Partial<VisionExtract>;

    const specs = Array.isArray(parsed.specs) ? parsed.specs.map(String).slice(0, 6) : [];
    const query = [parsed.kind, parsed.brand, ...specs].filter(Boolean).join(" ").trim()
      || String(parsed.query ?? "").trim();

    log({
      kind: "llm", event: "vision.ok", traceId, ms: Date.now() - t0,
      detail: { sku: parsed.sku ?? null, brand: parsed.brand ?? null, specs: specs.length },
    });

    const sku = parsed.sku ? String(parsed.sku).trim() : null;
    if (!sku && !query) {
      return { ...EMPTY, note: "На фото не удалось разобрать ни артикул, ни характеристики. Напишите артикул текстом." };
    }

    return {
      sku,
      brand: parsed.brand ? String(parsed.brand).trim() : null,
      kind: parsed.kind ? String(parsed.kind).trim() : null,
      specs,
      query,
      ok: true,
      note: null,
    };
  } catch (e) {
    const message = (e as Error).message;
    log({ kind: "error", event: "vision.fail", traceId, ms: Date.now() - t0, detail: { message } });
    return { ...EMPTY, note: `Не удалось разобрать фото: ${message}` };
  }
}

/** Человеческая строка для чата: то, что агент увидит вместо картинки. */
export function describeExtract(v: VisionExtract): string {
  if (!v.ok) return v.note ?? "Фото не распознано.";
  const parts: string[] = [];
  if (v.kind) parts.push(v.kind);
  if (v.brand) parts.push(v.brand);
  if (v.specs.length) parts.push(v.specs.join(", "));
  const head = parts.length ? parts.join(", ") : v.query;
  return v.sku
    ? `Клиент прислал фото товара. На нём читается артикул ${v.sku}${head ? ` (${head})` : ""}.`
    : `Клиент прислал фото товара. Артикул не читается, видно: ${head}.`;
}
