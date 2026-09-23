"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_PROMPTS } from "@/lib/agent/prompts";
import type { AgentEvent } from "@/lib/agent/loop";
import type { Cart, Order } from "@/lib/db";
import type { Msg } from "@/lib/llm/types";

/**
 * Весь интерфейс — один клиентский компонент.
 * Состояние диалога живёт здесь и уходит на сервер с каждым запросом:
 * сервер не хранит сессий, поэтому его можно перезапускать и
 * переразворачивать посреди демо, ничего не потеряв.
 */

type ChatMsg = { role: "user" | "assistant" | "error"; content: string };
type TraceItem = {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "fail";
  summary?: string;
  ms?: number;
};
type Env = {
  llmMode: string;
  hasKey: boolean;
  model: string;
  fallbackModel: string;
  dbEphemeral: boolean;
};

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₸`;
const EMPTY_CART: Cart = { lines: [], total: 0, count: 0 };

function useSessionId(): string {
  const [id, setId] = useState("");
  useEffect(() => {
    const key = "hackalem.sid";
    let sid = localStorage.getItem(key);
    if (!sid) {
      sid = `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      localStorage.setItem(key, sid);
    }
    setId(sid);
  }, []);
  return id;
}

export default function AgentApp() {
  const sessionId = useSessionId();

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);

  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [env, setEnv] = useState<Env | null>(null);
  const [lastSource, setLastSource] = useState<"live" | "mock" | null>(null);

  const [cartFlash, setCartFlash] = useState(false);
  const [ordersFlash, setOrdersFlash] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCartCount = useRef(0);
  const prevOrderCount = useRef(0);

  // История для сервера: то, что уже сказано, без служебных строк.
  const historyRef = useRef<Msg[]>([]);

  useEffect(() => {
    // Мгновенно, а не smooth: во время стриминга этот эффект срабатывает
    // на каждом токене, и плавные прокрутки перебивают друг друга —
    // чат зависает в середине, а ответ остаётся за кадром.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, phase]);

  const loadState = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/state?sessionId=${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json();
      setCart(data.cart ?? EMPTY_CART);
      setOrders(data.orders ?? []);
      setEnv(data.env ?? null);
      prevCartCount.current = data.cart?.count ?? 0;
      prevOrderCount.current = data.orders?.length ?? 0;
    } catch {
      /* панель состояния не должна ронять чат */
    }
  }, []);

  useEffect(() => {
    if (sessionId) void loadState(sessionId);
  }, [sessionId, loadState]);

  // Подсветка карточек при изменении — чтобы с задних рядов было видно,
  // что агент действительно что-то поменял, а не просто написал об этом.
  const applyState = useCallback((nextCart: Cart, nextOrders: Order[]) => {
    if (nextCart.count !== prevCartCount.current) {
      setCartFlash(true);
      setTimeout(() => setCartFlash(false), 900);
      prevCartCount.current = nextCart.count;
    }
    const changed =
      nextOrders.length !== prevOrderCount.current ||
      nextOrders.some((o, i) => o.status !== orders[i]?.status);
    if (changed) {
      setOrdersFlash(true);
      setTimeout(() => setOrdersFlash(false), 900);
      prevOrderCount.current = nextOrders.length;
    }
    setCart(nextCart);
    setOrders(nextOrders);
  }, [orders]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy || !sessionId) return;

      setDraft("");
      setBusy(true);
      setPhase("думает");
      setTrace([]);
      setMessages((m) => [...m, { role: "user", content: message }, { role: "assistant", content: "" }]);

      const historyForRequest = historyRef.current;
      let answer = "";
      let delta: Msg[] | null = null;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message, history: historyForRequest }),
        });

        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(detail.error ?? `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE: события разделены пустой строкой.
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") continue;

            let ev: AgentEvent;
            try {
              ev = JSON.parse(payload) as AgentEvent;
            } catch {
              continue;
            }

            switch (ev.type) {
              case "status":
                setPhase(ev.phase === "tools" ? "работает с каталогом" : ev.phase === "thinking" ? "думает" : "отвечает");
                break;

              case "token":
                answer += ev.text;
                setMessages((m) => {
                  const copy = [...m];
                  copy[copy.length - 1] = { role: "assistant", content: answer };
                  return copy;
                });
                break;

              case "tool_call":
                setTrace((t) => [...t, { id: ev.id, name: ev.name, args: ev.args, status: "running" }]);
                break;

              case "tool_result":
                setTrace((t) =>
                  t.map((item) =>
                    item.id === ev.id
                      ? { ...item, status: ev.ok ? "ok" : "fail", summary: ev.summary, ms: ev.ms }
                      : item,
                  ),
                );
                break;

              case "state":
                applyState(ev.cart, ev.orders);
                break;

              case "history":
                // Сервер отдаёт всё, что дописал за ход, включая вызовы
                // инструментов — благодаря этому агент на следующей реплике
                // помнит id уже показанных товаров.
                delta = ev.messages;
                break;

              case "done":
                setLastSource(ev.source);
                break;

              case "error":
                setMessages((m) => {
                  const copy = [...m];
                  const tail = copy[copy.length - 1];
                  if (tail?.role === "assistant" && !tail.content) copy.pop();
                  return [...copy, { role: "error", content: ev.message }];
                });
                break;
            }
          }
        }

        historyRef.current = [
          ...historyForRequest,
          ...(delta ?? [
            { role: "user", content: message },
            { role: "assistant", content: answer || "(без текста)" },
          ] as Msg[]),
        ];
      } catch (e) {
        setMessages((m) => {
          const copy = [...m];
          const tail = copy[copy.length - 1];
          if (tail?.role === "assistant" && !tail.content) copy.pop();
          return [...copy, { role: "error", content: `Связь с агентом оборвалась: ${(e as Error).message}` }];
        });
      } finally {
        setBusy(false);
        setPhase(null);
        void loadState(sessionId);
      }
    },
    [busy, sessionId, applyState, loadState],
  );

  const reset = useCallback(async () => {
    if (!sessionId) return;
    await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    historyRef.current = [];
    prevCartCount.current = 0;
    prevOrderCount.current = 0;
    setMessages([]);
    setTrace([]);
    setCart(EMPTY_CART);
    setOrders([]);
    setLastSource(null);
  }, [sessionId]);

  // Пока состояние не загрузилось — нейтральная надпись.
  // Мигнуть «LIVE» при пустом ключе значит соврать жюри на секунду.
  const modeBadge = !env
    ? { cls: "", text: "проверяю режим…" }
    : lastSource === "mock" || !env.hasKey
      ? { cls: "mock", text: "MOCK — записанные ответы" }
      : { cls: "live", text: `LIVE — ${env.model}` };

  return (
    <div className="shell">
      <div className="chat-col">
        <div className="topbar">
          <div className="brand">
            Агент<span>·</span>Магазин
          </div>
          <div className={`badge ${modeBadge.cls}`}>{modeBadge.text}</div>
          {env?.dbEphemeral && <div className="badge warn">БД в /tmp</div>}
          <div className="spacer" />
          <button className="ghost-btn" onClick={reset} disabled={busy}>
            Сброс демо
          </button>
        </div>

        <div className="messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="msg assistant">
              <div className="bubble">
                Опишите, что вам нужно — я подберу, сравню и оформлю заказ. Возврат тоже на мне.
                {"\n\n"}Например: «нужен лёгкий ноутбук для учёбы до 500 000 ₸».
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const typing = busy && isLast && m.role === "assistant";
            return (
              <div key={i} className={`msg ${m.role}`}>
                <div className={`bubble ${typing ? "caret" : ""}`}>{m.content}</div>
              </div>
            );
          })}

          {busy && phase && (
            <div className="status-line">
              <span className="dot" />
              агент {phase}…
            </div>
          )}
        </div>

        <div className="composer">
          <div className="suggestions">
            {DEMO_PROMPTS.map((p) => (
              <button key={p} className="chip" onClick={() => void send(p)} disabled={busy}>
                {p}
              </button>
            ))}
          </div>
          <form
            className="input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Что вам нужно?"
              disabled={busy || !sessionId}
              autoFocus
            />
            <button className="send-btn" type="submit" disabled={busy || !draft.trim()}>
              {busy ? "…" : "Отправить"}
            </button>
          </form>
        </div>
      </div>

      <div className="rail">
        <CartCard cart={cart} flash={cartFlash} />
        <OrdersCard orders={orders} flash={ordersFlash} />
        <TraceCard trace={trace} />
      </div>
    </div>
  );
}

function CartCard({ cart, flash }: { cart: Cart; flash: boolean }) {
  return (
    <div className={`card ${flash ? "flash" : ""}`}>
      <div className="card-head">
        <span>Корзина</span>
        {cart.count > 0 && <span className="count-pill">{cart.count}</span>}
      </div>
      {cart.lines.length === 0 ? (
        <div className="empty">Пусто</div>
      ) : (
        <>
          {cart.lines.map((l) => (
            <div className="line" key={l.product_id}>
              <span>
                {l.title} <span className="qty">×{l.qty}</span>
              </span>
              <span className="price">{money(l.line_total)}</span>
            </div>
          ))}
          <div className="total">
            <span>Итого</span>
            <span className="amount">{money(cart.total)}</span>
          </div>
        </>
      )}
    </div>
  );
}

const STATUS_RU: Record<Order["status"], string> = {
  placed: "оформлен",
  shipped: "в пути",
  delivered: "доставлен",
  return_requested: "возврат",
  refunded: "возвращён",
};

function OrdersCard({ orders, flash }: { orders: Order[]; flash: boolean }) {
  return (
    <div className={`card ${flash ? "flash" : ""}`}>
      <div className="card-head">
        <span>Заказы</span>
        {orders.length > 0 && <span className="count-pill">{orders.length}</span>}
      </div>
      {orders.length === 0 ? (
        <div className="empty">Заказов нет</div>
      ) : (
        orders.map((o) => (
          <div className="order" key={o.id}>
            <div className="order-head">
              <span className="order-id">{o.id}</span>
              <span className={`status ${o.status}`}>{STATUS_RU[o.status] ?? o.status}</span>
            </div>
            <div className="order-items">
              {o.items.map((i) => `${i.title} ×${i.qty}`).join(", ")}
            </div>
            <div className="order-meta">
              {money(o.total)} · доставка {o.eta_days} дн.
              {o.return_reason ? ` · причина: ${o.return_reason}` : ""}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function TraceCard({ trace }: { trace: TraceItem[] }) {
  return (
    <div className="card">
      <div className="card-head">
        <span>Что делает агент</span>
        {trace.length > 0 && <span className="count-pill">{trace.length}</span>}
      </div>
      {trace.length === 0 ? (
        <div className="empty">Вызовов инструментов пока не было</div>
      ) : (
        <div className="trace">
          {trace.map((t) => (
            <div className={`trace-item ${t.status}`} key={t.id}>
              <div className="trace-name">
                <span>{t.name}</span>
                {t.ms !== undefined && <span className="trace-ms">{t.ms} мс</span>}
              </div>
              <div className="trace-args">{JSON.stringify(t.args)}</div>
              {t.summary && <div className="trace-summary">{t.summary}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
