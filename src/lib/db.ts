import { createClient, type Client } from "@libsql/client";
import { CONFIG } from "./config";
import rawCatalog from "../../data/catalog.json";
import rawTerms from "../../data/terms.json";

/**
 * Весь доступ к БД — только отсюда (раздел 0 AGENTS.md).
 * Диалект обычный SQLite, адрес базы меняется переменной DB_URL.
 */

export type Store = { id: number; name: string; qty: number };
export type Certificate = { title: string; url: string; demo: boolean };

export type Product = {
  id: number | null;
  sku: string;
  name: string;
  rawName?: string;
  category: string;
  categoryTitle: string;
  brand: string;
  specs: Record<string, string>;
  price: number;
  stock: Store[];
  available: number;
  status: "in_stock" | "out_of_stock";
  alternatives: string[];
  minOrder: number;
  url: string;
  certificate?: Certificate | null;
  description?: string;
};

export type CartLine = { sku: string; name: string; price: number; qty: number; lineTotal: number };
export type Cart = { lines: CartLine[]; total: number; count: number };

export type ProposalItem = { sku: string; qty: number };

export type Proposal = {
  id: string;
  sessionId: string;
  /** Одна позиция для обычного добавления, несколько — для спецификации. */
  items: ProposalItem[];
  status: "pending" | "used" | "cancelled";
  createdAt: string;
};

export type Alternative = Product & { reason: string };

// --------------------------------------------------------------------------
// Клиент
// --------------------------------------------------------------------------

let client: Client | null = null;
let ready: Promise<void> | null = null;

function resolveDbUrl(): { url: string; ephemeral: boolean } {
  const raw = CONFIG.db.url;
  if (!raw.startsWith("file:")) return { url: raw, ephemeral: false };
  if (process.env.VERCEL) return { url: "file:/tmp/hack.db", ephemeral: true };
  return { url: raw, ephemeral: false };
}

export const DB_INFO = resolveDbUrl();

function db(): Client {
  if (!client) client = createClient({ url: DB_INFO.url, authToken: CONFIG.db.authToken });
  return client;
}

