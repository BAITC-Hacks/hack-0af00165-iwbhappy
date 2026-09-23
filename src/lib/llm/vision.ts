import OpenAI from "openai";
import { CONFIG, hasLiveKey } from "../config";
import { log } from "../logger";

/**
 * Чтение вложений моделью — раздел 5 ТЗ («вход: фото и файлы Excel,
 * Word, PDF, JPEG — фото товара, спецификация, накладная»).
 *
 * Принципиально отдельные одноразовые вызовы, а не часть агентного цикла:
 * вложение никогда не попадает в поток сообщений модели, и стриминг с
 * ретраями в llm/client.ts остаётся нетронутым.
 *
 * Сравнения изображений здесь нет и не будет. В каталоге электротехника,
 * где все модульные автоматы выглядят одинаково, — визуальное сходство
 * почти не несёт сигнала. Зато на фото почти всегда виден текст: артикул,
 * бренд, номинал. Модель читает его и отдаёт короткий JSON, а дальше
 * работает обычный поиск по каталогу.
 *
 * Фото бывает двух видов: изделие или документ (спецификация, накладная,
 * счёт). Документ превращается в строки «артикул — количество» и идёт
 * тем же путём, что Excel: сопоставление с каталогом, одно предложение,
 * обязательное подтверждение. PDF читается так же.
 */

export type ExtractedRow = { article: string; qty: number };

export type VisionExtract = {
  /** Что на фото: изделие или документ со списком позиций. */
  docType: "product" | "document";
  /** Артикул, если он читается на фото. */
  sku: string | null;
  brand: string | null;
  /** Тип изделия словами: «автоматический выключатель», «УЗО», «кабель». */
  kind: string | null;
  /** Характеристики, различимые на фото: «16А», «1P», «230В». */
  specs: string[];
  /** Строка для поиска по каталогу — то, что уйдёт в search_catalog. */
  query: string;
  /** Строки документа, если на фото спецификация или накладная. */
  rows: ExtractedRow[];
  ok: boolean;
  note: string | null;
};

const EMPTY: VisionExtract = {
  docType: "product", sku: null, brand: null, kind: null, specs: [], query: "", rows: [], ok: false,
  note: "Не удалось разобрать фото.",
};

const MAX_ROWS = 100;

const ROWS_RULES = `Для документа (спецификация, накладная, счёт, заявка — список позиций):
- в rows перечисли ВСЕ позиции по порядку: {"article": "артикул или код товара", "qty": количество числом};
- артикул переписывай посимвольно, как напечатан: латиница, цифры, дефисы. Не исправляй и не дополняй;
- если у строки нет артикула — бери наименование целиком;
- строки «Итого», «Всего», «НДС», подписи и реквизиты не включай;
- количество не читается — ставь 1.`;

const IMAGE_PROMPT = `На фото — электротехническое изделие, его упаковка ИЛИ документ со списком товаров.

Верни СТРОГО JSON:
{"type": "product" или "document", "sku": "артикул или null", "brand": "производитель или null", "kind": "тип изделия словами или null", "specs": ["16А", "1P"], "query": "строка для поиска", "rows": []}

Для изделия (type "product"):
- переписывай надписи буквально, ничего не додумывай. Не видно — ставь null;
- в specs клади только то, что реально читается на фото;
- в query собери 3-6 слов для поиска: тип изделия, бренд, номинал;
- rows оставь пустым.

${ROWS_RULES}
Для документа поля sku, brand, kind — null, specs — пустой.

Никакого текста вокруг JSON.`;

const PDF_PROMPT = `Это документ: спецификация, накладная, счёт или заявка на электротехнику.

Верни СТРОГО JSON: {"rows": [{"article": "...", "qty": 1}]}

${ROWS_RULES}

Если списка позиций в документе нет — верни {"rows": []}. Никакого текста вокруг JSON.`;

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

function toRows(raw: unknown): ExtractedRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const article = String(o.article ?? "").trim();
      const n = Number(String(o.qty ?? "1").replace(",", "."));
      return { article, qty: Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 999) : 1 };
    })
    .filter((r) => r.article.length > 0 && r.article.length <= 80)
    .slice(0, MAX_ROWS);
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
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_PROMPT },
            // Документ с мелким шрифтом на низком разрешении не читается.
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    });

    const raw = res.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rows = toRows(parsed.rows);
    const docType: VisionExtract["docType"] = parsed.type === "document" || rows.length > 1 ? "document" : "product";

    const specs = Array.isArray(parsed.specs) ? parsed.specs.map(String).slice(0, 6) : [];
    const query = [parsed.kind, parsed.brand, ...specs].filter(Boolean).join(" ").trim()
      || String(parsed.query ?? "").trim();

    log({
      kind: "llm", event: "vision.ok", traceId, ms: Date.now() - t0,
      detail: { docType, sku: parsed.sku ?? null, specs: specs.length, rows: rows.length },
    });

    if (docType === "document") {
      if (!rows.length) {
        return { ...EMPTY, docType, note: "На фото документ, но строк с артикулами в нём не разобрать. Пришлите файл или фото чётче." };
      }
      return { ...EMPTY, docType, rows, ok: true, note: null };
    }

    const sku = parsed.sku ? String(parsed.sku).trim() : null;
    if (!sku && !query) {
      return { ...EMPTY, note: "На фото не удалось разобрать ни артикул, ни характеристики. Напишите артикул текстом." };
    }

    return {
      docType,
      sku,
      brand: parsed.brand ? String(parsed.brand).trim() : null,
      kind: parsed.kind ? String(parsed.kind).trim() : null,
      specs,
      query,
      rows: [],
      ok: true,
      note: null,
    };
  } catch (e) {
    const message = (e as Error).message;
    log({ kind: "error", event: "vision.fail", traceId, ms: Date.now() - t0, detail: { message } });
    return { ...EMPTY, note: `Не удалось разобрать фото: ${message}` };
  }
}

/** Строки спецификации из PDF. Текст PDF читает модель: разбирать его своим кодом — отдельный проект. */
export async function extractRowsFromPdf(
  traceId: string, fileName: string, buf: Buffer,
): Promise<{ ok: boolean; rows: ExtractedRow[]; note: string | null }> {
  if (!hasLiveKey()) {
    return { ok: false, rows: [], note: "Чтение PDF требует ключа к модели. Сейчас он не задан — пришлите спецификацию в Excel или Word." };
  }
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, rows: [], note: "Файл не похож на PDF." };
  }

  const t0 = Date.now();
  try {
    const res = await client().chat.completions.create({
      model: CONFIG.llm.model,
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PDF_PROMPT },
            { type: "file", file: { filename: fileName, file_data: `data:application/pdf;base64,${buf.toString("base64")}` } },
          ],
        },
      ],
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
    const rows = toRows(parsed.rows);
    log({ kind: "llm", event: "pdf.ok", traceId, ms: Date.now() - t0, detail: { rows: rows.length } });
    return rows.length
      ? { ok: true, rows, note: null }
      : { ok: false, rows: [], note: "В PDF не нашлось списка позиций с артикулами." };
  } catch (e) {
    const message = (e as Error).message;
    log({ kind: "error", event: "pdf.fail", traceId, ms: Date.now() - t0, detail: { message } });
    return { ok: false, rows: [], note: `Не удалось прочитать PDF: ${message}` };
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
