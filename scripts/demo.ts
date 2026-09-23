/**
 * Прогон демо-сценария через агентный цикл.
 *   npm run demo            — записанный режим, без сети
 *   npm run demo -- --live  — живая модель (нужен OPENAI_API_KEY)
 *
 * Отличие от smoke.ts: тот проверяет серверный контракт напрямую, а этот —
 * поведение модели. Здесь видно, те ли инструменты она зовёт и в каком
 * порядке. Заодно это репетиция защиты: те же пять реплик, что на кнопках.
 */

import { readFileSync } from "node:fs";

const live = process.argv.includes("--live");
/** Прогон на казахском: тот же сценарий плюс шестой шаг — эскалация. Имеет смысл только с --live. */
const kk = process.argv.includes("--kk");

const KK_SCRIPT = [
  "{SKU_IN} артикулы туралы айтыңыз: қоймада бар ма, сипаттамалары қандай, сертификаты бар ма?",
  "{SKU_OUT} бар ма? Жоқ болса, орнына не ұсынасыз және неге?",
  "Төлем және жеткізу шарттары қандай?",
  "{SKU_IN} себетке қосыңыз, 2 дана",
  "Иә, қосыңыз",
  "Нысанға 500 дана керек, жеңілдік бола ма? Менеджермен сөйлескім келеді.",
];
process.env.LLM_MODE = live ? "live" : "mock";
process.env.DB_URL = "file:./.data/demo.db";

/**
 * `.env.local` читает только Next — tsx о нём ничего не знает, и без
 * этого живой прогон падает с «ключ пуст», хотя ключ на месте.
 * Уже выставленные переменные не трогаем: строки выше заданы намеренно.
 */
function loadEnvLocal(file = ".env.local"): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvLocal();

import type { Msg } from "../src/lib/llm/types";

const G = "\x1b[32m", R = "\x1b[31m", C = "\x1b[36m", D = "\x1b[90m", B = "\x1b[1m", X = "\x1b[0m";

async function main() {
  const { runAgent } = await import("../src/lib/agent/loop");
  const DB = await import("../src/lib/db");
  const { fillDemoPrompts } = await import("../src/lib/agent/prompts");

  if (DB.CATALOG_SIZE === 0) {
    console.log(`${R}Каталог пуст. Сначала: npx tsx scripts/seed-from-api.ts${X}`);
    process.exit(1);
  }

  const sessionId = "demo-session";
  await DB.resetSession(sessionId);

  const { inStock, outOfStock } = await DB.pickDemoSkus();
  const script = kk
    ? KK_SCRIPT.map((t) => t.replace("{SKU_IN}", inStock || "—").replace("{SKU_OUT}", outOfStock || "—"))
    : fillDemoPrompts(inStock, outOfStock);
  const answers: string[] = [];

  console.log(`${B}Демо-сценарий — ИИ-ассистент ekt.kz${X}`);
  console.log(`${D}режим: ${live ? "живая модель" : "записанный"} · каталог: ${DB.CATALOG_SIZE} · артикулы: ${inStock} / ${outOfStock}${X}`);

  const history: Msg[] = [];
  const toolsPerStep: string[][] = [];
  let errors = 0;

  for (const message of script) {
    console.log(`\n${C}> ${message}${X}`);
    let answer = "";
    let delta: Msg[] | null = null;
    const called: string[] = [];

    for await (const ev of runAgent({ sessionId, history, message })) {
      switch (ev.type) {
        case "token": answer += ev.text; break;
        case "tool_call": called.push(ev.name); break;
        case "tool_result":
          console.log(`  ${ev.ok ? G + "✓" : R + "✗"}${X} ${D}${ev.name}: ${ev.summary} [${ev.ms} мс]${X}`);
          break;
        case "state":
          console.log(`  ${D}корзина: ${ev.cart.count} шт. / ${ev.cart.total.toLocaleString("ru-RU")} ₸${X}`);
          break;
        case "history": delta = ev.messages; break;
        case "error":
          console.log(`  ${R}ОШИБКА: ${ev.message}${X}`);
          errors++;
          break;
      }
    }

    toolsPerStep.push(called);
    answers.push(answer);
    console.log(`${answer.trim() || "(пустой ответ)"}`);
    if (delta) history.push(...delta);
  }

  // --- разбор: те ли инструменты и не нарушено ли правило подтверждения ---
  console.log(`\n${B}Разбор${X}`);
  const flat = toolsPerStep.flat();
  const ok = (label: string, cond: boolean, detail = "") => {
    if (!cond) errors++;
    console.log(`  ${cond ? G + "✓" : R + "✗"}${X} ${label}${detail ? ` ${D}${detail}${X}` : ""}`);
  };

  ok("шаг 1 запросил карточку товара", toolsPerStep[0]?.includes("get_product"), toolsPerStep[0]?.join(", "));
  ok("шаг 2 подобрал аналоги", toolsPerStep[1]?.includes("find_alternatives"), toolsPerStep[1]?.join(", "));
  ok("шаг 3 поднял условия покупки", toolsPerStep[2]?.includes("get_terms"), toolsPerStep[2]?.join(", "));
  ok("шаг 4 сделал предложение", toolsPerStep[3]?.includes("propose_add"), toolsPerStep[3]?.join(", "));
  ok("шаг 4 НЕ подтверждал сам", !toolsPerStep[3]?.includes("confirm_add"),
    toolsPerStep[3]?.includes("confirm_add") ? "нарушение правила раздела 6!" : "");
  ok("шаг 5 подтвердил добавление", toolsPerStep[4]?.includes("confirm_add"), toolsPerStep[4]?.join(", "));

  if (kk) {
    // Казахские буквы, которых нет в русском: признак, что ответ не на русском.
    const kazakh = (t: string) => /[әғқңөұүһі]/i.test(t);
    const inKazakh = answers.filter(kazakh).length;
    ok("ответы на казахском", inKazakh >= answers.length - 1, `${inKazakh} из ${answers.length}`);
    ok("шаг 6 дал контакты менеджера", toolsPerStep[5]?.includes("get_terms") && /\+7/.test(answers[5] ?? ""),
      toolsPerStep[5]?.join(", "));
    ok("шаг 6 ничего не добавил в корзину", !toolsPerStep[5]?.includes("confirm_add"));
  }

  const cart = await DB.getCart(sessionId);
  ok("корзина непуста в конце", cart.count > 0, `${cart.count} шт.`);
  // Проверяем сам ответ, а не факт вызова: ссылка приходит и в confirm_add.
  const linkAnswer = answers[4] ?? "";
  ok("ссылка на корзину выдана", linkAnswer.includes("/cart?c="), linkAnswer.match(/\S*\/cart\S*/)?.[0] ?? "нет ссылки");
  ok("ссылка не выдуманная", !/ekt\.kz\/(cart|basket|personal)/i.test(answers.join(" ")));

  console.log(
    errors === 0
      ? `\n${G}${B}Сценарий отработал целиком.${X}`
      : `\n${R}${B}Замечаний: ${errors}.${X}`,
  );
  process.exit(errors === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`${R}Демо упало:${X}`, e);
  process.exit(1);
});
