/**
 * Приёмочные тесты раздела 9 AGENTS.md.
 *   npm run smoke
 *
 * Гоняет инструменты напрямую, без модели. Это сознательно: жюри будет
 * проверять серверный контракт, а не удачу конкретной генерации. Если
 * тест здесь зелёный — правило подтверждения держится независимо от того,
 * что придумает модель.
 *
 * Поведение самой модели проверяется руками в интерфейсе.
 */

// ВНИМАНИЕ: в ESM импорты поднимаются выше тела модуля. Обычный
// `process.env.DB_URL = ...` в начале файла выполнится УЖЕ ПОСЛЕ того,
// как db.ts прочитает конфиг, и смоук молча уедет на рабочую базу.
// Поэтому переменные ставятся здесь, а модули подгружаются динамически.
process.env.DB_URL = process.env.SMOKE_DB_URL ?? "file:./.data/smoke.db";

import type { ToolContext } from "../src/lib/agent/tools";

// tsx собирает этот скрипт в CJS, где top-level await недоступен,
// поэтому модули подгружаются в начале main().
type ToolsModule = typeof import("../src/lib/agent/tools");
type DbModule = typeof import("../src/lib/db");

let T: ToolsModule;
let DB: DbModule;

const SESSION = "smoke-session";
let failures = 0;
let checks = 0;

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", B = "\x1b[1m", X = "\x1b[0m";

function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? G + "✓" : R + "✗"}${X} ${label}${detail ? ` ${D}${detail}${X}` : ""}`);
}

function ctx(lastUserMessage: string, turnStartedAt: string): ToolContext {
  return { sessionId: SESSION, lastUserMessage, turnStartedAt };
}

/** Вызов инструмента с разбором результата. */
async function call(name: string, args: Record<string, unknown>, c: ToolContext) {
  const out = await T.executeTool(name, JSON.stringify(args), c);
  if (out.kind === "invalid_args") {
    return { ok: false, data: { error: out.message } as Record<string, unknown>, summary: out.message };
  }
  return out.result;
}

const laterThan = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

async function main() {
  T = await import("../src/lib/agent/tools");
  DB = await import("../src/lib/db");

  console.log(`${B}Приёмочные тесты — ИИ-ассистент ekt.kz${X}`);
  console.log(`${D}каталог: ${DB.CATALOG_SIZE} позиций${X}\n`);

  if (DB.CATALOG_SIZE === 0) {
    console.log(`${R}Каталог пуст. Сначала выгрузите его:${X}`);
    console.log(`  npx tsx scripts/seed-from-api.ts`);
    process.exit(1);
  }

  await DB.resetSession(SESSION);
  const { inStock, outOfStock } = await DB.pickDemoSkus();
  console.log(`${D}демо-артикулы: в наличии ${inStock || "—"}, без остатка ${outOfStock || "—"}${X}\n`);

  // ---- 0. Матчер согласия ------------------------------------------------
  console.log(`${B}0. Матчер согласия (основа правила подтверждения)${X}`);
  for (const [text, expected] of [
    ["да", true], ["да, добавь", true], ["добавь", true], ["подтверждаю", true],
    ["ок", true], ["беру", true],
    ["нет", false], ["не надо", false], ["пока не надо", false], ["отмени", false],
    ["а можно добавить?", false], ["если есть на складе, добавь", false],
    ["", false], ["расскажи про характеристики", false],
    // қазақша: без казахских букв в классе символов «қос» режется на «ос»
    ["иә", true], ["иә, қосыңыз", true], ["жарайды", true], ["келісемін", true],
    ["жоқ", false], ["керек емес", false], ["қоспаңыз", false],
    ["себетке қосуға бола ма", false], ["егер қоймада бар болса, қос", false],
  ] as Array<[string, boolean]>) {
    check(`«${text || "(пусто)"}» → ${expected ? "согласие" : "не согласие"}`, T.isAffirmative(text) === expected);
  }

  // ---- 1. Артикул: наличие, характеристики, сертификат --------------------
  console.log(`\n${B}1. Запрос по существующему артикулу${X}`);
  const t1 = new Date().toISOString();
  const prod = await call("get_product", { sku: inStock }, ctx("что по этому артикулу?", t1));
  const card = (prod.data.product ?? {}) as Record<string, unknown>;
  check("карточка получена", prod.ok, String(card.name ?? ""));
  check("есть данные о наличии", typeof card.available === "number");
  check("есть технические характеристики", Object.keys((card.specs ?? {}) as object).length > 0,
    Object.keys((card.specs ?? {}) as object).slice(0, 3).join(", "));
  check("склады перечислены", Array.isArray(card.stock));
  if (card.certificate) {
    const c = card.certificate as Record<string, unknown>;
    check("сертификат помечен как демонстрационный", c.demo === true);
  } else {
    console.log(`  ${D}у этой позиции сертификата нет — допустимо${X}`);
  }

  // ---- 2. Нулевой остаток -> аналог с обоснованием ------------------------
  console.log(`\n${B}2. Позиция с нулевым остатком → аналоги${X}`);
  if (!outOfStock) {
    check("в каталоге есть позиция без остатка", false, "не нашлось — проверьте выгрузку");
  } else {
    const t2 = new Date().toISOString();
    const alt = await call("find_alternatives", { sku: outOfStock }, ctx("а что взамен?", t2));
    const items = (alt.data.alternatives ?? []) as Array<Record<string, unknown>>;
    check("аналог найден хотя бы один", items.length > 0, `${items.length} шт.`);
    check("у каждого аналога есть обоснование",
      items.length > 0 && items.every((a) => typeof a.reason === "string" && a.reason.length > 10));
    check("все аналоги в наличии", items.every((a) => Number(a.available) > 0));
    if (items[0]) console.log(`  ${D}${items[0].sku}: ${items[0].reason}${X}`);
  }

  // ---- 3. Условия покупки -------------------------------------------------
  console.log(`\n${B}3. Условия покупки${X}`);
  const t3 = new Date().toISOString();
  const terms = await call("get_terms", { topic: "delivery" }, ctx("как с доставкой?", t3));
  const list = (terms.data.terms ?? []) as Array<Record<string, unknown>>;
  check("условия получены", terms.ok && list.length > 0);
  check("ответ содержательный (>40 символов)", String(list[0]?.text ?? "").length > 40,
    String(list[0]?.text ?? "").slice(0, 60) + "…");
  const contacts = await call("get_terms", { topic: "contacts" }, ctx("как связаться с менеджером?", t3));
  const cText = String(((contacts.data.terms ?? []) as Array<Record<string, unknown>>)[0]?.text ?? "");
  check("эскалация: есть контакты менеджера", contacts.ok && /\+7/.test(cText) && /@ekt\.kz/.test(cText));

  // ---- 4. Правило подтверждения — главное ---------------------------------
  console.log(`\n${B}4. Правило подтверждения${X}`);

  const turnA = new Date().toISOString();
  const proposal = await call("propose_add", { sku: inStock, qty: 2 }, ctx("добавь 2 штуки", turnA));
  const proposalId = String(proposal.data.proposalId ?? "");
  check("propose_add выдал предложение", proposal.ok && proposalId.length > 0);
  check("корзина НЕ изменилась после предложения", (await DB.getCart(SESSION)).count === 0);

  // 4a. Подтверждение в том же ходу — должно быть отклонено.
  const sameTurn = await call("confirm_add", { proposalId }, ctx("добавь 2 штуки", turnA));
  check("confirm_add в том же ходу отклонён", !sameTurn.ok, String(sameTurn.summary));
  check("корзина всё ещё пуста", (await DB.getCart(SESSION)).count === 0);

  // 4b. Следующий ход, но без согласия — тоже отклонён.
  const turnB = laterThan(turnA, 1000);
  const noConsent = await call("confirm_add", { proposalId }, ctx("а сколько это будет стоить?", turnB));
  check("confirm_add без явного согласия отклонён", !noConsent.ok, String(noConsent.summary));
  check("корзина всё ещё пуста", (await DB.getCart(SESSION)).count === 0);

  // 4c. Следующий ход и явное «да» — добавляется.
  const turnC = laterThan(turnA, 2000);
  const confirmed = await call("confirm_add", { proposalId }, ctx("да, добавь", turnC));
  check("confirm_add с явным согласием прошёл", confirmed.ok, String(confirmed.summary));

  const cart = await DB.getCart(SESSION);
  check("позиция появилась в корзине", cart.count > 0, `${cart.count} шт.`);

  const prodCard = await call("get_product", { sku: inStock }, ctx("проверка", turnC));
  const availableQty = Number((prodCard.data.product as Record<string, unknown>)?.available ?? 0);
  check("количество не превышает остаток", cart.count <= availableQty, `${cart.count} ≤ ${availableQty}`);

  // 4d. Повторное использование того же предложения — отклонено.
  const reuse = await call("confirm_add", { proposalId }, ctx("да, добавь", laterThan(turnA, 3000)));
  check("повторное подтверждение отклонено", !reuse.ok, String(reuse.summary));
  check("корзина не выросла от повтора", (await DB.getCart(SESSION)).count === cart.count);

  // ---- 5. Ссылка на корзину ----------------------------------------------
  console.log(`\n${B}5. Ссылка на корзину${X}`);
  const link = await call("get_cart_link", {}, ctx("дай ссылку", laterThan(turnA, 4000)));
  const url = String(link.data.url ?? "");
  check("ссылка выдана", link.ok && url.length > 0, url);
  check("ссылка отражает актуальную корзину", Number(link.data.itemsCount) === cart.count);
  const full = await call("get_cart_link", {}, { ...ctx("дай ссылку", laterThan(turnA, 4000)), origin: "https://hackalem10.vercel.app" });
  const fullUrl = String(full.data.url ?? "");
  check("ссылка полная, с адресом приложения — модели нечего достраивать",
    fullUrl.startsWith("https://hackalem10.vercel.app/cart?c="), fullUrl);

  // ТЗ §9: защита от несанкционированного изменения корзины. sessionId —
  // ключ, которым через чат меняют корзину; ссылкой клиент делится.
  check("в ссылке на корзину нет sessionId", !url.includes(SESSION) && !fullUrl.includes(SESSION));
  const token = new URL(fullUrl).searchParams.get("c") ?? "";
  check("токен ссылки открывает именно эту корзину", (await DB.getSessionByCartToken(token)) === SESSION);
  check("выдуманный токен ничего не открывает",
    (await DB.getSessionByCartToken("00000000-0000-0000-0000-000000000000")) === null
      && (await DB.getSessionByCartToken("' OR 1=1 --")) === null);
  check("ссылка стабильна между вызовами",
    String((await call("get_cart_link", {}, ctx("ссылку", laterThan(turnA, 4000)))).data.url) === url);

  // ---- 5б. Сопутствующие товары и чистота аналогов --------------------------
  console.log(`
${B}5б. Сопутствующие товары${X}`);
  {
    // Ищем позицию, у которой рекомендация партнёра разрешается в товар в наличии.
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync("data/catalog.json", "utf8"));
    const rows = (Array.isArray(raw) ? raw : raw.products) as Array<{ sku: string; alternatives?: unknown[] }>;
    let baseSku = "";
    for (const r of rows) {
      if (!r.alternatives?.length) continue;
      const rel = await DB.findRelated(r.sku);
      if (rel.items.length) { baseSku = r.sku; break; }
    }
    check("в каталоге есть позиция с сопутствующими в наличии", baseSku !== "", baseSku);
    if (baseSku) {
      const rel = await call("find_related", { sku: baseSku }, ctx("что ещё к нему нужно", t3));
      const items = (rel.data.related ?? []) as Array<Record<string, unknown>>;
      check("сопутствующие выданы с обоснованием",
        rel.ok && items.length > 0 && items.every((i) => String(i.reason).includes("ekt.kz")),
        items.map((i) => i.sku).join(", "));
      check("сопутствующие все в наличии", items.every((i) => Number(i.available) > 0));

      const base = await DB.getProduct(baseSku);
      const alts = await DB.findAlternatives(baseSku);
      const relatedSkus = new Set(items.map((i) => String(i.sku)));
      check("сопутствующий товар из другого раздела не выдаётся за аналог",
        alts.items.every((a) => !relatedSkus.has(a.sku) || a.category === base?.category),
        alts.items.map((a) => a.sku).join(", "));
    }
  }

  // ---- 5в. Платёжные и персональные данные --------------------------------
  console.log(`
${B}5в. Приватность: платёжные данные не хранятся${X}`);
  {
    const R = await import("../src/lib/redact");
    const card = "4111 1111 1111 1111";
    check("номер карты вырезается", !R.redactPayment(`моя карта ${card}`).includes("4111"));
    check("карта без пробелов тоже", !R.redactPayment("4111111111111111 оплачу").includes("4111"));
    check("CVV вырезается", !R.redactPayment("cvv 123").includes("123"));
    check("IBAN вырезается", !R.redactPayment("счёт KZ86125KZT5004100100").includes("5004100100"));
    // Главный риск маскирования — испортить артикул и сломать поиск.
    const skus = (await DB.searchCatalog("", undefined, 300)).map((p) => p.sku);
    const broken = skus.filter((k) => R.redactPayment(`добавь ${k}`) !== `добавь ${k}`);
    check("ни один артикул каталога не маскируется", broken.length === 0, broken.slice(0, 3).join(", "));
    check("количество и цена не маскируются", R.redactPayment("2 штуки по 4 590 ₸") === "2 штуки по 4 590 ₸");
    check("в журнал не попадают телефон и email",
      !/7012345678|test@mail/.test(R.redactForLog("звоните +7 701 234 56 78, test@mail.kz")));
    check("телефон модели остаётся — он нужен менеджеру",
      R.redactPayment("+7 701 234 56 78").includes("701"));
  }

  // ---- 5а. Язык ответа определяет сервер -----------------------------------
  console.log(`
${B}5а. Язык ответа${X}`);
  const { detectLang } = await import("../src/lib/agent/loop");
  const kkHistory = [{ role: "user" as const, content: "Сәлеметсіз бе, автомат керек" }];
  for (const [text, hist, expected] of [
    ["Иә, қосыңыз", [], "kk"],
    ["Да, добавь", [], "ru"],
    ["R9F12110", kkHistory, "kk"],
    ["2", kkHistory, "kk"],
    ["R9F12110", [], "ru"],
    ["а по-русски можно?", kkHistory, "ru"],
  ] as Array<[string, typeof kkHistory, "kk" | "ru"]>) {
    check(`«${text}»${hist.length ? " после казахской реплики" : ""} → ${expected}`, detectLang(text, hist) === expected);
  }

  // ---- 6. Спецификация из файла -------------------------------------------
  console.log(`
${B}6. Спецификация: несколько позиций, одно подтверждение${X}`);

  const pool = (await DB.searchCatalog("", undefined, 40)).filter((p) => p.available >= 2);
  if (pool.length < 2) {
    check("в каталоге хватает позиций для спецификации", false, `нашлось ${pool.length}`);
  } else {
    const [a, b] = pool;
    const spec = await DB.matchSpecRows([
      { article: ` ${a.sku} `, qty: 1 },          // с лишними пробелами
      { article: b.sku.toLowerCase(), qty: 2 },   // в другом регистре
      { article: "НЕСУЩЕСТВУЮЩИЙ-999", qty: 5 },
    ]);
    check("распознаны обе позиции несмотря на пробелы и регистр", spec.matched.length === 2,
      spec.matched.map((m) => m.sku).join(", "));
    check("несуществующий артикул честно помечен нераспознанным", spec.unmatched.length === 1,
      spec.unmatched.map((u) => u.article).join(", "));

    const before = (await DB.getCart(SESSION)).count;
    const batch = await DB.createProposal(SESSION, spec.matched.map((m) => ({ sku: m.sku, qty: m.qty })));
    check("предложение на спецификацию создано", batch.items.length === 2);
    check("корзина не изменилась после предложения", (await DB.getCart(SESSION)).count === before);

    const turnS = new Date().toISOString();
    const noYes = await call("confirm_add", { proposalId: batch.id }, ctx("сколько это будет стоить?", laterThan(turnS, 1000)));
    check("спецификация без согласия не добавляется", !noYes.ok, String(noYes.summary));
    check("корзина всё ещё прежняя", (await DB.getCart(SESSION)).count === before);

    const yes = await call("confirm_add", { proposalId: batch.id }, ctx("да, добавь", laterThan(turnS, 2000)));
    check("спецификация добавлена одним подтверждением", yes.ok, String(yes.summary));
    const after = await DB.getCart(SESSION);
    check("в корзине прибавилось обе позиции", after.count >= before + 3, `${before} -> ${after.count}`);

    const again = await call("confirm_add", { proposalId: batch.id }, ctx("да, добавь", laterThan(turnS, 3000)));
    check("повторное подтверждение спецификации отклонено", !again.ok);
  }

  // ---- Итог ---------------------------------------------------------------
  console.log(
    failures === 0
      ? `\n${G}${B}Все приёмочные тесты пройдены (${checks} проверок).${X}`
      : `\n${R}${B}Провалено ${failures} из ${checks} проверок.${X}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`${R}Смоук упал:${X}`, e);
  process.exit(1);
});
