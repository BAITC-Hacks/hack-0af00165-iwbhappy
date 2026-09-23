/**
 * Прогон всего сценария без браузера и без сети.
 *   npm run smoke
 *
 * Проверяет связку БД -> инструменты -> агентный цикл на четырёх репликах:
 * подбор, сравнение, заказ, возврат. Запускать после каждой правки
 * инструментов — это десять секунд против пяти минут кликанья в UI.
 */

process.env.LLM_MODE ??= "mock";
process.env.DB_URL ??= "file:./.data/smoke.db";

import { runAgent } from "../src/lib/agent/loop";
import { DEMO_PROMPTS } from "../src/lib/agent/prompts";
import { resetSession } from "../src/lib/db";
import type { Msg } from "../src/lib/llm/types";

// Ровно те фразы, что стоят на демо-кнопках: смоук проверяет сценарий защиты,
// а не абстрактный happy path.
const SCRIPT = DEMO_PROMPTS;

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₸`;

async function main() {
  const sessionId = "smoke-session";
  await resetSession(sessionId);

  const history: Msg[] = [];
  let failures = 0;

  for (const message of SCRIPT) {
    console.log(`\n\x1b[36m> ${message}\x1b[0m`);

    let answer = "";
    let tools = 0;
    let delta: Msg[] | null = null;

    for await (const ev of runAgent({ sessionId, history, message })) {
      switch (ev.type) {
        case "token":
          answer += ev.text;
          break;
        case "tool_call":
          tools++;
          console.log(`  \x1b[90m→ ${ev.name}(${JSON.stringify(ev.args)})\x1b[0m`);
          break;
        case "tool_result":
          console.log(`  ${ev.ok ? "\x1b[32m✓" : "\x1b[31m✗"} ${ev.summary} \x1b[90m[${ev.ms} мс]\x1b[0m`);
          if (!ev.ok) failures++;
          break;
        case "state":
          console.log(
            `  \x1b[90mкорзина: ${ev.cart.count} шт. / ${money(ev.cart.total)} · заказов: ${ev.orders.length}` +
              `${ev.orders[0] ? ` (${ev.orders[0].id}: ${ev.orders[0].status})` : ""}\x1b[0m`,
          );
          break;
        case "error":
          console.log(`  \x1b[31mОШИБКА: ${ev.message}\x1b[0m`);
          failures++;
          break;
        case "history":
          delta = ev.messages;
          break;
        case "done":
          console.log(`  \x1b[90m${ev.steps} шаг(ов), ${ev.ms} мс, источник: ${ev.source}\x1b[0m`);
          break;
      }
    }

    console.log(`\x1b[1m${answer.trim() || "(пустой ответ)"}\x1b[0m`);
    if (tools === 0) console.log("  \x1b[33m! ни одного вызова инструмента\x1b[0m");

    if (delta) history.push(...delta);
    else {
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: answer });
    }
  }

  console.log(
    failures === 0
      ? "\n\x1b[32mСценарий пройден целиком.\x1b[0m"
      : `\n\x1b[31mПроблем: ${failures}.\x1b[0m`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\x1b[31mСмоук упал:\x1b[0m", e);
  process.exit(1);
});
