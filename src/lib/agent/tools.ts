import { z } from "zod";
import {
  clearCart, getCart, getProduct, listOrders, placeOrder,
  requestReturn, searchProducts, setCartQty, type Product,
} from "../db";
import type { ToolSpec } from "../llm/types";

/**
 * Ровно три инструмента. Больше на пятичасовом хакатоне не нужно:
 * каждый лишний инструмент — это лишний способ для модели ошибиться
 * и лишняя ветка, которую придётся чинить в последний час.
 *
 *   search_catalog  — подбор и сравнение
 *   update_cart     — корзина
 *   manage_order    — оформление, статус, возврат
 *
 * Схема каждого описана дважды: JSON Schema уходит в модель,
 * zod-схема валидирует то, что модель прислала обратно.
 */

export type ToolContext = { sessionId: string };
export type ToolResult = { ok: boolean; data: Record<string, unknown>; summary: string };

// --------------------------------------------------------------------------
// 1. search_catalog
// --------------------------------------------------------------------------

const SearchArgs = z.object({
  query: z.string().max(120).optional(),
  category: z.enum(["ноутбуки", "наушники", "смартфоны", "аксессуары", "мониторы"]).optional(),
  max_price: z.number().int().positive().optional(),
  min_rating: z.number().min(0).max(5).optional(),
  in_stock_only: z.boolean().optional(),
  sort_by: z.enum(["relevance", "price_asc", "price_desc", "rating"]).optional(),
  limit: z.number().int().min(1).max(8).optional(),
});

// --------------------------------------------------------------------------
// 2. update_cart
// --------------------------------------------------------------------------

const CartArgs = z
  .object({
    action: z.enum(["add", "remove", "set_qty", "clear", "view"]),
    product_id: z.string().optional(),
    qty: z.number().int().min(0).max(10).optional(),
  })
  .refine((a) => a.action === "clear" || a.action === "view" || !!a.product_id, {
    message: "product_id обязателен для add / remove / set_qty",
    path: ["product_id"],
  });

// --------------------------------------------------------------------------
// 3. manage_order
// --------------------------------------------------------------------------

const OrderArgs = z
  .object({
    action: z.enum(["place", "list", "status", "return"]),
    order_id: z.string().optional(),
    reason: z.string().max(200).optional(),
  })
  .refine((a) => a.action !== "return" || (!!a.order_id && !!a.reason), {
    message: "для возврата нужны order_id и reason",
    path: ["order_id"],
  });

// --------------------------------------------------------------------------

