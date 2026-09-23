"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent/loop";
import type { Cart } from "@/lib/db";
import type { Msg } from "@/lib/llm/types";
import CartPanel from "./CartPanel";
import ConfirmCard, { type ProposalLineView, type ProposalView } from "./ConfirmCard";
import ProductGrid, { type ProductPreview } from "./ProductGrid";
import { kazakhDemoPrompts, tr, type Lang } from "./i18n";

type ChatMessage = {
  id: string;
  kind: "message";
  role: "user" | "assistant" | "error" | "notice";
  content: string;
  imageUrl?: string;
};

type ProposalMessage = {
  id: string;
  kind: "proposal";
  proposal: ProposalView;
  status: "pending" | "confirmed" | "declined";
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
const MAX_CHAT_ITEMS = 40;
const SESSION_KEY = "hackalem.sid";

function makeMessageId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeSessionId(): string {
  const crypt = globalThis.crypto;
  if (typeof crypt?.randomUUID === "function") return crypt.randomUUID();
  if (typeof crypt?.getRandomValues === "function") {
    const bytes = crypt.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Криптографическая генерация идентификатора недоступна.");
}

function isSecureSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || /^[0-9a-f]{32}$/i.test(value);
}

function useSessionId(): [string, (value: string) => void] {
  const [sessionId, setSessionId] = useState("");

  useEffect(() => {
    const key = "hackalem.sid";
    let stored = "";
    try {
      stored = localStorage.getItem(key) ?? "";
      if (!isSecureSessionId(stored)) {
        stored = makeSessionId();
        localStorage.setItem(key, stored);
      }
    } catch {
      stored = makeSessionId();
    }
    setSessionId(stored);
  }, []);

  return [sessionId, setSessionId];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreProposal(value: unknown): ProposalView | null {
  if (!isRecord(value) || typeof value.proposalId !== "string" || !Array.isArray(value.items)) return null;
  const items: ProposalLineView[] = [];
  for (const candidate of value.items) {
    if (!isRecord(candidate)) return null;
    const stringKeys = ["sku", "name"] as const;
    const numericKeys = ["qty", "requestedQty", "price", "lineTotal", "available", "minOrder"] as const;
    if (stringKeys.some((key) => typeof candidate[key] !== "string") || numericKeys.some((key) => !Number.isFinite(Number(candidate[key])))) return null;
    items.push({
      sku: String(candidate.sku), name: String(candidate.name),
      qty: Number(candidate.qty), requestedQty: Number(candidate.requestedQty),
      price: Number(candidate.price), lineTotal: Number(candidate.lineTotal),
      available: Number(candidate.available), minOrder: Number(candidate.minOrder),
    });
  }
  if (!items.length || !Number.isFinite(Number(value.total))) return null;
  return { kind: "proposal", proposalId: value.proposalId, items, total: Number(value.total) };
}

function restoreChatItems(value: unknown): ChatItem[] {
  if (!Array.isArray(value)) return [];
  const restored: ChatItem[] = [];
  for (const candidate of value.slice(-MAX_CHAT_ITEMS)) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
    if (candidate.kind === "message" && typeof candidate.content === "string"
      && ["user", "assistant", "error", "notice"].includes(String(candidate.role))) {
      restored.push({
        id: candidate.id, kind: "message", role: candidate.role as ChatMessage["role"],
        content: candidate.content,
      });
      continue;
    }
    if (candidate.kind === "proposal" && ["pending", "confirmed", "declined"].includes(String(candidate.status))) {
      const proposal = restoreProposal(candidate.proposal);
      if (proposal) restored.push({
        id: candidate.id, kind: "proposal", proposal,
        status: candidate.status as ProposalMessage["status"],
      });
    }
  }
  return restored;
}

function readProposal(value: unknown): ProposalView | null {
  if (!isRecord(value) || value.kind !== "proposal") return null;

  const proposalId = typeof value.proposalId === "string" ? value.proposalId : "";
  const sku = typeof value.sku === "string" ? value.sku : "";
  const name = typeof value.name === "string" ? value.name : "";
  const numericKeys = ["qty", "price", "lineTotal", "available", "minOrder"] as const;
  if (!proposalId || !sku || !name || numericKeys.some((key) => !Number.isFinite(Number(value[key])))) {
    return null;
  }

  const item: ProposalLineView = {
    sku, name, qty: Number(value.qty), requestedQty: Number(value.requestedQty ?? value.qty),
    price: Number(value.price), lineTotal: Number(value.lineTotal),
    available: Number(value.available), minOrder: Number(value.minOrder),
  };
  return {
    kind: "proposal",
    proposalId,
    items: [item],
    total: item.lineTotal,
  };
}

export default function AgentApp() {
  const [sessionId, setSessionId] = useSessionId();
  const [lang, setLang] = useState<Lang>("ru");
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [cartUrl, setCartUrl] = useState("");
  const [flashSkus, setFlashSkus] = useState<string[]>([]);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [lastSource, setLastSource] = useState<"live" | "mock" | null>(null);
  const [demoPrompts, setDemoPrompts] = useState<string[]>([]);
  const [products, setProducts] = useState<ProductPreview[]>([]);
  const [productsError, setProductsError] = useState("");
  const [hydratedSessionId, setHydratedSessionId] = useState("");
  const [resetting, setResetting] = useState(false);

  const historyRef = useRef<Msg[]>([]);
  const cartRef = useRef<Cart>(EMPTY_CART);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!sessionId) return;
    let restoredItems: ChatItem[] = [];
    let restoredHistory: Msg[] = [];
    try {
      const raw = localStorage.getItem(`hackalem.chat.${sessionId}`);
      if (raw) {
        const saved: unknown = JSON.parse(raw);
        if (isRecord(saved)) {
          restoredItems = restoreChatItems(saved.items);
          restoredHistory = Array.isArray(saved.history) ? saved.history as Msg[] : [];
        }
      }
    } catch {
      // Некорректное или недоступное хранилище не должно мешать новому диалогу.
    }
    historyRef.current = restoredHistory;
    setChatItems(restoredItems);
    setHydratedSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || hydratedSessionId !== sessionId) return;
    if (chatItems.length > MAX_CHAT_ITEMS) {
      setChatItems((items) => items.slice(-MAX_CHAT_ITEMS));
      return;
    }

    const items = chatItems.map((item): ChatItem => {
      if (item.kind !== "message" || !item.imageUrl) return item;
      const { imageUrl: _imageUrl, ...message } = item;
      return { ...message, content: `${message.content}\n[фото]` };
    });
    try {
      localStorage.setItem(`hackalem.chat.${sessionId}`, JSON.stringify({ items, history: historyRef.current }));
    } catch {
      // История доступна до закрытия вкладки, даже если браузер не даёт её сохранить.
    }
  }, [chatItems, hydratedSessionId, sessionId, busy]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("hackalem.lang");
      if (saved === "ru" || saved === "kk") setLang(saved);
    } catch {
      // Без localStorage продолжаем работать на русском.
    }
  }, []);

  const changeLanguage = useCallback((next: Lang) => {
    setLang(next);
    try {
      localStorage.setItem("hackalem.lang", next);
    } catch {
      // Выбранный язык действует до закрытия страницы.
    }
  }, []);

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
          cartUrl?: string;
          demoPrompts?: string[];
          env?: EnvInfo;
        };
        const nextCart = data.cart ?? EMPTY_CART;
        if (flash) applyCart(nextCart);
        else setCartWithoutFlash(nextCart);
        setCartUrl(typeof data.cartUrl === "string" ? data.cartUrl : "");
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
        if (!cancelled) setProductsError(error instanceof Error ? error.message : tr(lang, "productLoadFailed"));
      });

    return () => {
      cancelled = true;
    };
  }, [lang]);

  const send = useCallback(
    async (rawMessage: string, imageUrl?: string) => {
      const message = rawMessage.trim();
      if (!message || busy || resetting || !sessionId) return;

      const assistantId = makeMessageId("assistant");
      setDraft("");
      setBusy(true);
      setPhase("thinking");
      setTrace([]);
      setChatItems((items) => [
        ...items,
        { id: makeMessageId("user"), kind: "message", role: "user", content: message, ...(imageUrl ? { imageUrl } : {}) },
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
                setPhase(event.phase === "tools" ? "searching" : event.phase === "answering" ? "answering" : "thinking");
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
                    setChatItems((items) => items.some((item) => item.kind === "proposal" && item.proposal.proposalId === proposal.proposalId) ? items : [...items, { id: `proposal_${proposal.proposalId}`, kind: "proposal", proposal, status: "pending" }]);
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
                  { id: makeMessageId("error"), kind: "message", role: "error", content: lang === "ru" ? event.message : tr(lang, "connectionLost") },
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
          { id: makeMessageId("error"), kind: "message", role: "error", content: lang === "ru" ? `${tr(lang, "connectionLost")}: ${error instanceof Error ? error.message : String(error)}` : tr(lang, "connectionLost") },
        ]);
      } finally {
        setBusy(false);
        setPhase(null);
        void loadState(sessionId, true);
      }
    },
    [applyCart, busy, lang, loadState, resetting, sessionId],
  );

  const setProposalStatus = useCallback((proposalId: string, status: ProposalMessage["status"]) => {
    setChatItems((items) => items.map((item) => item.kind === "proposal" && item.proposal.proposalId === proposalId ? { ...item, status } : item));
  }, []);

  const confirmProposal = useCallback(
    async (proposal: ProposalView) => {
      if (resetting) throw new Error(tr(lang, "resetting"));
      const response = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, proposalId: proposal.proposalId }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        cart?: Cart;
        added?: { name: string; qty: number };
        lines?: { sku: string; name: string; added: number; capped: boolean }[];
        addedTotal?: number;
        capped?: boolean;
        cartUrl?: string;
      };

      if (data.cart) applyCart(data.cart);
      if (typeof data.cartUrl === "string") setCartUrl(data.cartUrl);
      if (!response.ok) {
        const errorKeys: Record<string, Parameters<typeof tr>[1]> = {
          NOT_FOUND: "proposalNotFound", ALREADY_USED: "proposalAlreadyUsed",
          NO_STOCK: "noStock", PRODUCT_GONE: "productGone",
        };
        const localizedError = data.code && errorKeys[data.code]
          ? tr(lang, errorKeys[data.code])
          : lang === "ru" ? data.error || `HTTP ${response.status}` : tr(lang, "confirmationFailed");
        throw new Error(localizedError);
      }

      setProposalStatus(proposal.proposalId, "confirmed");
      setChatItems((items) => [
        ...items,
        {
          id: makeMessageId("notice"),
          kind: "message",
          role: "notice",
          content: data.lines?.length
            ? `${tr(lang, "addedToCart")}:\n${data.lines.map((line) => `• ${line.name} (${line.sku}) — ${line.added} ${tr(lang, "units")}${line.capped ? ` — ${tr(lang, "allAvailableStock")}` : ""}`).join("\n")}\n${tr(lang, "addedTotal")}: ${data.addedTotal ?? 0} ${tr(lang, "units")}`
            : data.capped
              ? `${tr(lang, "addedToCart")}: ${data.added?.qty ?? proposal.items[0]?.qty ?? 0} ${tr(lang, "units")} — ${tr(lang, "allAvailableStock")}.`
              : `${data.added?.name ?? proposal.items[0]?.name ?? ""} — ${tr(lang, "addedToCart").toLowerCase()}: ${data.added?.qty ?? proposal.items[0]?.qty ?? 0} ${tr(lang, "units")}.`,
        },
      ]);
    },
    [applyCart, lang, resetting, sessionId, setProposalStatus],
  );

  const uploadFile = useCallback(async (file: File) => {
    if (!sessionId || busy || uploading || resetting) return;
    setUploading(true);
    const form = new FormData();
    form.set("file", file);
    form.set("sessionId", sessionId);
    try {
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        kind?: string;
        proposalId?: string;
        matched?: { sku: string; name: string; price: number; qty: number; available: number; status: string }[];
        unmatched?: { article: string; qty: number }[];
        skipped?: number;
        message?: string;
      };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

      if (data.kind === "photo") {
        if (!data.message) throw new Error(tr(lang, "photoDescriptionMissing"));
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const mime = file.type || (file.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
        void send(data.message, `data:${mime};base64,${btoa(binary)}`);
        return;
      }

      if (data.kind !== "spec") throw new Error(tr(lang, "unknownUploadResponse"));
      const matched = data.matched ?? [];
      const unmatched = data.unmatched ?? [];
      const skipped = data.skipped ?? 0;
      if (data.proposalId && matched.length) {
        const items: ProposalLineView[] = matched.map((item) => ({
          sku: item.sku,
          name: item.name,
          qty: item.qty,
          requestedQty: item.qty,
          price: item.price,
          lineTotal: item.price * item.qty,
          available: item.available,
          minOrder: 1,
        }));
        setChatItems((current) => [...current, {
          id: `proposal_${data.proposalId}`,
          kind: "proposal",
          proposal: { kind: "proposal", proposalId: data.proposalId!, items, total: items.reduce((sum, item) => sum + item.lineTotal, 0) },
          status: "pending",
        }]);
      }

      const notes: string[] = [];
      if (unmatched.length) notes.push(`${tr(lang, "notFoundInCatalog")}: ${unmatched.map((row) => `${row.article} (${row.qty} ${tr(lang, "units")})`).join(", ")}.`);
      if (skipped > 0) notes.push(`${tr(lang, "skippedRows")}: ${skipped}.`);
      if (!matched.length && !notes.length) notes.push(tr(lang, "noCatalogRows"));
      if (notes.length) setChatItems((current) => [...current, { id: makeMessageId("notice"), kind: "message", role: "notice", content: notes.join("\n") }]);
    } catch (error) {
      setChatItems((current) => [...current, {
        id: makeMessageId("error"), kind: "message", role: "error",
        content: lang === "ru"
          ? `${tr(lang, "uploadFailed")}: ${error instanceof Error ? error.message : String(error)}`
          : `${tr(lang, "uploadFailed")}: ${error instanceof Error && error.message.includes("5 МБ") ? tr(lang, "fileTooBig") : error instanceof Error && error.message.includes("Поддерживаются") ? tr(lang, "unsupportedFileType") : tr(lang, "fileParseFailed")}`,
      }]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [busy, lang, resetting, send, sessionId, uploading]);

  const reset = useCallback(async () => {
    if (!sessionId || busy || uploading || resetting) return;
    setResetting(true);
    try {
      const response = await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json().catch(() => ({}))) as { cart?: Cart };
      const nextSessionId = makeSessionId();
      try {
        localStorage.removeItem(`hackalem.chat.${sessionId}`);
        localStorage.setItem(SESSION_KEY, nextSessionId);
      } catch {
        // Новый диалог продолжит работать без постоянного хранилища.
      }
      historyRef.current = [];
      setChatItems([]);
      setHydratedSessionId("");
      setSessionId(nextSessionId);
      setTrace([]);
      setLastSource(null);
      setFlashSkus([]);
      setCartUrl("");
      setCartWithoutFlash(data.cart ?? EMPTY_CART);
    } catch {
      setChatItems((items) => [...items, {
        id: makeMessageId("error"), kind: "message", role: "error", content: tr(lang, "resetFailed"),
      }]);
    } finally {
      setResetting(false);
    }
  }, [busy, lang, resetting, sessionId, setCartWithoutFlash, setSessionId, uploading]);

  const mode = !env
    ? { className: "", label: "…" }
    : !env.hasKey || env.llmMode === "mock" || lastSource === "mock"
      ? { className: "mock", label: tr(lang, "mock") }
      : { className: "live", label: `${tr(lang, "live")} · ${env.model}` };
  const skuIn = demoPrompts[0]?.match(/артикул (.*?):/)?.[1] ?? "—";
  const skuOut = demoPrompts[1]?.match(/^А (.*?) есть\?/)?.[1] ?? "—";
  const visiblePrompts = lang === "kk" ? kazakhDemoPrompts(skuIn, skuOut) : demoPrompts;

  return (
    <main className="store-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark">ЭК</span>
          <div><strong>{tr(lang, "appTitle")}</strong><span>{tr(lang, "appSubtitle")}</span></div>
        </div>
        <div className="header-meta">
          <span className={`mode-badge ${mode.className}`}>{mode.label}</span>
          <span className="catalog-badge">{tr(lang, "catalogCount")}: {env ? env.catalogSize.toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU") : "…"}</span>
          {env?.dbEphemeral && <span className="ephemeral-badge">{tr(lang, "temporaryDb")}</span>}
          <div className="language-switch" role="group" aria-label={tr(lang, "interfaceLanguage")}>
            <button type="button" aria-pressed={lang === "ru"} onClick={() => changeLanguage("ru")}>RU</button>
            <button type="button" aria-pressed={lang === "kk"} onClick={() => changeLanguage("kk")}>KZ</button>
          </div>
        </div>
      </header>

      <section className="catalog-zone" aria-labelledby="catalog-title">
        <div className="zone-heading">
          <div><span className="eyebrow">{tr(lang, "storefront")}</span><h1 id="catalog-title">{tr(lang, "products")}</h1></div>
          <span>{products.length} {tr(lang, "positions")}</span>
        </div>
        <ProductGrid products={products} error={productsError} lang={lang} onAsk={(product) => void send(tr(lang, "productQuestion").replace("{sku}", product.sku))} />
      </section>

      <section className="chat-zone" aria-labelledby="chat-title">
        <div className="zone-heading chat-heading">
          <div><span className="eyebrow">{tr(lang, "assistant")}</span><h2 id="chat-title">{tr(lang, "chatTitle")}</h2></div>
          <button className="manager-button" type="button" onClick={() => void send(tr(lang, "managerQuestion"))} disabled={busy || uploading || resetting}>{tr(lang, "ctaManager")}</button>
          <button className="new-chat-button" type="button" onClick={() => void reset()} disabled={busy || resetting}>{tr(lang, "newChat")}</button>
          <span className={`agent-status ${busy ? "active" : ""}`}>{busy ? (phase ? tr(lang, phase as "thinking" | "searching" | "answering") : tr(lang, "working")) : tr(lang, "ready")}</span>
        </div>

        <div className="messages" ref={scrollRef} aria-live="polite">
          {chatItems.length === 0 && (
            <div className="welcome-card">
              <span className="welcome-icon">AI</span>
              <div><strong>{tr(lang, "welcomeTitle")}</strong><p>{tr(lang, "welcomeText")}</p></div>
            </div>
          )}
          {chatItems.map((item) => item.kind === "proposal" ? (
            <ConfirmCard key={item.id} proposal={item.proposal} status={item.status} onConfirm={confirmProposal} onDecline={() => setProposalStatus(item.proposal.proposalId, "declined")} lang={lang} />
          ) : (
            <div key={item.id} className={`message-row ${item.role}`}><div className="message-bubble">{item.imageUrl && <img className="message-image" src={item.imageUrl} alt={tr(lang, "imageAlt")} />}{item.content}</div></div>
          ))}
          {busy && phase && <div className="thinking-line"><span /> {tr(lang, phase as "thinking" | "searching" | "answering")}…</div>}
        </div>

        <div className="chat-controls">
          {visiblePrompts.length > 0 && (
            <div className="prompt-list" aria-label={tr(lang, "promptExamples")}>
              {visiblePrompts.map((prompt) => <button key={prompt} type="button" onClick={() => void send(prompt)} disabled={busy || resetting}>{prompt}</button>)}
            </div>
          )}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(draft); }}>
            <input ref={fileInputRef} className="file-input" type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.docx,.pdf,.png,.jpg,.jpeg,.webp" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void uploadFile(file); }} />
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(draft); } }} placeholder={tr(lang, "inputPlaceholder")} rows={2} disabled={busy || uploading || resetting || !sessionId} />
            <button className="attach-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy || uploading || resetting || !sessionId} aria-label={tr(lang, "attachFile")}>📎</button>
            <button type="submit" disabled={busy || uploading || resetting || !draft.trim()} aria-label={tr(lang, "send")}>{busy ? "…" : tr(lang, "send")}</button>
          </form>
          {uploading && <div className="upload-progress" role="status"><span /> {tr(lang, "uploading")}</div>}
        </div>
      </section>

      <aside className="cart-zone" aria-label={`${tr(lang, "cart")} · ${tr(lang, "agentActions")}`}>
        <CartPanel cart={cart} flashSkus={flashSkus} cartUrl={cartUrl} lang={lang} />
        <details className="trace-panel">
          <summary>{tr(lang, "agentActions")} <span>{trace.length}</span></summary>
          {trace.length === 0 ? <p>{tr(lang, "noToolsYet")}</p> : (
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
