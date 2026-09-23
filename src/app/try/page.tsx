"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

export default function TryPage() {
  const [origin, setOrigin] = useState("");
  const bookmarkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const currentOrigin = window.location.origin;
    const scriptUrl = JSON.stringify(`${currentOrigin}/embed.js`);
    const bookmarklet = `javascript:(()=>{if(document.querySelector('[data-ekt-assistant-widget]'))return;const s=document.createElement('script');s.src=${scriptUrl};document.body.appendChild(s);})()`;
    // React блокирует javascript: в JSX href. Здесь намеренная закладка:
    // фиксированный код, адрес скрипта только с текущего origin.
    bookmarkRef.current?.setAttribute("href", bookmarklet);
    setOrigin(currentOrigin);
  }, []);

  return (
    <main className={styles.page}>
      <article className={styles.card}>
        <a className={styles.back} href="/">← Витрина и чат</a>
        <p className={styles.eyebrow}>Электрокомплект · ИИ-консультант</p>
        <h1>Ассистент на вашем сайте</h1>
        <p>Посмотрите, как помощник по каталогу выглядит на ekt.kz. Для демонстрации нужна только закладка в вашем браузере.</p>

        <a ref={bookmarkRef} href="#" className={styles.bookmark} draggable={!!origin}
          aria-disabled={!origin} title="Перетащите на панель закладок"
          onClick={(event) => event.preventDefault()}>
          Ассистент ЭК — в закладки
        </a>

        <ol className={styles.steps}>
          <li>Перетащите кнопку на панель закладок.</li>
          <li>Откройте <a href="https://ekt.kz" target="_blank" rel="noreferrer">ekt.kz</a>.</li>
          <li>Нажмите закладку «Ассистент ЭК».</li>
        </ol>
        <p className={styles.note}>Сайт ekt.kz не изменяется: виджет появляется только в вашем браузере.</p>

        <section className={styles.integration} aria-labelledby="integration-title">
          <h2 id="integration-title">Подключение в Bitrix</h2>
          <p>Для постоянного подключения партнёр вставляет одну строку в шаблон сайта:</p>
          <pre><code>{origin ? `<script src="${origin}/embed.js" async></script>` : "Готовим код подключения…"}</code></pre>
        </section>
      </article>
    </main>
  );
}
