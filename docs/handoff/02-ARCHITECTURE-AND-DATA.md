# Архитектура и данные

## 1. Стек

- Node.js `>=22.23.3`.
- Next.js `16.4.0`, React `19.3.0`, TypeScript.
- Tailwind CSS 4.
- SQLite через встроенный `node:sqlite`.
- Один Next.js web-процесс и один постоянный collector.
- PM2 на production.
- Hyperliquid REST/WebSocket как основной production-источник.
- Telegram Bot API и Web Push.

Важно: установленный Next.js имеет отличия от известных старых версий. Перед изменением Next API читать соответствующее руководство в `node_modules/next/dist/docs/` и соблюдать `AGENTS.md`.

## 2. Основной поток данных

```text
Hyperliquid REST + WebSocket
        │
        ▼
scripts/collector.mjs
        │
        ├─ raw fills / snapshots / recovery jobs
        ├─ lifecycle projection: Open/Add/Reduce/Flip/Close
        ├─ notification outbox
        └─ collector health
        │
        ▼
SQLite (.data/deep-current.sqlite)
        │
        ├─ Next.js server pages and API
        ├─ SSE /api/live
        ├─ Telegram notifications
        └─ Web Push notifications
```

Рыночное наблюдение и доказанное событие кошелька — разные сущности. Быстрый market print может появиться раньше, но не имеет права называться точным Open/Close без достаточных полей и непрерывности истории.

## 3. Основные части репозитория

### Интерфейс

- `src/app/page.tsx` — входная страница.
- `src/app/dashboard.tsx` — основной интерфейс, рейтинг, live, настройки и уведомления.
- `src/app/wallet/[address]/` — профиль, позиции, история и график кошелька.
- `src/app/coin/[coin]/` — страница рынка.
- `src/app/admin-panel.tsx` — админ-панель.
- `src/app/globals.css`, `DESIGN.md` — визуальная система.

### API

- `POST /api/session` — браузерная сессия на основе Telegram initData.
- `GET/POST/PUT /api/notifications` — настройки и центр уведомлений.
- `GET/POST/DELETE /api/push` — Web Push.
- `GET /api/events` — журнал событий.
- `GET /api/live` — SSE live-поток.
- `GET/POST /api/admin` — администрирование.
- `GET /api/confluences` — совпадения действий нескольких трейдеров.
- `POST /api/wallet/[address]/watch` — приоритет просматриваемого профиля.

### Данные и бизнес-логика

- `src/lib/database.ts` — основное подключение и базовые таблицы.
- `src/lib/fill-journal.ts` — raw-журнал, replay, проекция и очереди.
- `src/lib/live.ts`, `live-stream.ts`, `live-wire.ts` — live-события и доставка.
- `src/lib/position-reducer.ts`, `wallet-reconciliation.ts` — восстановление позиции.
- `src/lib/confirmation-queue.ts`, `recovery-queue.ts`, `fill-recovery.ts` — подтверждение и восстановление истории.
- `src/lib/hyperliquid-client.ts`, `hyperliquid.ts` — источник данных.
- `src/lib/notification-store.ts`, `notifications.ts`, `web-push*.ts` — уведомления.
- `src/lib/wallet-registry.json` — проверенный snapshot рейтинга для чистой установки.

### Исследовательский слой отбора трейдеров

Находится в незакоммиченных файлах:

- `src/lib/copy-selection.ts` — финальные критерии качества.
- `src/lib/dydx-screening.ts`, `dydx-raw-audit.ts` — проверка dYdX.
- `src/lib/lighter-screening.ts` — Lighter.
- `src/lib/cex-screening.ts`, `okx-screening.ts`, `public-exchange-screening.ts` — CEX/public profiles.
- соответствующие `scripts/verify-*`, `audit-*`, `probe-*`.

Это исследование не подключено к production и не должно быть случайно принято за готовую автоторговлю.

## 4. SQLite и доказательства

Production SQLite содержит не только UI-данные, но и журнал, recovery/projection jobs, настройки, подписки и диагностику. Она рассчитана на один серверный экземпляр web + collector.

Правила:

- не удалять `.data` и SQLite ради «чистого запуска»;
- не копировать активные `.sqlite`, `-wal`, `-shm` отдельно;
- использовать `npm run backup:db` или согласованный online backup;
- проверять backup через `PRAGMA quick_check`;
- миграции делать только добавочными и обратимо совместимыми;
- `unknown` хранить как unknown, не как `0` или текущее время.

## 5. Источники времени и точности

Для финансового события важны разные времена:

- `exchangeAt` — биржевое время исполнения;
- `receivedAt` — когда событие получил collector;
- `persistedAt` — когда оно записано;
- `confirmedAt` — когда восстановлена доказанная семантика;
- client received/rendered — когда увидел пользователь.

Нельзя подставлять одно время вместо другого. Старые записи без достоверного времени должны оставаться неизвестными.

## 6. Ограничения текущей архитектуры

- SQLite и in-process live-state не предназначены для горизонтального масштабирования.
- Hyperliquid ограничивает точные user-specific WebSocket подписки; production использует ограниченный прямой набор и более широкий рыночный поток с REST-подтверждением.
- Рыночные события приходят быстро, но подтверждение полного lifecycle может занимать значительно дольше.
- Для нескольких web/collector экземпляров нужны общая БД, распределённые очереди, единый event bus и координация подписок.
