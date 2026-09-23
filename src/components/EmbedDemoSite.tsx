"use client";

import { useEffect, useState } from "react";

export default function EmbedDemoSite() {
  const [origin, setOrigin] = useState("https://hackalem10.vercel.app");

  useEffect(() => {
    setOrigin(window.location.origin);
    const script = document.createElement("script");
    script.src = `${window.location.origin}/embed.js`;
    script.async = true;
    document.body.append(script);
    return () => script.remove();
  }, []);

  return (
    <main className="demo-site">
      <nav className="demo-site-nav"><a href="/">NORTHLINE</a><span>Коллекция · Материалы · Контакты</span></nav>
      <section className="demo-site-hero">
        <div className="demo-site-copy">
          <span className="demo-site-eyebrow">Пример интеграции</span>
          <h1>Торговый консультант на любом сайте</h1>
          <p>Это отдельная демонстрационная витрина с собственным оформлением. Виджет загружается одной строкой, а чат открыт в изолированном iframe.</p>
          <div className="demo-site-pills"><span>Независимые стили</span><span>Один скрипт</span><span>Подтверждение корзины</span></div>
        </div>
        <div className="demo-site-product" aria-label="Демонстрационная витрина электротоваров">
          <div className="demo-site-product-art"><span>230V</span><div className="breaker"><i /><i /><i /><i /></div></div>
          <div className="demo-site-product-info"><small>Электрооборудование / 2026</small><h2>Точная консультация<br />для сложного выбора</h2><p>Подбор по артикулу, характеристикам и наличию.</p><span className="demo-site-link">Спросите ассистента ↗</span></div>
        </div>
      </section>
      <footer className="demo-site-footer">
        <span>Скрипт интеграции</span>
        <code>&lt;script src="{origin}/embed.js" async&gt;&lt;/script&gt;</code>
        <small>Нажмите на круглую кнопку внизу справа, чтобы открыть чат.</small>
      </footer>
    </main>
  );
}