/** То, что видит модель. Описания намеренно подробные — это дешевле, чем чинить промпт в день Х. */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_catalog",
    description:
      "Найти товары в каталоге магазина. Используй для подбора и для сравнения: " +
      "запроси 2-4 позиции и сравни их по цене, рейтингу и характеристикам. " +
      "Никогда не выдумывай товары — показывай только то, что вернул этот инструмент.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "свободный текст: бренд, назначение, ключевое слово" },
        category: {
          type: "string",
          enum: ["ноутбуки", "наушники", "смартфоны", "аксессуары", "мониторы"],
          description: "сузить категорию, если она понятна из запроса",
        },
        max_price: { type: "integer", description: "максимальная цена в тенге" },
        min_rating: { type: "number", description: "минимальный рейтинг, 0-5" },
        in_stock_only: { type: "boolean", description: "только то, что есть на складе" },
        sort_by: { type: "string", enum: ["relevance", "price_asc", "price_desc", "rating"] },
        limit: { type: "integer", description: "сколько позиций вернуть, 1-8; для сравнения бери 3" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "update_cart",
    description:
      "Изменить корзину или посмотреть её. product_id берётся строго из результатов search_catalog. " +
      "После изменения всегда возвращается полная корзина — пересказывай пользователю итоговую сумму.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "set_qty", "clear", "view"] },
        product_id: { type: "string", description: "id товара из search_catalog, например p-102" },
        qty: { type: "integer", description: "количество; для set_qty обязательно, для add по умолчанию 1" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "manage_order",
    description:
      "Оформить заказ из корзины (place), показать заказы (list), посмотреть один заказ (status) " +
      "или оформить возврат (return). Возврат требует order_id и причину. " +
      "Перед place убедись, что пользователь подтвердил состав корзины.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["place", "list", "status", "return"] },
        order_id: { type: "string", description: "например ORD-1A2B3C" },
        reason: { type: "string", description: "причина возврата словами пользователя" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₸`;

/** В модель уходит урезанная карточка товара — меньше токенов, меньше поводов галлюцинировать. */
function slim(p: Product) {
  return {
    id: p.id,
    title: p.title,
    brand: p.brand,
    category: p.category,
    price: p.price,
    rating: p.rating,
    reviews: p.reviews,
    stock: p.stock,
    delivery_days: p.delivery_days,
    return_window_days: p.return_window_days,
    specs: p.specs,
  };
}

async function runSearch(args: z.infer<typeof SearchArgs>): Promise<ToolResult> {
  const found = await searchProducts(args);
  return {
    ok: true,
    data: { products: found.map(slim), count: found.length },
    summary: found.length ? `найдено ${found.length}: ${found.map((p) => p.title).join(", ")}` : "ничего не найдено",
  };
}

async function runCart(args: z.infer<typeof CartArgs>, ctx: ToolContext): Promise<ToolResult> {
  const { sessionId } = ctx;

  if (args.action === "clear") {
    await clearCart(sessionId);
    return { ok: true, data: { cart: await getCart(sessionId) }, summary: "корзина очищена" };
  }

  if (args.action !== "view") {
    const product = await getProduct(args.product_id!);
    if (!product) {
      return {
        ok: false,
        data: { error: `товар ${args.product_id} не найден; сначала вызови search_catalog` },
        summary: `товар ${args.product_id} не найден`,
      };
    }
    if (args.action !== "remove" && product.stock <= 0) {
      return {
        ok: false,
        data: { error: `«${product.title}» нет на складе`, product: slim(product) },
        summary: `${product.title}: нет на складе`,
      };
    }

    const cart = await getCart(sessionId);
    const current = cart.lines.find((l) => l.product_id === product.id)?.qty ?? 0;
    const next =
      args.action === "add" ? current + (args.qty ?? 1)
      : args.action === "remove" ? 0
      : (args.qty ?? 1);

    if (next > product.stock) {
      return {
        ok: false,
        data: { error: `на складе только ${product.stock} шт.`, product: slim(product) },
        summary: `${product.title}: на складе ${product.stock}`,
      };
    }

    await setCartQty(sessionId, product.id, next);
    const updated = await getCart(sessionId);
    return {
      ok: true,
      data: { cart: updated, changed: { product_id: product.id, title: product.title, qty: next } },
      summary: `${args.action === "remove" ? "убрал" : "в корзине"} ${product.title} ×${next}, итого ${money(updated.total)}`,
    };
  }

  const cart = await getCart(sessionId);
  return { ok: true, data: { cart }, summary: `в корзине ${cart.count} шт. на ${money(cart.total)}` };
}

async function runOrder(args: z.infer<typeof OrderArgs>, ctx: ToolContext): Promise<ToolResult> {
  const { sessionId } = ctx;

  if (args.action === "place") {
    try {
      const order = await placeOrder(sessionId);
      return {
        ok: true,
        data: { order, cart: await getCart(sessionId) },
        summary: `заказ ${order.id} на ${money(order.total)}, доставка ${order.eta_days} дн.`,
      };
    } catch (e) {
      if ((e as Error).message === "EMPTY_CART") {
        return { ok: false, data: { error: "корзина пуста — сначала добавь товар" }, summary: "корзина пуста" };
      }
      throw e;
    }
  }

  if (args.action === "return") {
    try {
      const order = await requestReturn(sessionId, args.order_id!, args.reason!);
      return {
        ok: true,
        data: { order, orders: await listOrders(sessionId) },
        summary: `возврат по ${order.id}: ${args.reason}`,
      };
    } catch (e) {
      const msg = (e as Error).message;
      const human =
        msg === "ORDER_NOT_FOUND" ? `заказ ${args.order_id} не найден; вызови manage_order с action=list`
        : msg === "ALREADY_RETURNING" ? "по этому заказу возврат уже оформлен"
        : msg;
      return { ok: false, data: { error: human, orders: await listOrders(sessionId) }, summary: human };
    }
  }

  const orders = await listOrders(sessionId);
  if (args.action === "status" && args.order_id) {
    const one = orders.find((o) => o.id.toLowerCase() === args.order_id!.toLowerCase());
    return one
      ? { ok: true, data: { order: one }, summary: `${one.id}: ${one.status}` }
      : { ok: false, data: { error: `заказ ${args.order_id} не найден`, orders }, summary: "заказ не найден" };
  }
  return { ok: true, data: { orders }, summary: `заказов: ${orders.length}` };
}

export type ToolOutcome =
  | { kind: "ok"; result: ToolResult }
  | { kind: "invalid_args"; message: string };

/**
 * Валидирует аргументы и исполняет инструмент.
 * Невалидные аргументы — не исключение, а отдельный исход: цикл отдаст
 * модели текст ошибки и даст ей переписать вызов.
 */
export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { kind: "invalid_args", message: `аргументы не являются корректным JSON: ${rawArgs.slice(0, 200)}` };
  }

  const describe = (issues: z.ZodIssue[]) =>
    issues.map((i) => `${i.path.join(".") || "(корень)"}: ${i.message}`).join("; ");

  switch (name) {
    case "search_catalog": {
      const v = SearchArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      return { kind: "ok", result: await runSearch(v.data) };
    }
    case "update_cart": {
      const v = CartArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      return { kind: "ok", result: await runCart(v.data, ctx) };
    }
    case "manage_order": {
      const v = OrderArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      return { kind: "ok", result: await runOrder(v.data, ctx) };
    }
    default:
      return {
        kind: "invalid_args",
        message: `инструмента «${name}» не существует. Доступны: ${TOOL_SPECS.map((t) => t.name).join(", ")}`,
      };
  }
}
