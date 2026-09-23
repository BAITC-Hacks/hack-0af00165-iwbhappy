"use client";

import { useState } from "react";
import type { Cart } from "@/lib/db";

type Props = { cart: Cart; flashSkus: string[]; sessionId: string };
const money = (value: number) => `${value.toLocaleString("ru-RU")} ₸`;

export default function CartPanel({ cart, flashSkus, sessionId }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <section className={`cart-panel ${open ? "mobile-open" : ""}`}>
      <button type="button" className="cart-panel-heading" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><span className="cart-icon" aria-hidden="true">К</span><span><strong>Корзина</strong><small>{cart.count > 0 ? `${cart.count} шт.` : "пока пусто"}</small></span></span>
        <span className="cart-heading-total">{money(cart.total)}</span>
      </button>
      <div className="cart-panel-body">
        {cart.lines.length === 0 ? (
          <div className="empty-cart"><span>＋</span><strong>В корзине пока ничего нет</strong><p>Попросите агента добавить товар и подтвердите действие.</p></div>
        ) : (
          <div className="cart-lines">{cart.lines.map((line) => (
            <div className={`cart-line ${flashSkus.includes(line.sku) ? "flash" : ""}`} key={line.sku}>
              <div><strong>{line.name}</strong><span>{line.sku} · {money(line.price)} × {line.qty}</span></div><b>{money(line.lineTotal)}</b>
            </div>
          ))}</div>
        )}
        <div className="cart-total-row"><span>Итого</span><strong>{money(cart.total)}</strong></div>
        <a className={`cart-link ${cart.lines.length === 0 || !sessionId ? "disabled" : ""}`} href={sessionId ? `/cart?session=${encodeURIComponent(sessionId)}` : "#"} aria-disabled={cart.lines.length === 0 || !sessionId} onClick={(event) => { if (cart.lines.length === 0 || !sessionId) event.preventDefault(); }}>Открыть страницу корзины</a>
        <p className="cart-note">Заказ здесь не оформляется. Финальное решение остаётся за клиентом.</p>
      </div>
    </section>
  );
}