const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  -- Ключ — артикул, а не id. Поле id в выгрузке может отсутствовать, и тогда
  -- INTEGER PRIMARY KEY схлопывает весь каталог в одну строку: все товары
  -- получают ключ 0 и затирают друг друга. Артикул уникален по построению.
  sku TEXT PRIMARY KEY,
  id INTEGER,
  name TEXT NOT NULL,
  raw_name TEXT,
  category TEXT NOT NULL,
  category_title TEXT,
  brand TEXT,
  specs TEXT NOT NULL,
  price INTEGER NOT NULL,
  stock TEXT NOT NULL,
  available INTEGER NOT NULL,
  status TEXT NOT NULL,
  alternatives TEXT NOT NULL,
  min_order INTEGER NOT NULL DEFAULT 1,
  url TEXT,
  certificate TEXT,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_id ON products(id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

CREATE TABLE IF NOT EXISTS cart_items (
  session_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (session_id, sku)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  -- JSON-массив позиций. Одна запись и для обычного добавления, и для
  -- спецификации: путь подтверждения должен остаться единственным.
  items TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
`;

// --------------------------------------------------------------------------
// Засев
// --------------------------------------------------------------------------

/**
 * Строки каталога проверяем поштучно и битые пропускаем.
 * Выгрузку делает отдельный скрипт, и он может отработать частично —
 * приложение из-за этого падать не должно, оно должно честно показать,
 * сколько позиций доехало.
 */
function normalize(row: unknown): Product | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const sku = typeof r.sku === "string" ? r.sku.trim() : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const price = Number(r.price);
  if (!sku || !name || !Number.isFinite(price) || price <= 0) return null;

  const stock: Store[] = Array.isArray(r.stock)
    ? (r.stock as Record<string, unknown>[]).flatMap((s) => {
        const qty = Number(s?.qty ?? s?.quantity);
        const storeName = typeof s?.name === "string" ? s.name : "";
        if (!storeName || !Number.isFinite(qty)) return [];
        return [{ id: Number(s?.id ?? 0), name: storeName, qty }];
      })
    : [];

  // Доступный остаток считаем сами: полю available из файла доверяем,
  // только если оно сходится с суммой по складам (раздел 12.1).
  const summed = stock.reduce((s, x) => s + Math.max(0, x.qty), 0);
  const declared = Number(r.available);
  const available = Number.isFinite(declared) && declared === summed ? declared : summed;

  const cert = r.certificate as Record<string, unknown> | null | undefined;

  return {
    id: Number.isFinite(Number(r.id)) ? Number(r.id) : null,
    sku,
    name,
    rawName: typeof r.rawName === "string" ? r.rawName : undefined,
    category: typeof r.category === "string" && r.category ? r.category : "прочее",
    categoryTitle: typeof r.categoryTitle === "string" ? r.categoryTitle : "",
    brand: typeof r.brand === "string" ? r.brand : "",
    specs: r.specs && typeof r.specs === "object" ? (r.specs as Record<string, string>) : {},
    price: Math.round(price),
    stock,
    available,
    status: available > 0 ? "in_stock" : "out_of_stock",
    alternatives: Array.isArray(r.alternatives) ? r.alternatives.map(String) : [],
    minOrder: Math.max(1, Number(r.minOrder) || 1),
    url: typeof r.url === "string" ? r.url : "",
    certificate: cert && typeof cert.title === "string"
      ? { title: String(cert.title), url: String(cert.url ?? ""), demo: cert.demo !== false }
      : null,
    description: typeof r.description === "string" ? r.description : undefined,
  };
}

const catalog: Product[] = (Array.isArray(rawCatalog) ? rawCatalog : [])
  .map(normalize)
  .filter((p): p is Product => p !== null);

export const CATALOG_SIZE = catalog.length;

export function ensureDb(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const c = db();

      // Схема за день хакатона меняется не раз, а файл базы переживает
      // перезапуск. Без этой проверки приложение падает на INSERT в таблицу
      // старой формы, и ошибка выглядит как поломка кода, а не как мусор в .data.
      await c.executeMultiple(SCHEMA);
      const ver = await c.execute("PRAGMA user_version");
      if (Number(ver.rows[0]?.user_version ?? 0) !== SCHEMA_VERSION) {
        await c.executeMultiple(
          "DROP TABLE IF EXISTS products; DROP TABLE IF EXISTS cart_items; DROP TABLE IF EXISTS proposals;",
        );
        await c.executeMultiple(SCHEMA);
        await c.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }

      const n = await c.execute("SELECT COUNT(*) AS n FROM products");
      if (Number(n.rows[0]?.n ?? 0) !== catalog.length) {
        await c.execute("DELETE FROM products");
        for (let i = 0; i < catalog.length; i += 100) {
          await c.batch(
            catalog.slice(i, i + 100).map((p) => ({
              sql: `INSERT OR REPLACE INTO products
                    (sku,id,name,raw_name,category,category_title,brand,specs,price,stock,available,status,alternatives,min_order,url,certificate,description)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              args: [
                p.sku, p.id ?? null, p.name, p.rawName ?? null, p.category, p.categoryTitle, p.brand,
                JSON.stringify(p.specs), p.price, JSON.stringify(p.stock), p.available, p.status,
                JSON.stringify(p.alternatives), p.minOrder, p.url,
                p.certificate ? JSON.stringify(p.certificate) : null,
                p.description ?? null,
              ],
            })),
            "write",
          );
        }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function toProduct(r: Record<string, unknown>): Product {
  return {
    id: r.id === null || r.id === undefined ? null : Number(r.id),
    sku: String(r.sku),
    name: String(r.name),
    rawName: r.raw_name ? String(r.raw_name) : undefined,
    category: String(r.category),
    categoryTitle: String(r.category_title ?? ""),
    brand: String(r.brand ?? ""),
    specs: JSON.parse(String(r.specs || "{}")),
    price: Number(r.price),
    stock: JSON.parse(String(r.stock || "[]")),
    available: Number(r.available),
    status: String(r.status) as Product["status"],
    alternatives: JSON.parse(String(r.alternatives || "[]")),
    minOrder: Number(r.min_order ?? 1),
    url: String(r.url ?? ""),
    certificate: r.certificate ? JSON.parse(String(r.certificate)) : null,
    description: r.description ? String(r.description) : undefined,
  };
}

