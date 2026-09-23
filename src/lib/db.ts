import { createClient, type Client } from "@libsql/client";
import { CONFIG } from "./config";
import catalog from "../../data/products.json";

/**
 * Весь доступ к БД идёт только отсюда.
 * Диалект — обычный SQLite. Адрес базы меняется одной переменной DB_URL:
 *   локально  file:./.data/hack.db
 *   на Vercel libsql://<db>.turso.io  (+ DB_AUTH_TOKEN)
 * Без Turso на Vercel база уезжает в /tmp и живёт только внутри одного
 * инстанса — для демо это работает, но корзина может потеряться на
 * холодном старте. Флаг ephemeral подсвечивает это в интерфейсе.
 */

export type Product = {
  id: string;
  sku: string;
  title: string;
  category: string;
  brand: string;
  price: number;
  rating: number;
  reviews: number;
  stock: number;
  delivery_days: number;
  return_window_days: number;
  tags: string[];
  specs: Record<string, unknown>;
};

export type CartLine = { product_id: string; title: string; price: number; qty: number; line_total: number };
export type Cart = { lines: CartLine[]; total: number; count: number };

export type OrderItem = { product_id: string; title: string; price: number; qty: number };
export type Order = {
  id: string;
  status: "placed" | "shipped" | "delivered" | "return_requested" | "refunded";
  total: number;
  created_at: string;
  eta_days: number;
  items: OrderItem[];
  return_reason: string | null;
};

const products = catalog as Product[];

let client: Client | null = null;
let ready: Promise<void> | null = null;

function resolveDbUrl(): { url: string; ephemeral: boolean } {
  const raw = CONFIG.db.url;
  if (!raw.startsWith("file:")) return { url: raw, ephemeral: false };
  // На Vercel писать можно только в /tmp, и он свой у каждого инстанса.
  if (process.env.VERCEL) return { url: "file:/tmp/hack.db", ephemeral: true };
  return { url: raw, ephemeral: false };
}

export const DB_INFO = resolveDbUrl();

function getClient(): Client {
  if (!client) {
    client = createClient({ url: DB_INFO.url, authToken: CONFIG.db.authToken });
  }
  return client;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT NOT NULL,
  price INTEGER NOT NULL,
  rating REAL NOT NULL,
  reviews INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL,
  return_window_days INTEGER NOT NULL,
  tags TEXT NOT NULL,
  specs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cart_items (
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (session_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL,
  eta_days INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  return_reason TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
`;

/** Создаёт схему и засеивает каталог. Идемпотентно, вызывается перед любым запросом. */
export function ensureDb(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const db = getClient();
      await db.executeMultiple(SCHEMA);
      const count = await db.execute("SELECT COUNT(*) AS n FROM products");
      if (Number(count.rows[0]?.n ?? 0) !== products.length) {
        await db.execute("DELETE FROM products");
        await db.batch(
          products.map((p) => ({
            sql: `INSERT INTO products (id,sku,title,category,brand,price,rating,reviews,stock,delivery_days,return_window_days,tags,specs)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [
              p.id, p.sku, p.title, p.category, p.brand, p.price, p.rating, p.reviews,
              p.stock, p.delivery_days, p.return_window_days,
              JSON.stringify(p.tags), JSON.stringify(p.specs),
            ],
          })),
          "write",
        );
      }
    })().catch((e) => {
      ready = null; // дать следующему запросу шанс переинициализировать
      throw e;
    });
  }
  return ready;
}

function rowToProduct(r: Record<string, unknown>): Product {
  return {
    id: String(r.id),
    sku: String(r.sku),
    title: String(r.title),
    category: String(r.category),
    brand: String(r.brand),
    price: Number(r.price),
    rating: Number(r.rating),
    reviews: Number(r.reviews),
    stock: Number(r.stock),
    delivery_days: Number(r.delivery_days),
    return_window_days: Number(r.return_window_days),
    tags: JSON.parse(String(r.tags)),
    specs: JSON.parse(String(r.specs)),
  };
}

export type SearchArgs = {
  query?: string;
  category?: string;
  max_price?: number;
  min_rating?: number;
  in_stock_only?: boolean;
  sort_by?: "relevance" | "price_asc" | "price_desc" | "rating";
  limit?: number;
};

