import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), ".env.local");
const OUTPUT_PATH = path.resolve(process.cwd(), "data", "catalog.json");
const TARGET_PRODUCT_COUNT = 300;
const MAX_PAGE = 60;
const DETAIL_DELAY_MS = 120;
const RETRY_DELAYS_MS = [500, 1_000];

const EXCLUDED_STORE_KEYWORDS = [
  "брак",
  "востановлен",
  "восстановлен",
  "перемещен",
  "образц",
  "витрин",
  "маркетинг",
] as const;

const SPEC_FIELDS = {
  NOMINALNYY_TOK: "Номинальный ток",
  KOLICHESTVO_POLYUSOV: "Количество полюсов",
  NOMINALNOE_NAPRYAZHENIE: "Номинальное напряжение",
  NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST:
    "Отключающая способность",
  TIP_USTANOVKI: "Тип установки",
} as const;

type JsonObject = Record<string, unknown>;

type CatalogStock = {
  id: string | number;
  name: string;
  quantity: number;
};

type DemoCertificate = {
  id: string;
  title: string;
  url: string;
  demo: true;
};

type CatalogProduct = {
  sku: string;
  name: string;
  rawName: string;
  category: string;
  categoryTitle: string;
  brand: string;
  specs: Record<string, string>;
  price: number;
  stock: CatalogStock[];
  status: "in_stock" | "out_of_stock";
  alternatives: Array<string | number>;
  minOrder: number;
  url: string;
  certificate: DemoCertificate | null;
};

class HttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    const quote = value[0];

    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }

    values[key] = value;
  }

  return values;
}

function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`В .env.local не задан ${key}`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;

  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(displayValue).filter(Boolean).join(", ");
  }
  if (isObject(value)) {
    const nestedValue = value.value ?? value.name ?? value.title;
    return nestedValue === undefined ? "" : displayValue(nestedValue);
  }
  return asString(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url: string, authorization: string): Promise<unknown> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: authorization,
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        throw new HttpError(
          `HTTP ${response.status} ${response.statusText} для ${url}`,
          response.status >= 500,
        );
      }

      return await response.json();
    } catch (error) {
      const retryable = !(error instanceof HttpError) || error.retryable;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw error;

      const retryDelay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `Повтор ${attempt + 1}/${RETRY_DELAYS_MS.length} через ${retryDelay} мс: ${error instanceof Error ? error.message : String(error)}`,
      );
      await delay(retryDelay);
    }
  }

  throw new Error(`Не удалось получить ${url}`);
}

function extractCategory(productUrl: string): string {
  if (!productUrl) return "";

  try {
    const pathname = new URL(productUrl, "https://ekt.kz").pathname;
    const segments = pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    return segments.length >= 2 ? segments.at(-2) ?? "" : "";
  } catch {
    const segments = productUrl.split(/[?#]/, 1)[0].split("/").filter(Boolean);
    return segments.length >= 2 ? segments.at(-2) ?? "" : "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanName(rawName: string, sku: string, article: string): string {
  let name = rawName.replace(/^\s*\*{3}\s*/, "").trim();

  for (const candidate of new Set([sku, article].filter(Boolean))) {
    name = name
      .replace(
        new RegExp(
          `^${escapeRegExp(candidate)}(?:\\s*[-–—:;|/]\\s*|\\s+)`,
          "i",
        ),
        "",
      )
      .trim();
  }

  return name;
}

function isExcludedStore(name: string): boolean {
  const normalized = name.toLocaleLowerCase("ru-RU");
  return EXCLUDED_STORE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function mapStock(value: unknown): CatalogStock[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry, index) => {
    if (!isObject(entry)) return [];

    const name = asString(entry.name);
    if (!name || isExcludedStore(name)) return [];

    return [
      {
        id: asString(entry.id) || index,
        name,
        quantity: asNumber(entry.quantity),
      },
    ];
  });
}

function normalizeAlternatives(value: unknown): Array<string | number> {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\s]+/)
      : isObject(value)
        ? Object.values(value)
        : value === null || value === undefined
          ? []
          : [value];

  const result: Array<string | number> = [];
  for (const candidate of candidates) {
    const raw = isObject(candidate)
      ? candidate.id ?? candidate.value ?? candidate.product_id
      : candidate;
    const text = asString(raw);
    if (!text) continue;

    const normalized = /^\d+$/.test(text) ? Number(text) : text;
    if (!result.some((item) => String(item) === String(normalized))) {
      result.push(normalized);
    }
  }
  return result;
}