// --------------------------------------------------------------------------
// Каталог
// --------------------------------------------------------------------------

const STOPWORDS = new Set([
  "нужен", "нужна", "нужно", "хочу", "купить", "есть", "ли", "для", "под", "про",
  "или", "что", "как", "это", "мне", "the", "and", "for", "with", "штук", "шт",
]);

/** Грубая нормализация под русский: режем хвост слова до 5 символов. */
function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w))
    .filter((w, i, a) => a.indexOf(w) === i)
    .slice(0, 6);
}

async function query(sqlTail: string, tokens: string[], extra: unknown[], limit: number): Promise<Product[]> {
  const score = tokens.length
    ? tokens.map(() => "(CASE WHEN hay LIKE ? THEN 1 ELSE 0 END)").join(" + ")
    : "0";
  const sql = `
    WITH scored AS (
      SELECT p.*, (${score}) AS score FROM (
        SELECT *, LOWER(sku || ' ' || name || ' ' || category || ' ' || COALESCE(category_title,'') || ' ' || COALESCE(brand,'') || ' ' || specs) AS hay
        FROM products
      ) AS p
    )
    SELECT * FROM scored ${sqlTail}
    ORDER BY score DESC, available > 0 DESC, price ASC
    LIMIT ?`;
  const res = await db().execute({
    sql,
    args: [...tokens.map((t) => `%${t}%`), ...extra, limit] as never,
  });
  return res.rows.map((r) => toProduct(r as unknown as Record<string, unknown>));
}

/**
 * Поиск по каталогу.
 *
 * Лимит по умолчанию 5 — столько инструмент search_catalog отдаёт модели
 * по разделу 5, и этот контракт не меняется. Параметр нужен витрине:
 * сетке товаров на странице требуется два десятка карточек, и незачем
 * ради этого заводить второй почти такой же запрос.
 */
export async function searchCatalog(q: string, category?: string, limit = 5): Promise<Product[]> {
  await ensureDb();
  const take = Math.min(Math.max(1, Math.trunc(limit)), 48);
  const tokens = tokenize(q || "");
  const where: string[] = [];
  const extra: unknown[] = [];
  if (category) { where.push("LOWER(category) LIKE ?"); extra.push(`%${category.toLowerCase()}%`); }
  if (tokens.length) where.push("score > 0");

  const tail = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const hit = await query(tail, tokens, extra, take);
  if (hit.length > 0 || tokens.length === 0) return hit;

  // Пустая выдача — снимаем текстовое условие, фильтры оставляем.
  const tail2 = category ? "WHERE LOWER(category) LIKE ?" : "";
  return query(tail2, [], category ? [`%${category.toLowerCase()}%`] : [], take);
}

export async function getProduct(sku: string): Promise<Product | null> {
  await ensureDb();
  const res = await db().execute({
    sql: "SELECT * FROM products WHERE LOWER(sku) = LOWER(?) OR CAST(id AS TEXT) = ? LIMIT 1",
    args: [sku.trim(), sku.trim()],
  });
  const row = res.rows[0];
  return row ? toProduct(row as unknown as Record<string, unknown>) : null;
}

const SPEC_LABELS: Record<string, string> = {
  NOMINALNYY_TOK: "Номинальный ток",
  KOLICHESTVO_POLYUSOV: "Количество полюсов",
  NOMINALNOE_NAPRYAZHENIE: "Номинальное напряжение",
  NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: "Отключающая способность",
  TIP_USTANOVKI: "Тип установки",
};

export function labelSpec(key: string): string {
  return SPEC_LABELS[key] ?? key;
}

/**
 * Объяснение подбора аналога. Объяснимость рекомендаций — отдельное
 * требование кейса, поэтому reason собирается из фактов, а не из общих слов.
 */
type Basis = "partner" | "category" | "type" | "brand" | "price";

