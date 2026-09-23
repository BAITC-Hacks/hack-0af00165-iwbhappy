import type { ModelTurn, Msg, ToolCall } from "./types";

/**
 * Записанный режим. Это не «заглушка ради теста» — это страховка демо:
 * если на площадке лёг вайфай или кончилась квота, сценарий
 * подбор -> сравнение -> заказ -> возврат отрабатывает целиком без сети.
 *
 * Интерфейс намеренно помечает такие ответы значком MOCK, чтобы
 * случайно не выдать записанный ответ за живую модель.
 */

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₸`;

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content.toLowerCase();
  }
  return "";
}

function lastToolMessage(messages: Msg[]): Extract<Msg, { role: "tool" }> | null {
  const m = messages[messages.length - 1];
  return m && m.role === "tool" ? m : null;
}

type AnyRec = Record<string, unknown>;

function parse(content: string): AnyRec {
  try {
    return JSON.parse(content) as AnyRec;
  } catch {
    return {};
  }
}

/** Последние товары, которые агент уже показывал — из них выбираем при «добавь в корзину». */
function knownProducts(messages: Msg[]): Array<{ id: string; title: string; price: number }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.name === "search_catalog") {
      const items = (parse(m.content).products as Array<AnyRec>) ?? [];
      // Пустую выдачу пропускаем: товары, показанные раньше, всё ещё в силе.
      if (items.length === 0) continue;
      return items.map((p) => ({ id: String(p.id), title: String(p.title), price: Number(p.price) }));
    }
  }
  return [];
}

function knownOrderId(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.name === "manage_order") {
      const data = parse(m.content);
      const order = (data.order as AnyRec) ?? null;
      if (order?.id) return String(order.id);
      const orders = (data.orders as Array<AnyRec>) ?? [];
      if (orders[0]?.id) return String(orders[0].id);
    }
  }
  return null;
}

/** Фильтры прошлого поиска: «сравни с вариантом подешевле» должно остаться в той же категории. */
function lastSearchFilters(messages: Msg[]): { category?: string; max_price?: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    const call = m.tool_calls.find((t) => t.name === "search_catalog");
    if (!call) continue;
    try {
      const a = JSON.parse(call.arguments) as AnyRec;
      return {
        category: a.category ? String(a.category) : undefined,
        max_price: typeof a.max_price === "number" ? a.max_price : undefined,
      };
    } catch {
      return {};
    }
  }
  return {};
}

function pickProduct(text: string, pool: Array<{ id: string; title: string }>): string | null {
  if (pool.length === 0) return null;
  const hit = pool.find((p) => text.includes(p.title.toLowerCase().split(" ")[0]));
  if (hit) return hit.id;
  if (/дешев|бюджет|подешевл/.test(text)) return pool[pool.length - 1].id;
  return pool[0].id;
}

function priceCeiling(text: string): number | undefined {
  const m = text.match(/(\d[\d\s]{2,})\s*(?:тг|тенге|₸)?/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/\s/g, ""));
  return Number.isFinite(n) && n > 1000 ? n : undefined;
}

function categoryOf(text: string): string | undefined {
  if (/ноут|лэптоп|laptop/.test(text)) return "ноутбуки";
  if (/наушник|headphone|ANC|анс/i.test(text)) return "наушники";
  if (/смартфон|телефон|phone/.test(text)) return "смартфоны";
  if (/монитор/.test(text)) return "мониторы";
  if (/зарядк|чехол|мышь|хаб|аксессуар/.test(text)) return "аксессуары";
  return undefined;
}

let seq = 0;
const callId = () => `mock_${++seq}_${Date.now().toString(36)}`;

function tool(name: string, args: AnyRec): ToolCall {
  return { id: callId(), name, arguments: JSON.stringify(args) };
}

function turn(content: string | null, toolCalls: ToolCall[] = []): ModelTurn {
  return { content, toolCalls, model: "mock-scripted", source: "mock" };
}

/** Инструменты, отработавшие уже внутри текущего хода (после последней реплики пользователя). */
function currentTurnTools(messages: Msg[]): Array<{ name: string; data: AnyRec }> {
  const out: Array<{ name: string; data: AnyRec }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    if (m.role === "tool") out.unshift({ name: m.name, data: parse(m.content) });
  }
  return out;
}

/** Сколько позиций в корзине по последнему известному ответу инструмента. */
function cartCount(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const cart = parse(m.content).cart as AnyRec | undefined;
    if (cart && typeof cart.count === "number") return cart.count;
  }
  return 0;
}

function reasonOf(text: string): string {
  if (/брак|слом|не работ|разбит/.test(text)) return "брак";
  if (/не подош|размер|не то|тяжёл|тяжел/.test(text)) return "не подошёл";
  return "передумал";
}

/**
 * Один ход «модели» без сети.
 *
 * Это не просто «ответ на фразу»: мок смотрит, что уже сделано внутри
 * текущего хода, и умеет выстраивать цепочку из двух вызовов —
 * «возьми его и оформи» превращается в update_cart, а затем manage_order.
 * Без этого записанный режим не вытянул бы демо-сценарий целиком.
 */
export function mockTurn(messages: Msg[]): ModelTurn {
  const text = lastUserText(messages);
  const trail = currentTurnTools(messages);
  const used = (name: string) => trail.some((t) => t.name === name);
  const finish = () => {
    const last = lastToolMessage(messages);
    return turn(last ? renderToolResult(last, messages) : "Готово.");
  };

  // --- возврат: сначала узнать номер заказа, потом оформить ---
  if (/верн|возврат|не подош|брак|refund/.test(text)) {
    const done = trail.some((t) => (t.data.order as AnyRec)?.status === "return_requested");
    if (done) return finish();

    const orderId = knownOrderId(messages);
    if (orderId) return turn(null, [tool("manage_order", { action: "return", order_id: orderId, reason: reasonOf(text) })]);
    if (!used("manage_order")) return turn(null, [tool("manage_order", { action: "list" })]);
    return finish();
  }

  // --- оформление: при необходимости сначала положить товар в корзину ---
  if (/оформ|закаж|заказ|куп|checkout|беру|бери|оплат/.test(text)) {
    if (used("manage_order")) return finish(); // place уже отработал — успешно или нет
    if (cartCount(messages) === 0 && !used("update_cart") && /бери|беру|возьм|его|это|этот/.test(text)) {
      const pid = pickProduct(text, knownProducts(messages));
      if (pid) return turn(null, [tool("update_cart", { action: "add", product_id: pid, qty: 1 })]);
    }
    return turn(null, [tool("manage_order", { action: "place" })]);
  }

  if (/добав|в корзин|возьм|положи/.test(text)) {
    if (used("update_cart")) return finish();
    const pid = pickProduct(text, knownProducts(messages));
    if (pid) return turn(null, [tool("update_cart", { action: "add", product_id: pid, qty: 1 })]);
  }

  if (/корзин|что у меня/.test(text)) {
    if (used("update_cart")) return finish();
    return turn(null, [tool("update_cart", { action: "view" })]);
  }

  // --- по умолчанию подбор ---
  if (used("search_catalog")) return finish();
  const prev = lastSearchFilters(messages);
  return turn(null, [
    tool("search_catalog", {
      query: text.slice(0, 60) || "популярное",
      category: categoryOf(text) ?? prev.category,
      max_price: priceCeiling(text) ?? prev.max_price,
      in_stock_only: true,
      sort_by: /дешев|подешевл|бюджет/.test(text) ? "price_asc" : "rating",
      limit: 3,
    }),
  ]);
}

function renderToolResult(toolMsg: Extract<Msg, { role: "tool" }>, messages: Msg[]): string {
  const data = parse(toolMsg.content);
  if (data.error) return `Не получилось: ${String(data.error)}. Уточните, пожалуйста, что делаем дальше.`;

  if (toolMsg.name === "search_catalog") {
    const items = (data.products as Array<AnyRec>) ?? [];
    if (items.length === 0) return "По таким условиям ничего не нашлось. Давайте поднимем бюджет или расширим категорию?";
    const lines = items.slice(0, 3).map((p, i) => {
      const specs = (p.specs as AnyRec) ?? {};
      const hint = specs.ram_gb ? `${specs.ram_gb} ГБ RAM, ${specs.ssd_gb ?? specs.storage_gb ?? "—"} ГБ` : (specs.battery_h ? `${specs.battery_h} ч автономности` : String(p.brand));
      return `${i + 1}. ${String(p.title)} — ${money(Number(p.price))}, рейтинг ${p.rating}, ${hint}`;
    });
    return `Вот что подходит:\n\n${lines.join("\n")}\n\nПервый — лучший баланс цены и отзывов. Добавить его в корзину?`;
  }

  if (toolMsg.name === "update_cart") {
    const cart = (data.cart as AnyRec) ?? {};
    const lines = (cart.lines as Array<AnyRec>) ?? [];
    if (lines.length === 0) return "Корзина пуста.";
    const body = lines.map((l) => `• ${String(l.title)} ×${l.qty} — ${money(Number(l.line_total))}`).join("\n");
    return `В корзине:\n${body}\n\nИтого ${money(Number(cart.total ?? 0))}. Оформляем заказ?`;
  }

  if (toolMsg.name === "manage_order") {
    const order = (data.order as AnyRec) ?? null;
    const orders = (data.orders as Array<AnyRec>) ?? [];
    if (order?.status === "return_requested") {
      return `Возврат по заказу ${String(order.id)} оформлен, причина — «${String(order.return_reason)}». Деньги вернутся на карту в течение 3 рабочих дней, курьер заберёт товар завтра.`;
    }
    if (order?.status === "placed") {
      return `Заказ ${String(order.id)} оформлен на ${money(Number(order.total))}. Доставка — ${order.eta_days} дн. Если что-то не подойдёт, возврат в течение 14 дней — скажите мне, я оформлю.`;
    }
    if (orders.length > 0) {
      const body = orders.map((o) => `• ${String(o.id)} — ${String(o.status)}, ${money(Number(o.total))}`).join("\n");
      return `Ваши заказы:\n${body}\n\nПо какому оформляем возврат?`;
    }
    return "Заказов пока нет.";
  }

  void messages;
  return "Готово.";
}
