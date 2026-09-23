"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent/loop";
import type { Cart } from "@/lib/db";
import type { Msg } from "@/lib/llm/types";
import CartPanel from "./CartPanel";
import ConfirmCard, { type ProposalView } from "./ConfirmCard";
import ProductGrid, { type ProductPreview } from "./ProductGrid";

type ChatMessage = {
  id: string;
  kind: "message";
  role: "user" | "assistant" | "error" | "notice";
  content: string;
};

type ProposalMessage = {
  id: string;
  kind: "proposal";
  proposal: ProposalView;
};

type ChatItem = ChatMessage | ProposalMessage;

type TraceItem = {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "fail";
  summary?: string;
  ms?: number;
};

type EnvInfo = {
  llmMode: string;
  hasKey: boolean;
  model: string;
  catalogSize: number;
  dbEphemeral: boolean;
};

const EMPTY_CART: Cart = { lines: [], total: 0, count: 0 };

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function useSessionId(): string {
  const [sessionId, setSessionId] = useState("");

  useEffect(() => {
    const key = "hackalem.sid";
    let stored = localStorage.getItem(key);
    if (!stored) {
      stored = makeId("session");
      localStorage.setItem(key, stored);
    }
    setSessionId(stored);
  }, []);

  return sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProposal(value: unknown): ProposalView | null {
  if (!isRecord(value) || value.kind !== "proposal") return null;

  const proposalId = typeof value.proposalId === "string" ? value.proposalId : "";
  const sku = typeof value.sku === "string" ? value.sku : "";
  const name = typeof value.name === "string" ? value.name : "";
  const numericKeys = ["qty", "requestedQty", "price", "lineTotal", "available", "minOrder"] as const;
  if (!proposalId || !sku || !name || numericKeys.some((key) => !Number.isFinite(Number(value[key])))) {
    return null;
  }

  return {
    kind: "proposal",
    proposalId,
    sku,
    name,
    qty: Number(value.qty),
    requestedQty: Number(value.requestedQty),
    price: Number(value.price),
    lineTotal: Number(value.lineTotal),
    available: Number(value.available),
    minOrder: Number(value.minOrder),
  };
}

export default function AgentApp() {
  const sessionId = useSessionId();
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [flashSkus, setFlashSkus] = useState<string[]>([]);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [lastSource, setLastSource] = useState<"live" | "mock" | null>(null);
  const [demoPrompts, setDemoPrompts] = useState<string[]>([]);
  const [products, setProducts] = useState<ProductPreview[]>([]);
  const [productsError, setProductsError] = useState("");

  const historyRef = useRef<Msg[]>([]);
  const cartRef = useRef<Cart>(EMPTY_CART);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chatItems, phase]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const setCartWithoutFlash = useCallback((nextCart: Cart) => {
    cartRef.current = nextCart;
    setCart(nextCart);
  }, []);

  const applyCart = useCallback((nextCart: Cart) => {
    const previous = cartRef.current;
    const changed = nextCart.lines
      .filter((line) => previous.lines.find((old) => old.sku === line.sku)?.qty !== line.qty)
      .map((line) => line.sku);

    cartRef.current = nextCart;
    setCart(nextCart);

    if (changed.length > 0) {
      setFlashSkus(changed);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlashSkus([]), 1_600);
    }
  }, []);

  const loadState = useCallback(
    async (sid: string, flash = false) => {
      try {
        const response = await fetch(`/api/state?sessionId=${encodeURIComponent(sid)}`, {
          cache: "no-store",
        });
        if (!response.ok) return;

        const data = (await response.json()) as {
          cart?: Cart;
          demoPrompts?: string[];
          env?: EnvInfo;
        };
        const nextCart = data.cart ?? EMPTY_CART;
        if (flash) applyCart(nextCart);
        else setCartWithoutFlash(nextCart);
        setDemoPrompts(Array.isArray(data.demoPrompts) ? data.demoPrompts : []);
        setEnv(data.env ?? null);
      } catch {
        // Недоступная диагностическая панель не должна ломать чат.
      }
    },
    [applyCart, setCartWithoutFlash],
  );

  useEffect(() => {
    if (sessionId) void loadState(sessionId);
  }, [sessionId, loadState]);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/products", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { products?: ProductPreview[]; error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (!cancelled) setProducts(Array.isArray(data.products) ? data.products : []);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProductsError(error instanceof Error ? error.message : "Не удалось загрузить каталог");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(
    async (rawMessage: string) => {
      const message = rawMessage.trim();
      if (!message || busy || !sessionId) return;

      const assistantId = makeId("assistant");
      setDraft("");
      setBusy(true);
      setPhase("думает");
      setTrace([]);
      setChatItems((items) => [
        ...items,
        { id: makeId("user"), kind: "message", role: "user", content: message },
        { id: assistantId, kind: "message", role: "assistant", content: "" },
      ]);

      const historyForRequest = historyRef.current;
      let answer = "";
      let historyDelta: Msg[] | null = null;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message, history: historyForRequest }),
        });

        if (!response.ok || !response.body) {
          const detail = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(detail.error || `HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
            if (!dataLine || dataLine.slice(6) === "[DONE]") continue;

            let event: AgentEvent;
            try {
              event = JSON.parse(dataLine.slice(6)) as AgentEvent;
            } catch {
              continue;
            }

            switch (event.type) {
              case "status":
                setPhase(event.phase === "tools" ? "проверяет каталог" : event.phase === "answering" ? "отвечает" : "думает");
                break;
              case "token":
                answer += event.text;
                setChatItems((items) =>
                  items.map((item) => item.kind === "message" && item.id === assistantId ? { ...item, content: answer } : item),
                );
                break;
              case "tool_call":
                setTrace((items) => [...items, { id: event.id, name: event.name, args: event.args, status: "running" }]);
                break;
              case "tool_result": {
                setTrace((items) => items.map((item) => item.id === event.id ? { ...item, status: event.ok ? "ok" : "fail", summary: event.summary, ms: event.ms } : item));
                if (event.name === "propose_add" && event.ok) {
                  const proposal = readProposal(event.client);
                  if (proposal) {
                    setChatItems((items) => items.some((item) => item.kind === "proposal" && item.proposal.proposalId === proposal.proposalId) ? items : [...items, { id: `proposal_${proposal.proposalId}`, kind: "proposal", proposal }]);
                  }
                }
                break;
              }
              case "state":
                applyCart(event.cart);
                break;
              case "history":
                historyDelta = event.messages;
                break;
              case "done":
                setLastSource(event.source);
                break;
              case "error":
                setChatItems((items) => [
                  ...items.filter((item) => !(item.kind === "message" && item.id === assistantId && item.content.length === 0)),
                  { id: makeId("error"), kind: "message", role: "error", content: event.message },
                ]);
                break;
            }
          }
        }

        historyRef.current = [
          ...historyForRequest,
          ...(historyDelta ?? ([{ role: "user", content: message }, { role: "assistant", content: answer || "(без текста)" }] as Msg[])),
        ];
      } catch (error) {
        setChatItems((items) => [
          ...items.filter((item) => !(item.kind === "message" && item.id === assistantId && item.content.length === 0)),
          { id: makeId("error"), kind: "message", role: "error", content: `Связь с агентом оборвалась: ${error instanceof Error ? error.message : String(error)}` },
        ]);
      } finally {
        setBusy(false);
        setPhase(null);
        void loadState(sessionId, true);
      }
    },
    [applyCart, busy, loadState, sessionId],
  );

  const dismissProposal = useCallback((proposalId: string) => {
    setChatItems((items) => items.filter((item) => !(item.kind === "proposal" && item.proposal.proposalId === proposalId)));
  }, []);

  const confirmProposal = useCallback(
    async (proposal: ProposalView) => {
      const response = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, proposalId: proposal.proposalId }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        cart?: Cart;
        added?: { name: string; qty: number };
        capped?: boolean;
      };

      if (data.cart) applyCart(data.cart);
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

      dismissProposal(proposal.proposalId);
      setChatItems((items) => [
        ...items,
        {
          id: makeId("notice"),
          kind: "message",
          role: "notice",
          content: data.capped
            ? `Добавлено ${data.added?.qty ?? proposal.qty} шт. — это весь доступный остаток.`
            : `${data.added?.name ?? proposal.name} добавлен в корзину: ${data.added?.qty ?? proposal.qty} шт.`,
        },
      ]);
    },
    [applyCart, dismissProposal, sessionId],
  );

  const reset = useCallback(async () => {
    if (!sessionId || busy) return;
    const response = await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = (await response.json().catch(() => ({}))) as { cart?: Cart };
    historyRef.current = [];
    setChatItems([]);
    setTrace([]);
    setLastSource(null);
    setFlashSkus([]);
    setCartWithoutFlash(data.cart ?? EMPTY_CART);
  }, [busy, sessionId, setCartWithoutFlash]);

  const mode = !env
    ? { className: "", label: "Режим…" }
    : !env.hasKey || env.llmMode === "mock" || lastSource === "mock"
      ? { className: "mock", label: "MOCK" }
      : { className: "live", label: `LIVE · ${env.model}` };

  return (
    <main className="store-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark">ЭК</span>
          <div><strong>Электрокомплект</strong><span>ИИ-консультант по каталогу</span></div>
        </div>
        <div className="header-meta">
          <span className={`mode-badge ${mode.className}`}>{mode.label}</span>
          <span className="catalog-badge">Каталог: {env ? env.catalogSize.toLocaleString("ru-RU") : "…"}</span>
          {env?.dbEphemeral && <span className="ephemeral-badge">временная БД</span>}
          <button className="secondary-button" type="button" onClick={() => void reset()} disabled={busy}>Сбросить демо</button>
        </div>
      </header>

      <section className="catalog-zone" aria-labelledby="catalog-title">
        <div className="zone-heading">
          <div><span className="eyebrow">Витрина</span><h1 id="catalog-title">Товары каталога</h1></div>
          <span>{products.length} позиций</span>
        </div>
        <ProductGrid products={products} error={productsError} onAsk={(product) => void send(`Расскажи о товаре с артикулом ${product.sku}`)} />
      </section>

      <section className="chat-zone" aria-labelledby="chat-title">
        <div className="zone-heading chat-heading">
          <div><span className="eyebrow">Помощник</span><h2 id="chat-title">Чат с агентом</h2></div>
          <span className={`agent-status ${busy ? "active" : ""}`}>{busy ? phase || "работает" : "готов"}</span>
        </div>

        <div className="messages" ref={scrollRef} aria-live="polite">
          {chatItems.length === 0 && (
            <div className="welcome-card">
              <span className="welcome-icon">AI</span>
              <div><strong>Помогу подобрать электротовары</strong><p>Проверю характеристики, реальные остатки по складам, предложу аналог и объясню выбор. Корзина изменится только после вашего подтверждения.</p></div>
            </div>
          )}
          {chatItems.map((item) => item.kind === "proposal" ? (
            <ConfirmCard key={item.id} proposal={item.proposal} onConfirm={confirmProposal} onDecline={() => dismissProposal(item.proposal.proposalId)} />
          ) : (
            <div key={item.id} className={`message-row ${item.role}`}><div className="message-bubble">{item.content}</div></div>
          ))}
          {busy && phase && <div className="thinking-line"><span /> Агент {phase}…</div>}
        </div>

        <div className="chat-controls">
          {demoPrompts.length > 0 && (
            <div className="prompt-list" aria-label="Примеры запросов">
              {demoPrompts.map((prompt) => <button key={prompt} type="button" onClick={() => void send(prompt)} disabled={busy}>{prompt}</button>)}
            </div>
          )}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(draft); }}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(draft); } }} placeholder="Например: найдите автоматический выключатель на 16 А" rows={2} disabled={busy || !sessionId} />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Отправить сообщение">{busy ? "…" : "Отправить"}</button>
          </form>
        </div>
      </section>

      <aside className="cart-zone" aria-label="Корзина и действия агента">
        <CartPanel cart={cart} flashSkus={flashSkus} sessionId={sessionId} />
        <details className="trace-panel">
          <summary>Действия агента <span>{trace.length}</span></summary>
          {trace.length === 0 ? <p>Инструменты ещё не вызывались.</p> : (
            <div className="trace-list">{trace.map((item) => (
              <div className={`trace-item ${item.status}`} key={item.id}>
                <div><strong>{item.name}</strong>{item.ms !== undefined && <span>{item.ms} мс</span>}</div>
                <code>{JSON.stringify(item.args)}</code>{item.summary && <p>{item.summary}</p>}
              </div>
            ))}</div>
          )}
        </details>
      </aside>
    </main>
  );
}