const BASIS_TEXT: Record<Basis, string> = {
  partner: "партнёр рекомендует его к этому товару, и он из того же раздела каталога",
  category: "тот же раздел каталога",
  type: "тот же тип изделия",
  brand: "тот же производитель",
  price: "ближайшая по цене позиция в наличии",
};

/**
 * Объяснение подбора. Объяснимость рекомендаций — отдельное требование
 * кейса, поэтому reason собирается из фактов и честно называет основание:
 * если аналог подобран просто по близкой цене, так и говорим, а не
 * выдаём это за техническое соответствие.
 */
function explain(base: Product, alt: Product, basis: Basis): string {
  const parts: string[] = [BASIS_TEXT[basis]];

  const common = Object.keys(base.specs).filter((k) => alt.specs[k]);
  const same = common.filter((k) => alt.specs[k] === base.specs[k]);
  const diff = common.filter((k) => alt.specs[k] !== base.specs[k]);

  if (same.length) {
    parts.push(`совпадают ${same.slice(0, 3).map((k) => `${labelSpec(k)} (${alt.specs[k]})`).join(", ")}`);
  }

  // Расхождения называем вслух. Для автоматического выключателя подмена
  // номинального тока — не деталь, а другой товар: предложить вместо 20 А
  // десятиамперный и промолчать значит выдать недостоверную рекомендацию.
  if (diff.length) {
    parts.push(
      `отличается ${diff.slice(0, 2).map((k) => `${labelSpec(k)}: ${base.specs[k]} → ${alt.specs[k]}`).join(", ")}`,
    );
  }

  if (base.price > 0) {
    const d = Math.round(((alt.price - base.price) / base.price) * 100);
    if (Math.abs(d) <= 3) parts.push("цена практически та же");
    else parts.push(d > 0 ? `дороже на ${d}%` : `дешевле на ${Math.abs(d)}%`);
  }

  parts.push(`в наличии ${alt.available} шт.`);
  return parts.join("; ");
}

/**
 * Аналоги подбираются ступенями: сначала то, что партнёр сам пометил
 * рекомендуемым, затем раздел, тип изделия, производитель и в последнюю
 * очередь просто ближайшая по цене позиция в наличии.
 *
 * Ступени нужны не для красоты: второй приёмочный тест обязателен, а в
 * срезе каталога легко попадается позиция, у которой в её разделе вообще
 * нет ничего в наличии. Вернуть пустой список означает провалить проверку.
 */
/**
 * Сопутствующие товары — то, что партнёр рекомендует к позиции
 * (properties.RECOMMEND). Только в наличии. Обоснование честное: связь
 * задана в каталоге ekt.kz, а не придумана нами.
 */
export async function findRelated(sku: string, limit = 3): Promise<{ base: Product | null; items: Alternative[] }> {
  await ensureDb();
  const base = await getProduct(sku);
  if (!base) return { base: null, items: [] };

  const items: Alternative[] = [];
  const seen = new Set<string>([base.sku]);
  for (const ref of base.alternatives) {
    if (items.length >= limit) break;
    const p = await getProduct(ref);
    if (!p || seen.has(p.sku) || p.available <= 0) continue;
    seen.add(p.sku);
    items.push({
      ...p,
      reason: `в каталоге ekt.kz рекомендуется вместе с «${base.name}»${p.categoryTitle ? `; это ${p.categoryTitle.toLowerCase()}` : ""}`,
    });
  }
  return { base, items };
}

