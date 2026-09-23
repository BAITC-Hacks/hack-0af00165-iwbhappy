"use client";

import { useState } from "react";

export type ProposalLineView = { sku: string; name: string; qty: number; requestedQty: number; price: number; lineTotal: number; available: number; minOrder: number };
export type ProposalView = { kind: "proposal"; proposalId: string; items: ProposalLineView[]; total: number };
type Props = { proposal: ProposalView; onConfirm: (proposal: ProposalView) => Promise<void>; onDecline: () => void };
const money = (value: number) => `${value.toLocaleString("ru-RU")} ₸`;

export default function ConfirmCard({ proposal, onConfirm, onDecline }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const capped = proposal.items.some((item) => item.requestedQty !== item.qty);

  return (
    <div className="confirm-card">
      <div className="confirm-kicker">Нужно ваше подтверждение</div>
      <div className="confirm-items">
        {proposal.items.map((item) => (
          <div className="confirm-item" key={item.sku}>
            <strong>{item.name}</strong><span className="confirm-sku">Артикул {item.sku}</span>
            <div className="confirm-item-total">{item.qty} шт. × {money(item.price)} = <b>{money(item.lineTotal)}</b></div>
            {item.requestedQty !== item.qty && <div className="stock-warning">Запрошено {item.requestedQty}, добавим {item.qty} — это весь доступный остаток.</div>}
          </div>
        ))}
      </div>
      <div className="confirm-grand-total"><span>Итого</span><b>{money(proposal.total)}</b></div>
      {error && <p className="confirm-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" className="confirm-yes" disabled={pending} onClick={() => { setPending(true); setError(""); void onConfirm(proposal).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось подтвердить")).finally(() => setPending(false)); }}>{pending ? "Добавляем…" : proposal.items.length > 1 ? "Да, добавить всё" : "Да, добавить"}</button>
        <button type="button" className="confirm-no" disabled={pending} onClick={onDecline}>Нет</button>
      </div>
      <small>Кнопка «Да» обращается прямо к серверу, минуя модель.</small>
    </div>
  );
}