const STOPWORDS = new Set([
  "нужен", "нужна", "нужно", "нужны", "хочу", "купить", "куплю", "посоветуй", "подбери",
  "для", "под", "про", "при", "над", "без", "или", "что", "как", "это", "тот", "эту",
  "мне", "меня", "тебе", "себе", "него", "them", "the", "and", "for", "with",
  "дешевле", "дороже", "лучше", "какой", "какие", "есть", "тенге",
]);

/**
 * Грубая нормализация под русский: режем хвост слова, чтобы «ноутбук»,
 * «ноутбука» и «ноутбуки» считались одним токеном. Стеммер сюда не нужен —
 * каталог маленький, а любая внешняя зависимость в день Х это риск.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w))
    .filter((w, i, a) => a.indexOf(w) === i)
    .slice(0, 6);
}

async function runSearchQuery(a: SearchArgs, tokens: string[]): Promise<Product[]> {
  const where: string[] = [];
  const args: unknown[] = [];

  if (a.category) { where.push("LOWER(category) = LOWER(?)"); args.push(a.category); }
  if (a.max_price !== undefined) { where.push("price <= ?"); args.push(a.max_price); }
  if (a.min_rating !== undefined) { where.push("rating >= ?"); args.push(a.min_rating); }
  if (a.in_stock_only) where.push("stock > 0");

  const scoreExpr = tokens.length
    ? tokens.map(() => "(CASE WHEN hay LIKE ? THEN 1 ELSE 0 END)").join(" + ")
    : "0";
  const scoreArgs = tokens.map((t) => `%${t}%`);
  if (tokens.length) where.push("score > 0");

  const order =
    a.sort_by === "price_asc" ? "price ASC"
    : a.sort_by === "price_desc" ? "price DESC"
    : a.sort_by === "rating" ? "rating DESC, reviews DESC"
    : "rating DESC, price ASC";

  const sql = `
    WITH scored AS (
      SELECT p.*, (${scoreExpr}) AS score
      FROM (
        SELECT *, LOWER(title || ' ' || brand || ' ' || category || ' ' || tags) AS hay
        FROM products
      ) AS p
    )
    SELECT * FROM scored
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY score DESC, ${order}
    LIMIT ?`;

  const res = await getClient().execute({
    sql,
    args: [...scoreArgs, ...args, Math.min(a.limit ?? 5, 12)] as never,
  });
  return res.rows.map((r) => rowToProduct(r as unknown as Record<string, unknown>));
}

export async function searchProducts(a: SearchArgs): Promise<Product[]> {
  await ensureDb();

  // Модель часто кладёт в query всю фразу пользователя целиком, поэтому
  // совпадение считаем по отдельным словам и ранжируем по их числу.
  const tokens = a.query ? tokenize(a.query) : [];
  const hit = await runSearchQuery(a, tokens);
  if (hit.length > 0 || tokens.length === 0) return hit;

  // Пустая выдача — самый частый способ сломать демо: фраза вроде
  // «сравни с вариантом подешевле» не содержит ни одного слова из каталога.
  // Тогда отбрасываем текст и оставляем только фильтры.
  return runSearchQuery(a, []);
}

export async function getProduct(id: string): Promise<Product | null> {
  await ensureDb();
  const res = await getClient().execute({ sql: "SELECT * FROM products WHERE id = ? OR sku = ?", args: [id, id] });
  const row = res.rows[0];
  return row ? rowToProduct(row as unknown as Record<string, unknown>) : null;
}

export async function getCart(sessionId: string): Promise<Cart> {
  await ensureDb();
  const res = await getClient().execute({
    sql: `SELECT c.product_id, p.title, p.price, c.qty
          FROM cart_items c JOIN products p ON p.id = c.product_id
          WHERE c.session_id = ? ORDER BY p.title`,
    args: [sessionId],
  });
  const lines: CartLine[] = res.rows.map((r) => {
    const price = Number(r.price);
    const qty = Number(r.qty);
    return { product_id: String(r.product_id), title: String(r.title), price, qty, line_total: price * qty };
  });
  return { lines, total: lines.reduce((s, l) => s + l.line_total, 0), count: lines.reduce((s, l) => s + l.qty, 0) };
}

export async function setCartQty(sessionId: string, productId: string, qty: number): Promise<void> {
  await ensureDb();
  const db = getClient();
  if (qty <= 0) {
    await db.execute({ sql: "DELETE FROM cart_items WHERE session_id = ? AND product_id = ?", args: [sessionId, productId] });
    return;
  }
  await db.execute({
    sql: `INSERT INTO cart_items (session_id, product_id, qty) VALUES (?,?,?)
          ON CONFLICT(session_id, product_id) DO UPDATE SET qty = excluded.qty`,
    args: [sessionId, productId, qty],
  });
}

export async function clearCart(sessionId: string): Promise<void> {
  await ensureDb();
  await getClient().execute({ sql: "DELETE FROM cart_items WHERE session_id = ?", args: [sessionId] });
}

export async function listOrders(sessionId: string): Promise<Order[]> {
  await ensureDb();
  const db = getClient();
  const res = await db.execute({
    sql: "SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC",
    args: [sessionId],
  });
  const orders: Order[] = [];
  for (const r of res.rows) {
    const items = await db.execute({
      sql: "SELECT product_id, title, price, qty FROM order_items WHERE order_id = ?",
      args: [String(r.id)],
    });
    orders.push({
      id: String(r.id),
      status: String(r.status) as Order["status"],
      total: Number(r.total),
      created_at: String(r.created_at),
      eta_days: Number(r.eta_days),
      return_reason: r.return_reason === null ? null : String(r.return_reason),
      items: items.rows.map((i) => ({
        product_id: String(i.product_id),
        title: String(i.title),
        price: Number(i.price),
        qty: Number(i.qty),
      })),
    });
  }
  return orders;
}

export async function getOrder(sessionId: string, orderId: string): Promise<Order | null> {
  const all = await listOrders(sessionId);
  return all.find((o) => o.id.toLowerCase() === orderId.toLowerCase()) ?? null;
}

export async function placeOrder(sessionId: string): Promise<Order> {
  await ensureDb();
  const cart = await getCart(sessionId);
  if (cart.lines.length === 0) throw new Error("EMPTY_CART");

  const db = getClient();
  const etaRes = await db.execute({
    sql: `SELECT MAX(p.delivery_days) AS eta FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.session_id = ?`,
    args: [sessionId],
  });
  const eta = Number(etaRes.rows[0]?.eta ?? 2);
  const id = `ORD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const createdAt = new Date().toISOString();

  await db.batch(
    [
      {
        sql: "INSERT INTO orders (id, session_id, status, total, eta_days, created_at, return_reason) VALUES (?,?,?,?,?,?,NULL)",
        args: [id, sessionId, "placed", cart.total, eta, createdAt],
      },
      ...cart.lines.map((l) => ({
        sql: "INSERT INTO order_items (order_id, product_id, title, price, qty) VALUES (?,?,?,?,?)",
        args: [id, l.product_id, l.title, l.price, l.qty],
      })),
      { sql: "DELETE FROM cart_items WHERE session_id = ?", args: [sessionId] },
    ],
    "write",
  );

  return {
    id, status: "placed", total: cart.total, created_at: createdAt, eta_days: eta,
    return_reason: null,
    items: cart.lines.map((l) => ({ product_id: l.product_id, title: l.title, price: l.price, qty: l.qty })),
  };
}

export async function requestReturn(sessionId: string, orderId: string, reason: string): Promise<Order> {
  await ensureDb();
  const order = await getOrder(sessionId, orderId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.status === "refunded" || order.status === "return_requested") throw new Error("ALREADY_RETURNING");
  await getClient().execute({
    sql: "UPDATE orders SET status = 'return_requested', return_reason = ? WHERE id = ? AND session_id = ?",
    args: [reason, order.id, sessionId],
  });
  return { ...order, status: "return_requested", return_reason: reason };
}

export async function resetSession(sessionId: string): Promise<void> {
  await ensureDb();
  const db = getClient();
  await db.execute({
    sql: "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE session_id = ?)",
    args: [sessionId],
  });
  await db.batch(
    [
      { sql: "DELETE FROM orders WHERE session_id = ?", args: [sessionId] },
      { sql: "DELETE FROM cart_items WHERE session_id = ?", args: [sessionId] },
    ],
    "write",
  );
}