export async function findAlternatives(sku: string, limit = 3): Promise<{ base: Product | null; items: Alternative[] }> {
  await ensureDb();
  const base = await getProduct(sku);
  if (!base) return { base: null, items: [] };

  const picked: Alternative[] = [];
  const seen = new Set<string>([base.sku]);

  const add = (p: Product, basis: Basis) => {
    if (picked.length >= limit || seen.has(p.sku) || p.available <= 0) return;
    seen.add(p.sku);
    picked.push({ ...p, reason: explain(base, p, basis) });
  };

  // Ступень 1 — рекомендации партнёра, но ТОЛЬКО из того же раздела.
  // RECOMMEND в данных ekt.kz — это сопутствующие товары, а не замены:
  // все связи в выгрузке ведут из автоматов и УЗО на клеммы WAGO. Без
  // этой проверки клемма шла первым «аналогом» автомата. Сопутствующие
  // отдаёт findRelated.
  for (const ref of base.alternatives) {
    if (picked.length >= limit) break;
    const cand = await getProduct(ref);
    if (cand && cand.category === base.category) add(cand, "partner");
  }

  const tiers: Array<{ basis: Basis; sql: string; args: unknown[] }> = [
    {
      basis: "category",
      sql: "SELECT * FROM products WHERE category = ? AND available > 0 AND sku <> ? ORDER BY ABS(price - ?) LIMIT ?",
      args: [base.category, base.sku, base.price],
    },
    {
      basis: "type",
      sql: "SELECT * FROM products WHERE category_title <> '' AND category_title = ? AND available > 0 AND sku <> ? ORDER BY ABS(price - ?) LIMIT ?",
      args: [base.categoryTitle, base.sku, base.price],
    },
    {
      basis: "brand",
      sql: "SELECT * FROM products WHERE brand <> '' AND brand = ? AND available > 0 AND sku <> ? ORDER BY ABS(price - ?) LIMIT ?",
      args: [base.brand, base.sku, base.price],
    },
    {
      basis: "price",
      sql: "SELECT * FROM products WHERE available > 0 AND sku <> ? AND price BETWEEN ? AND ? ORDER BY ABS(price - ?) LIMIT ?",
      args: [base.sku, Math.floor(base.price * 0.5), Math.ceil(base.price * 1.5), base.price],
    },
  ];

  for (const tier of tiers) {
    if (picked.length >= limit) break;
    const res = await db().execute({ sql: tier.sql, args: [...tier.args, limit * 3] as never });
    for (const row of res.rows) {
      add(toProduct(row as unknown as Record<string, unknown>), tier.basis);
    }
  }

  return { base, items: picked };
}

// --------------------------------------------------------------------------
// Условия покупки
// --------------------------------------------------------------------------

export type Term = { topic: string; title: string; text: string; details?: string[] };

const TERM_TITLES: Record<string, string> = {
  payment: "Оплата",
  delivery: "Доставка",
  min_order: "Минимальная партия",
  pickup: "Самовывоз",
  warranty: "Гарантия и сертификаты",
  returns: "Возврат и обмен",
  contacts: "Связаться с менеджером",
};

/**
 * terms.json пишет отдельный скрипт, и его форма может быть как плоской
 * (`"payment": "текст"`), так и развёрнутой (`{title, text, details}`).
 * Читаем обе: падать из-за формата файла с условиями — глупая причина
 * провалить третий приёмочный тест.
 */
export function getTerms(topic: string): Term[] {
  const src = (rawTerms ?? {}) as Record<string, unknown>;

  const all: Term[] = Object.entries(src)
    .filter(([k, v]) => !k.startsWith("_") && v != null)
    .map(([k, v]) => {
      if (typeof v === "string") {
        return { topic: k, title: TERM_TITLES[k] ?? k, text: v };
      }
      const o = v as Record<string, unknown>;
      return {
        topic: k,
        title: typeof o.title === "string" ? o.title : (TERM_TITLES[k] ?? k),
        text: typeof o.text === "string" ? o.text : JSON.stringify(v),
        details: Array.isArray(o.details) ? o.details.map(String) : undefined,
      };
    });

  if (topic && topic !== "all") {
    const hit = all.find((t) => t.topic === topic);
    if (hit) return [hit];
  }
  return all;
}

// --------------------------------------------------------------------------
// Корзина
// --------------------------------------------------------------------------

export async function getCart(sessionId: string): Promise<Cart> {
  await ensureDb();
  const res = await db().execute({
    sql: `SELECT c.sku, p.name, p.price, c.qty
          FROM cart_items c JOIN products p ON p.sku = c.sku
          WHERE c.session_id = ? ORDER BY p.name`,
    args: [sessionId],
  });
  const lines: CartLine[] = res.rows.map((r) => {
    const price = Number(r.price);
    const qty = Number(r.qty);
    return { sku: String(r.sku), name: String(r.name), price, qty, lineTotal: price * qty };
  });
  return { lines, total: lines.reduce((s, l) => s + l.lineTotal, 0), count: lines.reduce((s, l) => s + l.qty, 0) };
}

