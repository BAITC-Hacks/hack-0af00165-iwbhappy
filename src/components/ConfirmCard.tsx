"use client";

import { useState } from "react";
import { tr, type Lang } from "./i18n";

export type ProposalLineView = { sku: string; name: string; qty: number; requestedQty: number; price: number; lineTotal: number; available: number; minOrder: number };
export type ProposalView = { kind: "proposal"; proposalId: string; items: ProposalLineView[]; total: number };
type Props = { proposal: ProposalView; onConfirm: (proposal: ProposalView) => Promise<void>; onDecline: () => void; lang: Lang };
const money = (value: number, lang: Lang) => `${value.toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU")} ₸`;

export default function ConfirmCard({ proposal, onConfirm, onDecline, lang }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="confirm-card">
      <div className="confirm-kicker">{tr(lang, "confirmNeeded")}</div>
      <div className="confirm-items">
        {proposal.items.map((item) => (
          <div className="confirm-item" key={item.sku}>
            <strong>{item.name}</strong><span className="confirm-sku">{tr(lang, "article")} {item.sku}</span>
            <div className="confirm-item-total">{item.qty} {tr(lang, "units")} × {money(item.price, lang)} = <b>{money(item.lineTotal, lang)}</b></div>
            {item.requestedQty !== item.qty && <div className="stock-warning">{tr(lang, "requested")} {item.requestedQty}, {tr(lang, "adding")} {item.qty} — {tr(lang, "entireStock")}.</div>}
          </div>
        ))}
      </div>
      <div className="confirm-grand-total"><span>{tr(lang, "total")}</span><b>{money(proposal.total, lang)}</b></div>
      {error && <p className="confirm-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" className="confirm-yes" disabled={pending} onClick={() => { setPending(true); setError(""); void onConfirm(proposal).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : tr(lang, "confirmationFailed"))).finally(() => setPending(false)); }}>{pending ? `${tr(lang, "addingNow")}…` : proposal.items.length > 1 ? tr(lang, "yesAddAll") : tr(lang, "yesAdd")}</button>
        <button type="button" className="confirm-no" disabled={pending} onClick={onDecline}>{tr(lang, "no")}</button>
      </div>
      <small>{tr(lang, "directConfirmation")}</small>
    </div>
  );
}
