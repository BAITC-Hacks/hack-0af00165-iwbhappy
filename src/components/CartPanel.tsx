"use client";

import { useEffect, useState } from "react";
import type { Cart } from "@/lib/db";
import { tr, type Lang } from "./i18n";

type Props = { cart: Cart; flashSkus: string[]; sessionId: string; lang: Lang };
const money = (value: number, lang: Lang) => `${value.toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU")} ₸`;

export default function CartPanel({ cart, flashSkus, sessionId, lang }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <section className={`cart-panel ${open ? "mobile-open" : ""}`}>
      <button type="button" className="cart-panel-heading" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><span className="cart-icon" aria-hidden="true">{tr(lang, "cart").slice(0, 1)}</span><span><strong>{tr(lang, "cart")}</strong><small>{cart.count > 0 ? `${cart.count} ${tr(lang, "units")}` : tr(lang, "empty")}</small></span></span>
        <span className="cart-heading-total">{money(cart.total, lang)}</span>
      </button>
      <div className="cart-panel-body">
        {cart.lines.length === 0 ? (
          <div className="empty-cart"><span>＋</span><strong>{tr(lang, "emptyCartTitle")}</strong><p>{tr(lang, "emptyCartText")}</p></div>
        ) : (
          <div className="cart-lines">{cart.lines.map((line) => (
            <div className={`cart-line ${flashSkus.includes(line.sku) ? "flash" : ""}`} key={line.sku}>
              <div><strong>{line.name}</strong><span>{line.sku} · {money(line.price, lang)} × {line.qty}</span></div><b>{money(line.lineTotal, lang)}</b>
            </div>
          ))}</div>
        )}
        <div className="cart-total-row"><span>{tr(lang, "total")}</span><strong>{money(cart.total, lang)}</strong></div>
        <a className={`cart-link ${cart.lines.length === 0 || !sessionId ? "disabled" : ""}`} href={sessionId ? `/cart?session=${encodeURIComponent(sessionId)}` : "#"} aria-disabled={cart.lines.length === 0 || !sessionId} onClick={(event) => { if (cart.lines.length === 0 || !sessionId) event.preventDefault(); }}>{tr(lang, "openCart")}</a>
        <p className="cart-note">{tr(lang, "cartDisclaimer")}</p>
      </div>
    </section>
  );
}

export function CartPageContent({ cart, sessionId }: { cart: Cart; sessionId: string }) {
  const [lang, setLang] = useState<Lang>("ru");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("hackalem.lang");
      if (saved === "ru" || saved === "kk") setLang(saved);
    } catch {
      // Страница корзины остаётся доступна на языке из ссылки или на русском.
    }
  }, []);

  return (
    <main className="cart-page">
      <a className="back-link" href="/">{tr(lang, "backToStore")}</a>
      <section className="cart-page-card">
        <div className="cart-page-heading"><div><span className="eyebrow">{tr(lang, "currentState")}</span><h1>{tr(lang, "cart")}</h1></div><span className="cart-page-count">{cart.count} {tr(lang, "units")}</span></div>
        {!sessionId ? <div className="cart-page-empty">{tr(lang, "missingSession")}</div> : cart.lines.length === 0 ? <div className="cart-page-empty">{tr(lang, "cartEmptySession")}</div> : (
          <div className="cart-page-lines">{cart.lines.map((line) => (
            <div className="cart-page-line" key={line.sku}><div><strong>{line.name}</strong><span>{tr(lang, "article")} {line.sku}</span></div><span>{money(line.price, lang)}</span><span>{line.qty} {tr(lang, "units")}</span><b>{money(line.lineTotal, lang)}</b></div>
          ))}</div>
        )}
        <div className="cart-page-total"><span>{tr(lang, "total")}</span><strong>{money(cart.total, lang)}</strong></div>
        <div className="cart-page-info">{tr(lang, "cartFinalInfo")}</div>
      </section>
    </main>
  );
}
