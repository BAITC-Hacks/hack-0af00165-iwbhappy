Задача P2 №16 из раздела 10 AGENTS.md: вложения в чате.

ТЗ, раздел 5: вход — не только текст, но и файлы (спецификация, фото товара).
Разбор файлов и чтение фото уже написаны. Твоя часть — маршрут загрузки
и интерфейс.

ФАЙЛЫ: src/app/api/upload/route.ts (новый), src/components/AgentApp.tsx,
src/components/ConfirmCard.tsx, src/app/globals.css.

ЧТО УЖЕ ГОТОВО — используй, не переписывай

```ts
// src/lib/spec-parse.ts
parseSpecFile(fileName: string, buf: Buffer): {
  ok: boolean; rows: { article: string; qty: number }[]; skipped: number; error?: string
}
// понимает .xlsx, .xlsm, .csv, .tsv, .txt; .xls честно отклоняет

// src/lib/db.ts
matchSpecRows(rows): Promise<{
  matched: { sku, name, price, qty, available, status }[];
  unmatched: { article, qty }[];
}>
createProposal(sessionId, items: { sku, qty }[]): Promise<Proposal>

// src/lib/llm/vision.ts
extractFromImage(traceId, dataUrl): Promise<VisionExtract>
describeExtract(v: VisionExtract): string
```

НУЖНО

1. `POST /api/upload` — принимает multipart через `await req.formData()`.
   Никаких библиотек: в Next это встроено.

   Поля: `file`, `sessionId`.

   Ограничения (проверять ДО разбора):
   - размер не больше 5 МБ, иначе 413 с понятным текстом;
   - расширения: xlsx, xlsm, csv, tsv, txt, png, jpg, jpeg, webp;
   - всё остальное — 415 с текстом, какие форматы поддерживаются.

   **Таблица** (xlsx/xlsm/csv/tsv/txt):
   - `parseSpecFile` -> при `ok:false` вернуть 422 с `error`;
   - `matchSpecRows(rows)`;
   - если `matched` пуст — вернуть 200 с `{kind:"spec", matched:[], unmatched}`
     и не создавать предложение;
   - иначе `createProposal(sessionId, matched.map(m => ({sku:m.sku, qty:m.qty})))`
     и вернуть `{kind:"spec", proposalId, matched, unmatched, skipped}`.

   **Картинка** (png/jpg/jpeg/webp):
   - собрать data-URL: `data:<mime>;base64,<...>`;
   - `extractFromImage(traceId, dataUrl)`;
   - вернуть `{kind:"photo", extract, message: describeExtract(extract)}`.

   Предложение на спецификацию создаётся на сервере намеренно: разбор
   файла детерминированный, модели там делать нечего. Подтверждение при
   этом остаётся обязательным и идёт тем же путём, что и обычное.

2. Кнопка вложения в поле ввода: скрепка рядом с «Отправить», обычный
   `<input type="file">`. Пока файл грузится — индикатор, кнопка отправки
   заблокирована.

3. **Спецификация** после ответа сервера:
   - показать в чате карточку подтверждения на несколько позиций:
     список `matched` (артикул, название, количество, сумма строки),
     общая сумма, кнопки «Да, добавить всё» и «Нет»;
   - «Да» -> `POST /api/confirm { sessionId, proposalId }` — **тот же
     маршрут, что и для одной позиции**. Ответ содержит `lines[]`,
     `addedTotal`, `cart`;
   - если `unmatched` непуст — показать отдельным блоком: «не нашли в
     каталоге: …». Это обязательно, молча терять строки нельзя;
   - если `skipped > 0` — упомянуть числом.

   ConfirmCard сейчас умеет одну позицию. Расширь его на список, не
   заводя второй компонент: одна позиция — частный случай списка.

4. **Фото** после ответа сервера: отправить `message` из ответа в чат
   обычным `POST /api/chat` как реплику пользователя. Дальше агент сам
   вызовет search_catalog или get_product. Саму картинку в чат модели
   не отправлять — она туда не идёт по архитектуре.
   В ленте сообщений показать миниатюру загруженного фото рядом с этой
   репликой, чтобы на демо было видно, что именно прислали.

5. Ошибки любого рода показывать текстом в чате, а не молча глотать.

НЕ ТРОГАЙ: src/lib/ целиком, src/app/api/chat, /state, /confirm, /reset,
/products, scripts/, data/, AGENTS.md.

ПРОВЕРКА:
  npx tsc --noEmit     — ноль ошибок
  npm run build        — проходит
  npm run smoke        — остаётся зелёным (46 проверок)

Руками: загрузить .csv с двумя артикулами из каталога и одной выдуманной
строкой. Ожидается карточка на две позиции, блок «не нашли» с третьей,
и корзина, которая меняется ТОЛЬКО после нажатия «Да».