// --------------------------------------------------------------------------
// Предложения — инвариант раздела 6
// --------------------------------------------------------------------------

export async function createProposal(sessionId: string, items: ProposalItem[]): Promise<Proposal> {
  await ensureDb();
  const clean = items
    .map((i) => ({ sku: String(i.sku).trim(), qty: Math.max(1, Math.trunc(Number(i.qty) || 1)) }))
    .filter((i) => i.sku);
  if (clean.length === 0) throw new Error("EMPTY_PROPOSAL");

  const id = `prp_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const createdAt = new Date().toISOString();
  await db().execute({
    sql: "INSERT INTO proposals (id, session_id, items, status, created_at) VALUES (?,?,?,'pending',?)",
    args: [id, sessionId, JSON.stringify(clean), createdAt],
  });
  return { id, sessionId, items: clean, status: "pending", createdAt };
}

export async function getProposal(sessionId: string, id: string): Promise<Proposal | null> {
  await ensureDb();
  const res = await db().execute({
    sql: "SELECT * FROM proposals WHERE id = ? AND session_id = ?",
    args: [id, sessionId],
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    items: JSON.parse(String(r.items || "[]")),
    status: String(r.status) as Proposal["status"],
    createdAt: String(r.created_at),
  };
}

export type ConsumedLine = {
  sku: string;
  name: string;
  requested: number;
  added: number;
  capped: boolean;
  available: number;
  error?: "PRODUCT_GONE" | "NO_STOCK";
};

export type ConsumeResult =
  | { ok: true; cart: Cart; lines: ConsumedLine[]; addedTotal: number }
  | { ok: false; error: "NOT_FOUND" | "ALREADY_USED" | "NO_STOCK" | "PRODUCT_GONE"; lines?: ConsumedLine[] };

/**
 * Единственное место, где меняется корзина.
 *
 * Перевод pending -> used делается условным UPDATE: если строка не
 * обновилась, значит предложение уже использовано или чужое. Одноразовость
 * обеспечивает сама база, а не проверка в коде, которую можно обойти
 * гонкой двух запросов.
 *
 * Спецификация из файла проходит ровно здесь же. Второго пути добавления
 * в корзину в приложении нет и быть не должно.
 */
export async function consumeProposal(sessionId: string, proposalId: string): Promise<ConsumeResult> {
  await ensureDb();
  const c = db();

  const claim = await c.execute({
    sql: "UPDATE proposals SET status = 'used' WHERE id = ? AND session_id = ? AND status = 'pending'",
    args: [proposalId, sessionId],
  });
  if (Number(claim.rowsAffected ?? 0) === 0) {
    const existing = await getProposal(sessionId, proposalId);
    return { ok: false, error: existing ? "ALREADY_USED" : "NOT_FOUND" };
  }

  const proposal = await getProposal(sessionId, proposalId);
  if (!proposal) return { ok: false, error: "NOT_FOUND" };

  const lines: ConsumedLine[] = [];
  let addedTotal = 0;

  for (const item of proposal.items) {
    const product = await getProduct(item.sku);
    if (!product) {
      lines.push({ sku: item.sku, name: item.sku, requested: item.qty, added: 0, capped: false, available: 0, error: "PRODUCT_GONE" });
      continue;
    }
    if (product.available <= 0) {
      lines.push({ sku: product.sku, name: product.name, requested: item.qty, added: 0, capped: false, available: 0, error: "NO_STOCK" });
      continue;
    }

    const cart = await getCart(sessionId);
    const already = cart.lines.find((l) => l.sku === product.sku)?.qty ?? 0;

    // Количество не может превысить остаток (раздел 6, пункт 5).
    const wanted = already + item.qty;
    const finalQty = Math.min(wanted, product.available);

    await c.execute({
      sql: `INSERT INTO cart_items (session_id, sku, qty) VALUES (?,?,?)
            ON CONFLICT(session_id, sku) DO UPDATE SET qty = excluded.qty`,
      args: [sessionId, product.sku, finalQty],
    });

    const added = finalQty - already;
    addedTotal += added;
    lines.push({
      sku: product.sku, name: product.name, requested: item.qty,
      added, capped: finalQty < wanted, available: product.available,
    });
  }

  if (addedTotal === 0) {
    const gone = lines.every((l) => l.error === "PRODUCT_GONE");
    return { ok: false, error: gone ? "PRODUCT_GONE" : "NO_STOCK", lines };
  }

  return { ok: true, cart: await getCart(sessionId), lines, addedTotal };
}

export type SpecRow = { article: string; qty: number };
export type MatchedSpec = {
  matched: Array<{ sku: string; name: string; price: number; qty: number; available: number; status: Product["status"] }>;
  unmatched: SpecRow[];
};

/**
 * Сводит строки спецификации с каталогом.
 *
 * Артикул в файле у закупщика редко совпадает с нашим символ в символ:
 * лишние пробелы, другой регистр, хвостовой знак. Поэтому сначала точное
 * совпадение, затем нормализованное, и только потом позиция считается
 * нераспознанной — врать про «нашли» нельзя, но и терять строку из-за
 * пробела глупо.
 */
export async function matchSpecRows(rows: SpecRow[]): Promise<MatchedSpec> {
  await ensureDb();
  const norm = (v: string) => v.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");

  const matched: MatchedSpec["matched"] = [];
  const unmatched: SpecRow[] = [];

  for (const row of rows) {
    const article = String(row.article ?? "").trim();
    const qty = Math.max(1, Math.trunc(Number(row.qty) || 1));
    if (!article) continue;

    let product = await getProduct(article);

    if (!product) {
      const res = await db().execute({
        sql: `SELECT * FROM products
              WHERE REPLACE(REPLACE(REPLACE(LOWER(sku),' ',''),'-',''),'_','') = ?
              LIMIT 1`,
        args: [norm(article)],
      });
      const r = res.rows[0];
      if (r) product = toProduct(r as unknown as Record<string, unknown>);
    }

    if (!product) {
      unmatched.push({ article, qty });
      continue;
    }

    const existing = matched.find((m) => m.sku === product.sku);
    if (existing) existing.qty += qty;
    else matched.push({
      sku: product.sku, name: product.name, price: product.price,
      qty, available: product.available, status: product.status,
    });
  }

  return { matched, unmatched };
}

/**
 * Артикулы для демо-кнопок берём из реального каталога, а не хардкодим:
 * захардкоженный артикул протухнет при следующей выгрузке ровно в день защиты.
 * inStock — с запасом больше 2 шт., чтобы отработал сценарий «добавь 2 штуки».
 * outOfStock — обязательно с непустым alternatives, иначе тест 2 нечем показывать.
 */
export async function pickDemoSkus(): Promise<{ inStock: string; outOfStock: string }> {
  await ensureDb();
  const c = db();
  // Характеристики обязательны: первый приёмочный тест требует показать
  // технические характеристики, а они заполнены примерно у половины каталога.
  const a = await c.execute(
    `SELECT sku FROM products
     WHERE available >= 3 AND certificate IS NOT NULL AND specs <> '{}'
     ORDER BY LENGTH(specs) DESC LIMIT 1`,
  );
  const aFallback = a.rows.length
    ? a
    : await c.execute("SELECT sku FROM products WHERE available > 0 ORDER BY available DESC LIMIT 1");

  const b = await c.execute(
    `SELECT sku FROM products
     WHERE available = 0 AND specs <> '{}'
     ORDER BY LENGTH(specs) DESC LIMIT 1`,
  );
  const bFallback = b.rows.length
    ? b
    : await c.execute("SELECT sku FROM products WHERE available = 0 LIMIT 1");

  return {
    inStock: String(aFallback.rows[0]?.sku ?? ""),
    outOfStock: String(bFallback.rows[0]?.sku ?? ""),
  };
}

export async function resetSession(sessionId: string): Promise<void> {
  await ensureDb();
  await db().batch(
    [
      { sql: "DELETE FROM cart_items WHERE session_id = ?", args: [sessionId] },
      { sql: "DELETE FROM proposals WHERE session_id = ?", args: [sessionId] },
    ],
    "write",
  );
}
