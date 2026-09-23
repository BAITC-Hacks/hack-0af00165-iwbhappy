import type { ModelTurn, Msg, ToolCall } from "./types";
import { getProduct } from "../db";
import { isAffirmative } from "../agent/tools";
import { detectLang } from "../agent/loop";

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
    if (messages[i].role === "user") return (messages[i] as { content: string }).content;
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
 * Токен от пяти символов с цифрой считаем артикулом только после проверки в БД.
 */
async function extractSku(text: string): Promise<string | null> {
  const raw = text.match(/[\p{L}\d][\p{L}\d._\/-]*/gu) ?? [];
  for (const token of raw) {
    const candidate = token.replace(/[.,;:]+$/, "");
    if (candidate.length < 5 || !/\d/.test(candidate)) continue;
    const product = await getProduct(candidate);
    if (product) return product.sku;
  }
  return null;
}

/** История товара нужна только для явного запроса аналогов. */
function skuFromHistory(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" || m.name !== "get_product") continue;
    const d = parse(m.content);
    const product = d.product as AnyRec | undefined;
    if (product?.sku) return String(product.sku);
  }
  return null;
}

function pendingProposalId(messages: Msg[]): string | null {
  let pending: string | null = null;
  for (const m of messages) {
    if (m.role === "user" && declines(m.content)) pending = null;
    if (m.role !== "tool") continue;
    const d = parse(m.content);
    if (m.name === "propose_add" && d.proposalId) pending = String(d.proposalId);
    if (m.name === "confirm_add" && d.cart) pending = null;
  }
  return pending;
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
  const withUnit = /(?:^|[\s,;:])(\d{1,3})\s*(?:шт(?:ук[аиу]?)?\.?|дана)(?=$|[\s,.!?;:])/i;
  const standalone = /(?:^|[\s,;:])(\d{1,3})(?=$|[\s,;!?])/i;

  const m = text.match(withUnit) ?? text.match(standalone);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
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

const words = (text: string) => text.toLowerCase().split(/[^a-zа-яёәғқңөұүһі0-9+]+/i).filter(Boolean);
const DECLINE = new Set(["нет", "не", "отмена", "отмени", "отменить", "жоқ", "емес", "қоспа", "қоспаңыз"]);
const declines = (text: string) => words(text).some((word) => DECLINE.has(word));
const ASKS_ALTERNATIVE = /аналог|замен|взамен|вместо/i;
const WANTS_ADD = /добав|в корзину|положи|куплю|беру|закаж|қос|себетке/i;

function addQuery(text: string): string {
  return text.replace(/добав[а-яё]*|положи[а-яё]*|куплю|беру|закаж[а-яё]*|қос[а-яёәғқңөұүһі]*|себетке|в\s+корзину/gi, " ")
    .replace(/(?:^|\s)\d{1,3}\s*(?:шт[а-яё]*\.?|дана)(?=$|[\s,.!?])/gi, " ")
    .replace(/\s+/g, " ").replace(/^[\s,.!?]+|[\s,.!?]+$/g, "");
}

// Согласие на предложение не должно поглощать новую просьбу о другом товаре.
const REPLY_WORDS = new Set(["да", "ага", "угу", "ок", "окей", "ok", "okay", "yes", "хорошо", "давай", "давайте", "подтверждаю", "согласен", "согласна", "верно", "точно", "именно", "+", "иә", "ия", "иа", "йә", "жарайды", "мақұл", "келісемін", "болады", "дұрыс", "аламын", "алам", "пожалуйста"]);

export async function mockTurn(messages: Msg[]): Promise<ModelTurn> {
  const text = lastUserText(messages);
  let userIndex = messages.length - 1;
  while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex--;
  const history = messages.slice(0, Math.max(0, userIndex));
  const last = lastToolMessage(messages);
  const adding = WANTS_ADD.test(text);
  if (turnTools(messages).length && last) {
    const data = parse(last.content);
    if (!data.error && last.name === "search_catalog" && adding) {
      const first = (data.products as AnyRec[] | undefined)?.[0];
      if (first?.sku) return turn(null, [tool("propose_add", { sku: first.sku, qty: qtyFrom(text) })]);
    }
    if (!data.error && last.name === "get_product") {
      const product = data.product as AnyRec | undefined;
      if (product && Number(product.available) === 0) return turn(null, [tool("find_alternatives", { sku: product.sku })]);
    }
    return turn(render(last, messages));
  }

  const pending = pendingProposalId(history);
  const confirmationOnly = words(addQuery(text)).every((word) => REPLY_WORDS.has(word));
  if (pending && isAffirmative(text) && confirmationOnly) return turn(null, [tool("confirm_add", { proposalId: pending })]);
  if (pending && declines(text)) return turn(detectLang(text, history) === "kk" ? "Жарайды, қоспаймын." : "Хорошо, не добавляю.");

  const topics = [
    /оплат|платить|төлем/i.test(text) && "payment",
    /доставк|жеткізу/i.test(text) && "delivery",
    /самовывоз/i.test(text) && "pickup",
    /гарант/i.test(text) && "warranty",
    /возврат/i.test(text) && "returns",
    /парти|минимальн|кратн/i.test(text) && "min_order",
  ].filter(Boolean);
  if (topics.length || /услови/i.test(text)) return turn(null, [tool("get_terms", { topic: topics.length === 1 ? topics[0] : "all" })]);
  if (/менеджер|человек|оператор|позвонить|претензи|жалоб/i.test(text)) return turn(null, [tool("get_terms", { topic: "contacts" })]);

  const sku = await extractSku(text);
  if (adding) {
    if (sku) return turn(null, [tool("propose_add", { sku, qty: qtyFrom(text) })]);
    return turn(null, [tool("search_catalog", { query: (addQuery(text) || text).slice(0, 160) })]);
  }
  if (sku) return turn(null, [tool("get_product", { sku })]);
  if (ASKS_ALTERNATIVE.test(text)) {
    const previousSku = skuFromHistory(history);
    if (previousSku) return turn(null, [tool("find_alternatives", { sku: previousSku })]);
  }
  return turn(null, [tool("search_catalog", { query: text.slice(0, 160) || "автоматический выключатель" })]);
}

// --------------------------------------------------------------------------
// Ответы пользователю
// --------------------------------------------------------------------------

function render(toolMsg: Extract<Msg, { role: "tool" }>, messages: Msg[]): string {
  const d = parse(toolMsg.content);
  const lang = detectLang(lastUserText(messages), messages.filter((m) => m.role === "user").slice(0, -1));
  const say = (ru: string, kk: string) => lang === "kk" ? kk : ru;
  if (d.error) return say("Не получилось: ", "Орындалмады: ") + String(d.error) + say(" Уточните запрос.", " Сұрауды нақтылаңыз.");

  switch (toolMsg.name) {
    case "search_catalog": {
      const items = (d.products as AnyRec[]) ?? [];
      if (!items.length) return say("Ничего не нашлось. Уточните тип изделия или обратитесь к менеджеру.", "Ештеңе табылмады. Тауар түрін нақтылаңыз немесе менеджерге хабарласыңыз.");
      const lines = items.slice(0, 5).map(
        (p) => `• ${p.sku} — ${p.name}, ${money(Number(p.price))}, ${Number(p.available) > 0 ? say(`в наличии ${p.available} шт.`, `қоймада ${p.available} дана`) : say("нет в наличии", "қоймада жоқ")}`,
      );
      return say("Нашёл по вашему запросу:\n", "Сұрауыңыз бойынша табылды:\n") + lines.join("\n") + say("\n\nКакая позиция интересует?", "\n\nҚай тауар қызықтырады?");
    }
    case "get_product": {
      const p = (d.product ?? {}) as AnyRec;
      const specs = Object.entries((p.specs ?? {}) as AnyRec).slice(0, 4).map(([k, v]) => k + ": " + v).join(", ");
      const stock = (p.stock as AnyRec[]) ?? [];
      const parts = [p.sku + " — " + p.name + ". " + say("Цена: ", "Бағасы: ") + money(Number(p.price)) + ". " + say("В наличии: ", "Қоймада: ") + p.available + "."];
      if (specs) parts.push(say("Характеристики: ", "Сипаттамалары: ") + specs + ".");
      if (stock.length) parts.push(say("Склады: ", "Қоймалар: ") + stock.slice(0, 4).map((s) => s["склад"] + " — " + s["остаток"]).join(", ") + ".");
      const cert = p.certificate as AnyRec | null;
      parts.push(cert
        ? "Сертификат: " + cert.title + (cert.demo ? say(" (демонстрационный)", " (демонстрациялық)") : "") + ". " + (cert.url ?? "")
        : say("Сертификата по этой позиции в базе нет.", "Дерекқорда сертификат жоқ."));
      return parts.join(" ");
    }
    case "find_alternatives": {
      const items = (d.alternatives as AnyRec[]) ?? [];
      const base = (d.base ?? {}) as AnyRec;
      if (!items.length) return say("Аналогов не нашлось. Могу передать запрос менеджеру.", "Баламалар табылмады. Сұрақты менеджерге бере аламын.");
      const lines = items.map((a) => "• " + a.sku + " — " + a.name + ", " + money(Number(a.price)) + "\n  " + a.reason);
      return say("Вместо ", "Бастапқы тауар: ") + base.sku + say(" могу предложить:\n", ". Баламалар:\n") + lines.join("\n") + say("\n\nДобавить какую-то из них в корзину?", "\n\nБіреуін себетке қосайын ба?");
    }
    case "get_terms": {
      const terms = (d.terms as AnyRec[]) ?? [];
      if (!terms.length) return say("Не нашёл условий по этому вопросу.", "Бұл сұрақ бойынша шарттар табылмады.");
      return say("Условия и контакты:\n", "Шарттар мен байланыс деректері:\n") + terms.map((t) => {
        const details = (t.details as string[]) ?? [];
        return t.title + ": " + t.text + (details.length ? "\n" + details.slice(0, 4).join("\n") : "");
      }).join("\n\n");
    }
    case "propose_add":
      return d.sku + " — " + d.name + ": " + d.qty + say(" шт. × ", " дана × ") + money(Number(d.price)) + say(", итого ", ", барлығы ") + money(Number(d.lineTotal)) + "." + (d.note ? " " + d.note : "")
        + say("\n\nДобавляю в корзину? Подтвердите.", "\n\nСебетке қосайын ба? Растаңыз.");
    case "confirm_add": {
      const cart = (d.cart ?? {}) as AnyRec;
      const lines = (d.lines as AnyRec[]) ?? [];
      const notes = (d.notes as string[]) ?? [];
      const related = (d.related as AnyRec[]) ?? [];
      return say("Добавлено: ", "Қосылды: ") + lines.map((l) => l.name + " ×" + l.added).join(", ") + ". "
        + say("В корзине ", "Себетте ") + cart.count + say(" шт. на ", " дана, барлығы ") + money(Number(cart.total)) + "."
        + (notes.length ? "\n" + notes.join("\n") : "")
        + say("\nСсылка на корзину: ", "\nСебет сілтемесі: ") + d.cartUrl
        + (related.length ? say("\nК этому товару рекомендуют:\n", "\nБұл тауарға ұсынылады:\n")
          + related.map((p) => p.sku + " — " + p.name + ", " + money(Number(p.price)) + ": " + p.reason).join("\n") : "");
    }
    case "get_cart_link":
      return say("Ссылка на корзину: ", "Себет сілтемесі: ") + d.url;
    default:
      return say("Готово.", "Дайын.");
  }
}
