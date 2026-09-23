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

process.env.DB_URL ??= "file:./.data/smoke.db";

import { executeTool, isAffirmative, type ToolContext } from "../src/lib/agent/tools";
import { CATALOG_SIZE, getCart, pickDemoSkus, resetSession } from "../src/lib/db";

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
  const out = await executeTool(name, JSON.stringify(args), c);
  if (out.kind === "invalid_args") {
    return { ok: false, data: { error: out.message } as Record<string, unknown>, summary: out.message };
  }
  return out.result;
}

const laterThan = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

async function main() {
  console.log(`${B}Приёмочные тесты — ИИ-ассистент ekt.kz${X}`);
  console.log(`${D}каталог: ${CATALOG_SIZE} позиций${X}\n`);

  if (CATALOG_SIZE === 0) {
    console.log(`${R}Каталог пуст. Сначала выгрузите его:${X}`);
    console.log(`  npx tsx scripts/seed-from-api.ts`);
    process.exit(1);
  }

  await resetSession(SESSION);
  const { inStock, outOfStock } = await pickDemoSkus();
  console.log(`${D}демо-артикулы: в наличии ${inStock || "—"}, без остатка ${outOfStock || "—"}${X}\n`);

  // ---- 0. Матчер согласия ------------------------------------------------
  console.log(`${B}0. Матчер согласия (основа правила подтверждения)${X}`);
  for (const [text, expected] of [
    ["да", true], ["да, добавь", true], ["добавь", true], ["подтверждаю", true],
    ["ок", true], ["беру", true],
    ["нет", false], ["не надо", false], ["пока не надо", false], ["отмени", false],
    ["а можно добавить?", false], ["если есть на складе, добавь", false],
    ["", false], ["расскажи про характеристики", false],
  ] as Array<[string, boolean]>) {
    check(`«${text || "(пусто)"}» → ${expected ? "согласие" : "не согласие"}`, isAffirmative(text) === expected);
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

  // ---- 4. Правило подтверждения — главное ---------------------------------
  console.log(`\n${B}4. Правило подтверждения${X}`);

  const turnA = new Date().toISOString();
  const proposal = await call("propose_add", { sku: inStock, qty: 2 }, ctx("добавь 2 штуки", turnA));
  const proposalId = String(proposal.data.proposalId ?? "");
  check("propose_add выдал предложение", proposal.ok && proposalId.length > 0);
  check("корзина НЕ изменилась после предложения", (await getCart(SESSION)).count === 0);

  // 4a. Подтверждение в том же ходу — должно быть отклонено.
  const sameTurn = await call("confirm_add", { proposalId }, ctx("добавь 2 штуки", turnA));
  check("confirm_add в том же ходу отклонён", !sameTurn.ok, String(sameTurn.summary));
  check("корзина всё ещё пуста", (await getCart(SESSION)).count === 0);

  // 4b. Следующий ход, но без согласия — тоже отклонён.
  const turnB = laterThan(turnA, 1000);
  const noConsent = await call("confirm_add", { proposalId }, ctx("а сколько это будет стоить?", turnB));
  check("confirm_add без явного согласия отклонён", !noConsent.ok, String(noConsent.summary));
  check("корзина всё ещё пуста", (await getCart(SESSION)).count === 0);

  // 4c. Следующий ход и явное «да» — добавляется.
  const turnC = laterThan(turnA, 2000);
  const confirmed = await call("confirm_add", { proposalId }, ctx("да, добавь", turnC));
  check("confirm_add с явным согласием прошёл", confirmed.ok, String(confirmed.summary));

  const cart = await getCart(SESSION);
  check("позиция появилась в корзине", cart.count > 0, `${cart.count} шт.`);

  const prodCard = await call("get_product", { sku: inStock }, ctx("проверка", turnC));
  const availableQty = Number((prodCard.data.product as Record<string, unknown>)?.available ?? 0);
  check("количество не превышает остаток", cart.count <= availableQty, `${cart.count} ≤ ${availableQty}`);

  // 4d. Повторное использование того же предложения — отклонено.
  const reuse = await call("confirm_add", { proposalId }, ctx("да, добавь", laterThan(turnA, 3000)));
  check("повторное подтверждение отклонено", !reuse.ok, String(reuse.summary));
  check("корзина не выросла от повтора", (await getCart(SESSION)).count === cart.count);

  // ---- 5. Ссылка на корзину ----------------------------------------------
  console.log(`\n${B}5. Ссылка на корзину${X}`);
  const link = await call("get_cart_link", {}, ctx("дай ссылку", laterThan(turnA, 4000)));
  const url = String(link.data.url ?? "");
  check("ссылка выдана", link.ok && url.length > 0, url);
  check("ссылка отражает актуальную корзину", Number(link.data.itemsCount) === cart.count);

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
