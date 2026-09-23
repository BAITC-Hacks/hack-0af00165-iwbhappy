"use client";

import { useState } from "react";

export type ProposalView = { kind: "proposal"; proposalId: string; sku: string; name: string; qty: number; requestedQty: number; price: number; lineTotal: number; available: number; minOrder: number };
type Props = { proposal: ProposalView; onConfirm: (proposal: ProposalView) => Promise<void>; onDecline: () => void };
const money = (value: number) => `${value.toLocaleString("ru-RU")} ₸`;

export default function ConfirmCard({ proposal, onConfirm, onDecline }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const capped = proposal.requestedQty !== proposal.qty;

  return (
    <div className="confirm-card">
      <div className="confirm-kicker">Нужно ваше подтверждение</div>
      <strong>{proposal.name}</strong><span className="confirm-sku">Артикул {proposal.sku}</span>
      {capped && <div className="stock-warning">Запрошено {proposal.requestedQty}, добавим {proposal.qty} — это весь доступный остаток.</div>}
      <div className="confirm-facts">
        <div><span>Количество</span><b>{proposal.qty} шт.</b></div>
        <div><span>Цена за штуку</span><b>{money(proposal.price)}</b></div>
        <div><span>Сумма</span><b>{money(proposal.lineTotal)}</b></div>
      </div>
      {error && <p className="confirm-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" className="confirm-yes" disabled={pending} onClick={() => { setPending(true); setError(""); void onConfirm(proposal).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось подтвердить")).finally(() => setPending(false)); }}>{pending ? "Добавляем…" : "Да, добавить"}</button>
        <button type="button" className="confirm-no" disabled={pending} onClick={onDecline}>Нет</button>
      </div>
      <small>Кнопка «Да» обращается прямо к серверу, минуя модель.</small>
    </div>
  );
}
