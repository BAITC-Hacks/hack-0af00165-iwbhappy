# Архитектура ассистента ekt.kz

## Поток данных

```mermaid
flowchart LR
    browser["Браузер / виджет"] -->|"POST /api/chat"| chat["Маршрут чата"]
    chat --> loop["Агентный цикл"]
    loop <-->|"tool-calling"| model["Модель / офлайн mock"]
    loop <--> tools["9 инструментов"]
    tools <--> db[("SQLite / Turso")]
    chat -->|"SSE: токены, действия, корзина"| browser
    browser --> upload["POST /api/upload"]
    upload --> parse["spec-parse / vision"]
    parse --> proposal["Предложение pending"]
    proposal --> db
    upload -->|"Карточка предложения"| browser
    browser -->|"Кнопка Да"| confirm["POST /api/confirm"]
    confirm --> consume["consumeProposal"]
    consume --> db
    confirm -->|"Корзина, ссылка, сопутствующие"| browser
```

В [`loop.ts`](../src/lib/agent/loop.ts) модель выбирает инструменты,
а [`tools.ts`](../src/lib/agent/tools.ts) получает данные из БД и проверяет
действия. [`client.ts`](../src/lib/llm/client.ts) отвечает за стриминг,
таймауты, ретраи и переход к [`mock.ts`](../src/lib/llm/mock.ts).
Вложения разбираются в [`spec-parse.ts`](../src/lib/spec-parse.ts) и
[`vision.ts`](../src/lib/llm/vision.ts): таблица или накладная создаёт
предложение, фото изделия возвращает запрос для поиска. Каталог засевается
из `data/catalog.json`, запросов к API партнёра в рантайме нет. Локально
используется файловая SQLite; на Vercel нужна общая Turso для всех
маршрутов. Полностью офлайн-демо запускается локально с файловой БД
и `LLM_MODE=mock`; распознавание PDF и фотографий требует модели.

## Подтверждение добавления

```mermaid
sequenceDiagram
    actor Client as Клиент
    participant UI as Интерфейс
    participant Agent as Агент
    participant Server as Сервер
    participant DB as SQLite
    Client->>UI: Добавь товар
    UI->>Agent: POST /api/chat
    Agent->>Server: propose_add(sku, qty)
    Server->>DB: createProposal(sessionId), status=pending
    DB-->>Server: proposalId
    Server-->>Agent: Предложение и данные карточки
    Agent-->>UI: Карточка подтверждения
    Note over UI,DB: Корзина пока не меняется
    Client->>UI: Да
    alt Подтверждение текстом
        UI->>Agent: POST /api/chat, последняя реплика
        Agent->>Server: confirm_add(proposalId)
        Server->>Server: Предложение создано в прошлом ходу
        Server->>Server: Сырая реплика явно подтверждает
        Server->>Server: Согласие не относится к другому артикулу
    else Подтверждение кнопкой
        UI->>Server: POST /api/confirm, sessionId и proposalId
        Note over UI,Server: Запрос идёт напрямую, минуя модель
    end
    alt Проверки пройдены
        Server->>DB: consumeProposal(sessionId, proposalId)
        DB->>DB: UPDATE proposals WHERE status='pending' AND session_id=...
        Note right of DB: Только одноразовое предложение своей сессии
        DB->>DB: Количество с учётом корзины ограничено остатком
        DB-->>Server: Обновлённая корзина или отказ
        Server-->>UI: Корзина и ссылка с токеном для чтения
    else Проверка отклонена
        Server-->>UI: Отказ, корзина не меняется
    end
```

Три проверки в [`runConfirm`](../src/lib/agent/tools.ts) защищают текстовый
путь. Кнопка обращается к [`/api/confirm`](../src/app/api/confirm/route.ts)
без модели. Оба пути используют только
[`consumeProposal`](../src/lib/db.ts): условный `UPDATE` одновременно
проверяет сессию и переводит предложение из `pending` в `used`; повторный
вызов не добавит товар. Остаток ограничивает итоговое количество с учётом
уже лежащего в корзине. Ссылка `/cart?c=…` открывает актуальную корзину
только для чтения. Проверки: `npm run smoke`, разделы 4 и 5;
сквозной сценарий — `npm run demo`.
