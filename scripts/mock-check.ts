import assert from "node:assert/strict";
import type { Msg } from "../src/lib/llm/types";

// Конфиг читается при импорте: окружение обязательно выставляем раньше.
process.env.LLM_MODE = "mock";
process.env.DB_URL = "file:./.data/mock-check.db";
process.env.DB_AUTH_TOKEN = "";
process.env.TURSO_AUTH_TOKEN = "";

async function main() {
  const { runAgent } = await import("../src/lib/agent/loop");
  const db = await import("../src/lib/db");
  const sessionId = "mock-check-session";
  const history: Msg[] = [];
  let checks = 0;
  await db.resetSession(sessionId);

  async function ask(message: string, expected: string[]) {
    const called: string[] = [];
    const args: Record<string, unknown>[] = [];
    let answer = "";
    let completed = false;
    for await (const event of runAgent({ sessionId, history, message })) {
      if (event.type === "error") assert.fail(event.message);
      if (event.type === "tool_call") {
        called.push(event.name);
        args.push(event.args as Record<string, unknown>);
      }
      if (event.type === "tool_result") assert.equal(event.ok, true, `${message}: ${event.summary}`);
      if (event.type === "token") answer += event.text;
      if (event.type === "history") history.push(...event.messages);
      if (event.type === "done") {
        assert.equal(event.source, "mock");
        completed = true;
      }
    }
    assert.ok(completed && answer.trim(), `Нет ответа на: ${message}`);
    assert.deepEqual(called, expected, message);
    console.log(`✓ ${message} → ${called.join(" → ") || "без инструментов"}`);
    checks++;
    return { answer, args };
  }

  try {
    // Сначала карточка: следующие свободные запросы не должны залипнуть на ней.
    await ask("R9F12110 есть?", ["get_product"]);
    await ask("найди автоматический выключатель на 16А", ["search_catalog"]);
    await ask("есть УЗО?", ["search_catalog"]);
    const manager = await ask("как связаться с менеджером?", ["get_terms"]);
    assert.match(manager.answer, /\+7/);
    assert.equal(manager.args[0].topic, "contacts");
    const delivery = await ask("сколько стоит доставка?", ["get_terms"]);
    assert.equal(delivery.args[0].topic, "delivery");
    for (const [message, topic] of [
      ["Как оплатить?", "payment"], ["Самовывоз есть?", "pickup"],
      ["Какая гарантия?", "warranty"], ["Как сделать возврат?", "returns"],
      ["Минимальная партия?", "min_order"], ["Төлем және жеткізу", "all"],
    ]) {
      const result = await ask(message, ["get_terms"]);
      assert.equal(result.args[0].topic, topic);
    }
    const proposal = await ask("добавь R9F12110, 2 штуки", ["propose_add"]);
    assert.equal(proposal.args[0].qty, 2);
    assert.equal((await db.getCart(sessionId)).count, 0, "Предложение не меняет корзину");
    const confirmed = await ask("иә, қосыңыз", ["confirm_add"]);
    assert.match(confirmed.answer, /Қосылды/);
    assert.match(confirmed.answer, /\/cart\?c=/);
    const cart = await db.getCart(sessionId);
    assert.equal(cart.count, 2);
    await ask("иә", ["search_catalog"]); // использованное предложение не подтверждается снова

    const named = await ask("добавь клеммы WAGO", ["search_catalog", "propose_add"]);
    assert.equal(named.args[0].query, "клеммы WAGO");
    assert.deepEqual(await db.getCart(sessionId), cart);
    // Новая просьба при висящем предложении — не согласие на старый товар.
    await ask("добавь R9F12110, 1 штуку", ["propose_add"]);
    assert.deepEqual(await db.getCart(sessionId), cart);
    await ask("нет, не надо", []);
    await ask("да", ["search_catalog"]); // отказ помним и в следующем ходу
    assert.deepEqual(await db.getCart(sessionId), cart);

    const { outOfStock } = await db.pickDemoSkus();
    assert.ok(outOfStock);
    await ask(`А ${outOfStock} есть?`, ["get_product", "find_alternatives"]);
    await ask("Какие аналоги?", ["find_alternatives"]);
    const dimensions = await ask("добавь УПп 60/40.1.1 со стыковочными узлами и винтами", ["search_catalog", "propose_add"]);
    assert.match(String(dimensions.args[0].query), /60\/40\.1\.1/);
    assert.notEqual(dimensions.args[1].sku, "60/40.1.1");
    assert.equal(dimensions.args[1].qty, 1, "Размер изделия не становится количеством");
    const declined = await ask("жоқ, керек емес", []);
    assert.match(declined.answer, /қоспаймын/);
    assert.deepEqual(await db.getCart(sessionId), cart);
    console.log(`\nMock: ${checks} сценария пройдены, внешняя модель не использовалась.`);
  } finally {
    await db.resetSession(sessionId);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
