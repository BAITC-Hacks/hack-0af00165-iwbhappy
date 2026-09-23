import { getCart, type Cart } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_CART: Cart = { lines: [], total: 0, count: 0 };
const money = (value: number) => `${value.toLocaleString("ru-RU")} ₸`;

export default async function CartPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const { session = "" } = await searchParams;
  const sessionId = session.trim();
  const cart = sessionId ? await getCart(sessionId) : EMPTY_CART;

  return (
    <main className="cart-page">
      <a className="back-link" href="/">← Вернуться к витрине и чату</a>
      <section className="cart-page-card">
        <div className="cart-page-heading"><div><span className="eyebrow">Актуальное состояние</span><h1>Корзина</h1></div><span className="cart-page-count">{cart.count} шт.</span></div>
        {!sessionId ? <div className="cart-page-empty">Ссылка не содержит идентификатор сессии. Вернитесь в чат и запросите новую ссылку.</div> : cart.lines.length === 0 ? <div className="cart-page-empty">Корзина этой сессии пуста.</div> : (
          <div className="cart-page-lines">{cart.lines.map((line) => (
            <div className="cart-page-line" key={line.sku}><div><strong>{line.name}</strong><span>Артикул {line.sku}</span></div><span>{money(line.price)}</span><span>{line.qty} шт.</span><b>{money(line.lineTotal)}</b></div>
          ))}</div>
        )}
        <div className="cart-page-total"><span>Итого</span><strong>{money(cart.total)}</strong></div>
        <div className="cart-page-info">Это финальная точка сценария помощника. Оформление заказа и ввод платёжных данных здесь недоступны.</div>
      </section>
    </main>
  );
}
