import { z } from "zod";
import {
  consumeProposal, createProposal, findAlternatives, getCart, getProduct,
  getProposal, getTerms, labelSpec, searchCatalog, type Product,
} from "../db";
import type { ToolSpec } from "../llm/types";

/**
 * Восемь инструментов раздела 5 AGENTS.md — тонкие обёртки над SQLite.
 * Никакой логики модели внутри: всё, что решает, добавлять ли товар,
 * решается здесь, на сервере.
 */

export type ToolContext = {
  sessionId: string;
  /** Сырая последняя реплика пользователя. Сохраняется сервером, модель на неё не влияет. */
  lastUserMessage: string;
  /** Момент начала обработки текущей реплики — граница «прошлый ход / этот ход». */
  turnStartedAt: string;
  /**
   * Адрес, с которого пришёл запрос, — чтобы ссылка на корзину была полной.
   * Относительную ссылку модель «достраивает» сама и однажды приписала к ней
   * домен ekt.kz, где нашей корзины нет.
   */
  origin?: string;
};

export type ToolResult = {
  ok: boolean;
  /** Уходит в модель. */
  data: Record<string, unknown>;
  summary: string;
  /**
   * Уходит в браузер вместе с событием tool_result.
   * Поле намеренно отдельное: всё, что инструмент показывает интерфейсу,
   * перечисляется явно, а не утекает туда целиком вместе с data.
   */
  client?: Record<string, unknown>;
};

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₸`;

// --------------------------------------------------------------------------
// Матчер согласия — раздел 6, пункт 4
// --------------------------------------------------------------------------

/**
 * ВНИМАНИЕ: `\b` в JavaScript опирается на `\w`, то есть на латиницу.
 * `/\bда\b/` по русскому тексту работает не так, как выглядит. Поэтому
 * текст разбирается на слова, а не матчится регулярками с границами.
 */
const AFFIRM = new Set([
  "да", "ага", "угу", "ок", "окей", "ok", "okay", "yes", "хорошо",
  "давай", "давайте", "добавь", "добавьте", "добавляй", "подтверждаю",
  "беру", "берем", "берём", "согласен", "согласна", "верно", "точно", "именно", "+",
  // қазақша
  "иә", "ия", "иа", "йә", "жарайды", "мақұл", "келісемін", "болады", "дұрыс",
  "қос", "қосыңыз", "қосыңызшы", "қосшы", "аламын", "алам",
]);

const NEGATE = new Set([
  "не", "нет", "нельзя", "отмена", "отмени", "отменить", "отставить",
  "стоп", "погоди", "подожди", "рано", "пока", "неа",
  // қазақша: «жоқ», «керек емес», «қоспа», «тоқта», «әлі» (пока)
  "жоқ", "емес", "қоспа", "қоспаңыз", "тоқта", "тоқтат", "әлі", "болдырма",
]);

/**
 * Условные слова и вопросительные частицы. Казахский вопрос часто
 * обходится без «?»: «қосуға бола ма» — частица «ма» делает его вопросом.
 */
const CONDITIONAL = new Set([
  "если", "когда", "вдруг", "может", "наверное",
  "егер", "мүмкін", "бәлкім", "ма", "ме", "ба", "бе", "па", "пе",
]);

/** Консервативно: сомнительное трактуем как отказ. */
export function isAffirmative(raw: string): boolean {
  const text = (raw || "").toLowerCase().trim();
  if (!text) return false;
  if (text.includes("?")) return false; // вопрос — не согласие

  // Казахские буквы (ә ғ қ ң ө ұ ү һ і) не входят в диапазон а-я. Без них
  // в классе символов «қос» разрезается на «ос», и согласие не узнаётся.

  const words = text.split(/[^a-zа-яёәғқңөұүһі0-9+]+/i).filter(Boolean);
  if (words.length === 0) return false;
  if (words.length > 12) return false; // длинная реплика — это не «да»

  if (words.some((w) => NEGATE.has(w))) return false;
  if (words.some((w) => CONDITIONAL.has(w))) return false;

  return words.some((w) => AFFIRM.has(w));
}

// --------------------------------------------------------------------------
// Схемы
// --------------------------------------------------------------------------

const SearchArgs = z.object({
  query: z.string().min(1).max(160),
  category: z.string().max(80).optional(),
});
const SkuArgs = z.object({ sku: z.string().min(1).max(60) });
const TermsArgs = z.object({ topic: z.enum(["payment", "delivery", "min_order", "pickup", "warranty", "returns", "contacts", "all"]) });
const ProposeArgs = z.object({
  sku: z.string().min(1).max(60),
  qty: z.number().int().min(1).max(999),
});
const ConfirmArgs = z.object({ proposalId: z.string().min(1).max(64) });
const NoArgs = z.object({}).passthrough();

// --------------------------------------------------------------------------
// Описания для модели
// --------------------------------------------------------------------------

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_catalog",
    description:
      "Найти товары в каталоге по свободному запросу. Возвращает до 5 позиций: артикул, название, цену, наличие. " +
      "Любые сведения о товарах бери только отсюда и из get_product. Не выдумывай артикулы.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "что ищет клиент: тип изделия, бренд, номинал" },
        category: { type: "string", description: "необязательное сужение по категории" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_product",
    description:
      "Полная карточка товара по артикулу: технические характеристики, сертификат, цена, остатки по складам. " +
      "Вызывай, когда клиент спрашивает про конкретную позицию, наличие, характеристики или сертификат.",
    parameters: {
      type: "object",
      properties: { sku: { type: "string", description: "артикул из search_catalog" } },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "find_alternatives",
    description:
      "Подобрать аналоги для позиции, которой нет в наличии. У каждого аналога есть поле reason — " +
      "готовое обоснование подбора. Обязательно перескажи его клиенту: почему предложен именно этот аналог.",
    parameters: {
      type: "object",
      properties: { sku: { type: "string", description: "артикул отсутствующей позиции" } },
      required: ["sku"],
      additionalProperties: false,
    },
  },
  {
    name: "get_terms",
    description: "Условия покупки с сайта ekt.kz: оплата, доставка, самовывоз, минимальная партия, гарантия, возврат, контакты менеджера.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["payment", "delivery", "min_order", "pickup", "warranty", "returns", "contacts", "all"] },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_add",
    description:
      "Предложить добавить товар в корзину. КОРЗИНУ НЕ МЕНЯЕТ. Возвращает proposalId. " +
      "Вызывай всегда, когда клиент выражает намерение купить. После вызова покажи клиенту " +
      "название, количество и цену и спроси подтверждение.",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string", description: "артикул" },
        qty: { type: "integer", description: "количество" },
      },
      required: ["sku", "qty"],
      additionalProperties: false,
    },
  },
  {
    name: "confirm_add",
    description:
      "Добавить в корзину по ранее выданному proposalId. Вызывай ТОЛЬКО если клиент в своей последней " +
      "реплике явно согласился («да», «добавь», «подтверждаю»). Сервер проверяет это независимо и " +
      "откажет, если согласия не было. Никогда не вызывай сразу после propose_add в том же ответе.",
    parameters: {
      type: "object",
      properties: { proposalId: { type: "string" } },
      required: ["proposalId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_cart",
    description: "Текущее содержимое корзины: позиции, количества, сумма.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "get_cart_link",
    description: "Прямая ссылка на страницу корзины с актуальным состоянием. Давай её после добавления товара.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

// --------------------------------------------------------------------------
// Представление товара для модели
// --------------------------------------------------------------------------

function brief(p: Product) {
  return {
    sku: p.sku,
    name: p.name,
    price: p.price,
    status: p.status,
    available: p.available,
  };
}

function full(p: Product) {
  return {
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    category: p.categoryTitle || p.category,
    price: p.price,
    status: p.status,
    available: p.available,
    minOrder: p.minOrder,
    // Характеристики — единственный источник чисел (раздел 12.2).
    specs: Object.fromEntries(Object.entries(p.specs).map(([k, v]) => [labelSpec(k), v])),
    stock: p.stock.filter((s) => s.qty > 0).map((s) => ({ склад: s.name, остаток: s.qty })),
    certificate: p.certificate
      ? { title: p.certificate.title, url: p.certificate.url, demo: p.certificate.demo }
      : null,
    url: p.url,
    // Описание даётся как текст и НЕ является источником характеристик.
    description_text_only: p.description?.slice(0, 600) ?? null,
  };
}

// --------------------------------------------------------------------------
// Исполнение
// --------------------------------------------------------------------------

async function runPropose(a: z.infer<typeof ProposeArgs>, ctx: ToolContext): Promise<ToolResult> {
  const p = await getProduct(a.sku);
  if (!p) {
    return { ok: false, data: { error: `артикул ${a.sku} не найден; сначала вызови search_catalog` }, summary: `нет такого артикула: ${a.sku}` };
  }
  if (p.available <= 0) {
    return {
      ok: false,
      data: { error: `«${p.name}» нет в наличии; предложи аналоги через find_alternatives`, sku: p.sku },
      summary: `${p.name}: нет в наличии`,
    };
  }

  const proposal = await createProposal(ctx.sessionId, [{ sku: p.sku, qty: a.qty }]);
  return {
    ok: true,
    data: {
      proposalId: proposal.id,
      sku: p.sku,
      name: p.name,
      qty: a.qty,
      price: p.price,
      lineTotal: p.price * Math.min(a.qty, p.available),
      available: p.available,
      minOrder: p.minOrder,
      note: a.qty > p.available
        ? `запрошено ${a.qty}, в наличии ${p.available} — при подтверждении добавится ${p.available}`
        : null,
      requires_confirmation: "корзина не изменена; нужен явный ответ клиента",
    },
    summary: `предложено: ${p.name} ×${a.qty} по ${money(p.price)} (ожидает подтверждения)`,
    // Данные для карточки подтверждения. proposalId здесь безопасен:
    // предложение привязано к сессии, одноразово, и сервер всё равно
    // проверяет его сам при вызове /api/confirm.
    client: {
      kind: "proposal",
      proposalId: proposal.id,
      sku: p.sku,
      name: p.name,
      qty: Math.min(a.qty, p.available),
      requestedQty: a.qty,
      price: p.price,
      lineTotal: p.price * Math.min(a.qty, p.available),
      available: p.available,
      minOrder: p.minOrder,
    },
  };
}

async function runConfirm(a: z.infer<typeof ConfirmArgs>, ctx: ToolContext): Promise<ToolResult> {
  const proposal = await getProposal(ctx.sessionId, a.proposalId);
  if (!proposal) {
    return { ok: false, data: { error: "предложение не найдено в этой сессии" }, summary: "предложение не найдено" };
  }

  // Защита 1: предложение должно быть создано в предыдущем ходу.
  // Иначе модель могла бы в одном ответе вызвать propose_add и сразу
  // confirm_add, подставив под проверку ту же реплику клиента.
  if (proposal.createdAt >= ctx.turnStartedAt) {
    return {
      ok: false,
      data: { error: "предложение только что создано. Сначала покажи его клиенту и дождись ответа — подтвердить в этом же ответе нельзя." },
      summary: "отказ: подтверждение в том же ходу",
    };
  }

  // Защита 2: согласие проверяется по сырой реплике клиента, а не по словам модели.
  if (!isAffirmative(ctx.lastUserMessage)) {
    return {
      ok: false,
      data: { error: "клиент не подтвердил добавление явно. Переспроси и дождись однозначного ответа." },
      summary: "отказ: явного согласия не было",
    };
  }

  const res = await consumeProposal(ctx.sessionId, a.proposalId);
  if (!res.ok) {
    const human: Record<string, string> = {
      NOT_FOUND: "предложение не найдено",
      ALREADY_USED: "это предложение уже использовано; создай новое через propose_add",
      NO_STOCK: "товара не осталось в наличии",
      PRODUCT_GONE: "товар пропал из каталога",
    };
    return { ok: false, data: { error: human[res.error] }, summary: human[res.error] };
  }

  const capped = res.lines.filter((l) => l.capped);
  const failed = res.lines.filter((l) => l.error);

  return {
    ok: true,
    data: {
      cart: res.cart,
      lines: res.lines,
      addedTotal: res.addedTotal,
      notes: [
        ...capped.map((l) => `${l.name}: запрошено ${l.requested}, добавлено ${l.added} — это весь остаток`),
        ...failed.map((l) => `${l.name}: не добавлено (${l.error === "NO_STOCK" ? "нет в наличии" : "нет в каталоге"})`),
      ],
      instruction: failed.length || capped.length
        ? "обязательно скажи клиенту, что добавилось не всё, и назови причины"
        : null,
    },
    summary: res.lines.length === 1
      ? `в корзину: ${res.lines[0].name} ×${res.lines[0].added}, итого ${money(res.cart.total)}`
      : `в корзину: ${res.addedTotal} шт. по ${res.lines.length} позициям, итого ${money(res.cart.total)}`,
  };
}

export type ToolOutcome =
  | { kind: "ok"; result: ToolResult }
  | { kind: "invalid_args"; message: string };

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { kind: "invalid_args", message: `аргументы не JSON: ${rawArgs.slice(0, 160)}` };
  }
  const describe = (issues: z.ZodIssue[]) =>
    issues.map((i) => `${i.path.join(".") || "(корень)"}: ${i.message}`).join("; ");

  switch (name) {
    case "search_catalog": {
      const v = SearchArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      // Ровно 5 — контракт раздела 5. Витрина ходит в БД отдельно.
      const items = await searchCatalog(v.data.query, v.data.category, 5);
      return {
        kind: "ok",
        result: {
          ok: true,
          data: { products: items.map(brief), count: items.length },
          summary: items.length ? `найдено ${items.length}: ${items.map((p) => p.sku).join(", ")}` : "ничего не найдено",
        },
      };
    }

    case "get_product": {
      const v = SkuArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      const p = await getProduct(v.data.sku);
      return {
        kind: "ok",
        result: p
          ? { ok: true, data: { product: full(p) }, summary: `${p.sku}: ${p.status === "in_stock" ? `в наличии ${p.available} шт.` : "нет в наличии"}` }
          : { ok: false, data: { error: `артикул ${v.data.sku} не найден` }, summary: "артикул не найден" },
      };
    }

    case "find_alternatives": {
      const v = SkuArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      const { base, items } = await findAlternatives(v.data.sku);
      if (!base) {
        return { kind: "ok", result: { ok: false, data: { error: `артикул ${v.data.sku} не найден` }, summary: "артикул не найден" } };
      }
      return {
        kind: "ok",
        result: {
          ok: items.length > 0,
          data: {
            base: brief(base),
            alternatives: items.map((a) => ({ ...brief(a), reason: a.reason })),
            instruction: "перескажи reason клиенту — обоснование подбора обязательно",
          },
          summary: items.length ? `аналогов: ${items.length} (${items.map((a) => a.sku).join(", ")})` : "аналогов не нашлось",
        },
      };
    }

    case "get_terms": {
      const v = TermsArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      const terms = getTerms(v.data.topic);
      return { kind: "ok", result: { ok: true, data: { terms }, summary: `условия: ${v.data.topic}` } };
    }

    case "propose_add": {
      const v = ProposeArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      return { kind: "ok", result: await runPropose(v.data, ctx) };
    }

    case "confirm_add": {
      const v = ConfirmArgs.safeParse(parsed);
      if (!v.success) return { kind: "invalid_args", message: describe(v.error.issues) };
      return { kind: "ok", result: await runConfirm(v.data, ctx) };
    }

    case "get_cart": {
      NoArgs.safeParse(parsed);
      const cart = await getCart(ctx.sessionId);
      return { kind: "ok", result: { ok: true, data: { cart }, summary: `в корзине ${cart.count} шт. на ${money(cart.total)}` } };
    }

    case "get_cart_link": {
      NoArgs.safeParse(parsed);
      const cart = await getCart(ctx.sessionId);
      const path = `/cart?session=${encodeURIComponent(ctx.sessionId)}`;
      const link = ctx.origin ? new URL(path, ctx.origin).href : path;
      return {
        kind: "ok",
        result: {
          ok: true,
          data: { url: link, itemsCount: cart.count, total: cart.total },
          summary: `ссылка на корзину (${cart.count} шт.)`,
        },
      };
    }

    default:
      return {
        kind: "invalid_args",
        message: `инструмента «${name}» нет. Доступны: ${TOOL_SPECS.map((t) => t.name).join(", ")}`,
      };
  }
}