function skuHash(sku: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < sku.length; index += 1) {
    hash ^= sku.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function makeCertificate(sku: string): DemoCertificate | null {
  const hash = skuHash(sku);
  if (hash % 3 !== 0) return null;

  const id = `DEMO-${hash.toString(16).toUpperCase().padStart(8, "0")}`;
  const text = encodeURIComponent(
    `Демонстрационный сертификат ${id} для артикула ${sku}. Не является реальным документом.`,
  );

  return {
    id,
    title: "Демонстрационный сертификат соответствия",
    url: `data:text/plain;charset=utf-8,${text}`,
    demo: true,
  };
}

function mapProduct(summary: JsonObject, detail: JsonObject): CatalogProduct | null {
  const product = { ...summary, ...detail };
  const properties = isObject(detail.properties) ? detail.properties : {};
  const sku =
    asString(properties.ARTIKULPOSTAVSHCHIKA) || asString(product.article);
  const rawName = asString(product.name);
  const article = asString(product.article);
  const name = cleanName(rawName, sku, article);
  const url = asString(product.url);
  const category = extractCategory(url);
  const price = asNumber(product.price);

  if (!sku || !name || !category || price <= 0) return null;

  const specs: Record<string, string> = {};
  for (const [sourceKey, label] of Object.entries(SPEC_FIELDS)) {
    const value = displayValue(properties[sourceKey]);
    if (value) specs[label] = value;
  }

  const stock = mapStock(detail.stores);
  const available = stock.reduce((sum, store) => sum + store.quantity, 0);
  const parsedMinOrder = asNumber(properties.KRATNOST_MIN);

  return {
    sku,
    name,
    rawName,
    category,
    categoryTitle: displayValue(properties.OBYEM),
    brand: displayValue(properties.TORGOVAYA_MARKA),
    specs,
    price,
    stock,
    status: available > 0 ? "in_stock" : "out_of_stock",
    alternatives: normalizeAlternatives(properties.RECOMMEND),
    minOrder: parsedMinOrder > 0 ? parsedMinOrder : 1,
    url,
    certificate: makeCertificate(sku),
  };
}

async function main(): Promise<void> {
  const env = parseEnv(await readFile(ENV_PATH, "utf8"));
  const baseUrl = requireEnv(env, "EKT_API_BASE").replace(/\/+$/, "");
  const user = requireEnv(env, "EKT_API_USER");
  const password = requireEnv(env, "EKT_API_PASSWORD");
  const authorization = `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

  const catalog: CatalogProduct[] = [];
  const seenSkus = new Set<string>();
  let skipped = 0;

  for (
    let pageNumber = 1;
    pageNumber <= MAX_PAGE && catalog.length < TARGET_PRODUCT_COUNT;
    pageNumber += 1
  ) {
    const pageUrl = `${baseUrl}/products?page=${pageNumber}`;
    const page = await fetchJson(pageUrl, authorization);
    if (!isObject(page) || !Array.isArray(page.items)) {
      throw new Error(`Страница ${pageNumber}: API не вернул массив items`);
    }
    if (page.items.length === 0) {
      console.log(
        `Страница ${pageNumber}: items пуст, собрано ${catalog.length}, пропущено ${skipped}`,
      );
      break;
    }

    for (const summaryValue of page.items) {
      if (catalog.length >= TARGET_PRODUCT_COUNT) break;
      if (!isObject(summaryValue)) {
        skipped += 1;
        continue;
      }

      const id = asString(summaryValue.id);
      if (!id) {
        skipped += 1;
        continue;
      }

      try {
        const detailValue = await fetchJson(
          `${baseUrl}/products/detail?id=${encodeURIComponent(id)}`,
          authorization,
        );
        if (!isObject(detailValue)) {
          throw new Error("detail не является объектом");
        }

        const product = mapProduct(summaryValue, detailValue);
        if (!product || seenSkus.has(product.sku)) {
          skipped += 1;
        } else {
          seenSkus.add(product.sku);
          catalog.push(product);
        }
      } catch (error) {
        skipped += 1;
        console.warn(
          `Товар id=${id} пропущен: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      await delay(DETAIL_DELAY_MS);
    }

    console.log(
      `Страница ${pageNumber}: собрано ${catalog.length}, пропущено ${skipped}`,
    );
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(
    `Готово: ${catalog.length} товаров записано в ${path.relative(process.cwd(), OUTPUT_PATH)}, пропущено ${skipped}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
