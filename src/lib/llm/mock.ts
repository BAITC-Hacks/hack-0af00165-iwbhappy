import type { ModelTurn, Msg, ToolCall } from "./types";

/**
 * Записанный режим — раздел 7 AGENTS.md.
 *
 * Это не заглушка ради теста, а страховка защиты: на площадке две с
 * половиной тысячи участников, и Wi-Fi ляжет. Все пять приёмочных
 * сценариев раздела 9 отрабатывают здесь целиком без сети.
 *
 * Правило подтверждения мок соблюдает наравне с живой моделью:
 * propose_add и confirm_add никогда не вызываются в одном ходу.
 * Сервер всё равно отказал бы, но мок не должен уметь этого даже пытаться.
 *
 * Интерфейс помечает такие ответы значком MOCK — выдавать записанный
 * ответ за живую модель нельзя.
 */

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₸`;

type AnyRec = Record<string, unknown>;

function parse(content: string): AnyRec {
  try {
    return JSON.parse(content) as AnyRec;
  } catch {
    return {};
  }
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return (messages[i] as { content: string }).content.toLowerCase();
  }
  return "";
}

function lastToolMessage(messages: Msg[]): Extract<Msg, { role: "tool" }> | null {
  const m = messages[messages.length - 1];
  return m && m.role === "tool" ? m : null;
}

/** Инструменты, уже отработавшие внутри текущего хода. */
function turnTools(messages: Msg[]): Array<{ name: string; data: AnyRec }> {
  const out: Array<{ name: string; data: AnyRec }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    if (m.role === "tool") out.unshift({ name: m.name, data: parse(m.content) });
  }
  return out;
}

/**
 * Артикулы ekt выглядят по-разному: R9F12110, 404029х, 030300462_, УКЗ-001-412.
 * Берём достаточно длинный токен, в котором есть хотя бы две цифры.
 */
function extractSku(text: string): string | null {
  const raw = text.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9._\-/]{4,}/g) ?? [];
  for (const token of raw) {
    const digits = (token.match(/\d/g) ?? []).length;
    if (digits >= 2) return token.replace(/[.,;:]+$/, "");
  }
  return null;
}

/** Артикул из последних результатов инструментов — если в реплике его нет. */
function skuFromHistory(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const d = parse(m.content);
    const product = d.product as AnyRec | undefined;
    if (product?.sku) return String(product.sku);
    const proposal = d.proposalId ? d : null;
    if (proposal?.sku) return String(proposal.sku);
    const list = (d.products as AnyRec[]) ?? [];
    if (list[0]?.sku) return String(list[0].sku);
  }
  return null;
}

function pendingProposalId(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" || m.name !== "propose_add") continue;
    const d = parse(m.content);
    if (d.proposalId) return String(d.proposalId);
  }
  return null;
}

/**
 * Количество из реплики.
 *
 * Наивное `/(\d+)/` здесь ловит цифру ИЗ АРТИКУЛА: в «добавь R9F12110,
 * 2 штуки» первое число — девятка внутри R9F12110. Поэтому число должно
 * стоять отдельным словом, а не быть частью буквенно-цифрового токена.
 */
function qtyFrom(text: string): number {
  // Только литералы: при сборке регулярки из шаблонной строки `\d`
  // превращается в обычную «d», и это ломается молча.
  const withUnit = /(?:^|[^A-Za-zА-Яа-яЁё0-9])(\d{1,3})\s*(?:шт|штук)/i;
  const standalone = /(?:^|[^A-Za-zА-Яа-яЁё0-9])(\d{1,3})(?![A-Za-zА-Яа-яЁё0-9])/i;

  const m = text.match(withUnit) ?? text.match(standalone);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 1;
}

let seq = 0;
const tool = (name: string, args: AnyRec): ToolCall => ({
  id: `mock_${++seq}_${Date.now().toString(36)}`,
  name,
  arguments: JSON.stringify(args),
});

const turn = (content: string | null, toolCalls: ToolCall[] = []): ModelTurn => ({
  content,
  toolCalls,
  model: "mock-scripted",
  source: "mock",
});

// --------------------------------------------------------------------------

const AFFIRM = /^(да|ага|ок|окей|хорошо|давай|добавь|добавьте|подтверждаю|беру)\b|(^|\s)да[,.\s]|добавь/;
const ASKS_ALTERNATIVE = /аналог|взамен|замен|посовет|чем замен|что вместо/;
const ASKS_TERMS = /услови|оплат|доставк|партия|самовывоз|как платить|как получить/;
const ASKS_CART = /корзин[ае]|что у меня/;
const ASKS_LINK = /ссылк|оформ/;
const WANTS_ADD = /добав|в корзину|куплю|бер[уё]|оформ|закаж/;

export function mockTurn(messages: Msg[]): ModelTurn {
  const text = lastUserText(messages);
  const trail = turnTools(messages);
  const used = (n: string) => trail.some((t) => t.name === n);
  const finish = () => {
    const last = lastToolMessage(messages);
    return turn(last ? render(last, messages) : "Готово.");
  };

  // --- подтверждение: только если предложение сделано в прошлом ходу ---
  if (AFFIRM.test(text) && !WANTS_ADD.test(text.replace(/добавь/g, ""))) {
    const pid = pendingProposalId(messages);
    const proposedNow = used("propose_add");
    if (pid && !proposedNow) {
      if (used("get_cart_link")) return finish();
      const confirmed = trail.find((t) => t.name === "confirm_add");
      if (!confirmed) return turn(null, [tool("confirm_add", { proposalId: pid })]);
      // Подтвердили — сразу отдаём ссылку на корзину (пункт 15 промпта).
      if (confirmed.data.cart) return turn(null, [tool("get_cart_link", {})]);
      return finish();
    }
  }

  // --- намерение купить -> предложение, корзину не трогаем ---
  if (WANTS_ADD.test(text)) {
    if (used("propose_add")) return finish();
    const sku = extractSku(text) ?? skuFromHistory(messages);
    if (sku) return turn(null, [tool("propose_add", { sku, qty: qtyFrom(text) })]);
  }

  // --- условия покупки ---
  if (ASKS_TERMS.test(text)) {
    if (used("get_terms")) return finish();
    // Спросили сразу о нескольких вещах («оплата и доставка») — отдаём всё.
    const hits = [
      /оплат|платить|счёт|счет/.test(text) && "payment",
      /доставк|привез|привоз|срок/.test(text) && "delivery",
      /партия|минималь|кратн/.test(text) && "min_order",
      /самовывоз|забрать|склад/.test(text) && "pickup",
    ].filter(Boolean) as string[];
    const topic = hits.length === 1 ? hits[0] : "all";
    return turn(null, [tool("get_terms", { topic })]);
  }

  // --- ссылка на корзину ---
  if (ASKS_LINK.test(text) && !WANTS_ADD.test(text)) {
    if (used("get_cart_link")) return finish();
    return turn(null, [tool("get_cart_link", {})]);
  }

  if (ASKS_CART.test(text)) {
    if (used("get_cart")) return finish();
    return turn(null, [tool("get_cart", {})]);
  }

  // --- аналоги: сначала карточка, потом замена ---
  const sku = extractSku(text) ?? skuFromHistory(messages);
  if (ASKS_ALTERNATIVE.test(text) && sku) {
    if (used("find_alternatives")) return finish();
    if (!used("get_product")) return turn(null, [tool("get_product", { sku })]);
    const card = trail.find((t) => t.name === "get_product");
    const product = (card?.data.product ?? {}) as AnyRec;
    if (Number(product.available ?? 0) > 0) return finish(); // есть в наличии — аналоги не нужны
    return turn(null, [tool("find_alternatives", { sku })]);
  }

  // --- карточка товара ---
  if (sku) {
    if (used("get_product")) {
      const card = trail.find((t) => t.name === "get_product");
      const product = (card?.data.product ?? {}) as AnyRec;
      // Нет в наличии — сам предлагаю замену, не дожидаясь вопроса.
      if (Number(product.available ?? 0) === 0 && !used("find_alternatives")) {
        return turn(null, [tool("find_alternatives", { sku: String(product.sku ?? sku) })]);
      }
      return finish();
    }
    return turn(null, [tool("get_product", { sku })]);
  }

  // --- свободный поиск ---
  if (used("search_catalog")) return finish();
  return turn(null, [tool("search_catalog", { query: text.slice(0, 120) || "автоматический выключатель" })]);
}

// --------------------------------------------------------------------------
// Ответы пользователю
// --------------------------------------------------------------------------

function render(toolMsg: Extract<Msg, { role: "tool" }>, messages: Msg[]): string {
  const d = parse(toolMsg.content);
  if (d.error) return `Не получилось: ${String(d.error)} Уточните, пожалуйста, что делаем дальше.`;

  switch (toolMsg.name) {
    case "search_catalog": {
      const items = (d.products as AnyRec[]) ?? [];
      if (!items.length) return "По такому запросу ничего не нашлось. Уточните тип изделия или номинал, либо я передам вопрос менеджеру.";
      const lines = items.slice(0, 5).map(
        (p) => `• ${String(p.sku)} — ${String(p.name)}, ${money(Number(p.price))}, ${Number(p.available) > 0 ? `в наличии ${p.available} шт.` : "нет в наличии"}`,
      );
      return `Нашёл по вашему запросу:\n${lines.join("\n")}\n\nПо какой позиции рассказать подробнее?`;
    }

    case "get_product": {
      const p = (d.product ?? {}) as AnyRec;
      const specs = (p.specs ?? {}) as Record<string, string>;
      const specLine = Object.entries(specs).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(", ");
      const stock = (p.stock as AnyRec[]) ?? [];
      const avail = Number(p.available ?? 0);

      const head = avail > 0
        ? `${String(p.name)} — в наличии ${avail} шт., ${money(Number(p.price))}.`
        : `${String(p.name)} — сейчас нет в наличии. Цена ${money(Number(p.price))}.`;

      const parts = [head];
      if (specLine) parts.push(`Характеристики: ${specLine}.`);
      if (stock.length) {
        parts.push(`Склады: ${stock.slice(0, 4).map((s) => `${s["склад"]} — ${s["остаток"]}`).join(", ")}.`);
      }
      const cert = p.certificate as AnyRec | null;
      if (cert) {
        parts.push(`Сертификат: ${String(cert.title)}${cert.demo ? " (демонстрационные данные прототипа)" : ""}.`);
      } else {
        parts.push("Сертификата по этой позиции в базе нет.");
      }
      if (avail === 0) parts.push("Подобрать аналог?");
      return parts.join(" ");
    }

    case "find_alternatives": {
      const items = (d.alternatives as AnyRec[]) ?? [];
      const base = (d.base ?? {}) as AnyRec;
      if (!items.length) return `Замены для ${String(base.sku ?? "")} в каталоге не нашлось. Могу передать запрос менеджеру.`;
      const lines = items.map(
        (a) => `• ${String(a.sku)} — ${String(a.name)}, ${money(Number(a.price))}\n  почему: ${String(a.reason)}`,
      );
      return `Вместо ${String(base.sku ?? "этой позиции")} могу предложить:\n${lines.join("\n")}\n\nДобавить какую-то из них в корзину?`;
    }

    case "get_terms": {
      const terms = (d.terms as AnyRec[]) ?? [];
      if (!terms.length) return "Не нашёл условий по этому вопросу.";
      return terms
        .map((t) => {
          const details = (t.details as string[]) ?? [];
          return `${String(t.title)}: ${String(t.text)}${details.length ? `\n  ${details.slice(0, 4).join("\n  ")}` : ""}`;
        })
        .join("\n\n");
    }

    case "propose_add": {
      const note = d.note ? ` ${String(d.note)}.` : "";
      return `${String(d.name)} — ${d.qty} шт. по ${money(Number(d.price))}, итого ${money(Number(d.lineTotal))}.${note}\n\nДобавляю в корзину? Подтвердите.`;
    }

    case "confirm_add": {
      const cart = (d.cart ?? {}) as AnyRec;
      const added = (d.added ?? {}) as AnyRec;
      const capped = d.capped
        ? ` Добавил только ${added.qty} шт. — это весь доступный остаток (${d.availableQty} шт.).`
        : "";
      return `Добавил: ${String(added.name)} ×${added.qty}.${capped} В корзине ${cart.count} шт. на ${money(Number(cart.total))}.`;
    }

    case "get_cart": {
      const cart = (d.cart ?? {}) as AnyRec;
      const lines = (cart.lines as AnyRec[]) ?? [];
      if (!lines.length) return "Корзина пока пуста.";
      return `В корзине:\n${lines.map((l) => `• ${String(l.name)} ×${l.qty} — ${money(Number(l.lineTotal))}`).join("\n")}\n\nИтого ${money(Number(cart.total))}.`;
    }

    case "get_cart_link":
      return `Вот ссылка на корзину: ${String(d.url)} — там ${d.itemsCount} шт. на ${money(Number(d.total))}. Оформить заказ можно на этой странице.`;

    default:
      void messages;
      return "Готово.";
  }
}
