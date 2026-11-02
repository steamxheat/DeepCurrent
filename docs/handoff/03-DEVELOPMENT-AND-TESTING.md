# Разработка и проверки

## 1. Локальная установка

```bash
git clone https://github.com/steamxheat/DeepCurrent.git
cd DeepCurrent
node --version   # требуется >=22.23.3
npm ci
cp .env.example .env.local
chmod 600 .env.local
```

Секретные значения получает владелец проекта отдельно. Не использовать production-токены для локальных исследований.

Запуск web:

```bash
npm run dev
```

Запуск collector с локальным окружением:

```bash
set -a
source .env.local
set +a
npm run collector
```

По умолчанию безопасный режим журнала — `DC_JOURNAL_MODE=shadow`.

## 2. Переменные окружения

Публичный список и комментарии находятся в `.env.example`:

- `TELEGRAM_BOT_TOKEN`
- `APP_URL`
- `ADMIN_TELEGRAM_IDS`
- `DEEPCURRENT_DB_PATH`
- `CONFLUENCE_WINDOW_MS`
- `TRACKED_WALLETS`
- `DC_JOURNAL_MODE`
- `DC_ARCHIVE_INFO_URL`, `DC_ARCHIVE_WALLETS` — опциональный Dwellir-пилот
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

Нельзя просить передать `.env.local` через Git, чат или обычную почту.

## 3. Обязательная проверка перед merge/deploy

```bash
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run check:live
npm run build
```

Дополнительные проверки по затронутой области:

```bash
npm run check:journal
npm run report:collector -- 12
npm run check:realtime -- http://localhost:3000/api/live 100 60000
```

`check:realtime` и soak используют HTTP/SSE-сессии, а не полноценные браузеры или реальные телефоны. Они не подтверждают физический Push, работу графиков и полный путь source → render.

### Состояние проверки 2 ноября 2026 года

- `npm test`: **220/220 passed**.
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- `npm run check:live`: passed, 48,246 кошельков и 2,000 fills в выборке.
- `npm run build`: компиляция, TypeScript и генерация страниц прошли, но команда завершилась `exit 1` из-за встроенного security-блокера Next.js.

`npm audit --omit=dev` нашёл прямую critical-уязвимость в `next@16.4.0` (две RCE advisory и одна high DoS); доступно совместимое исправление `next@16.4.4`. Перед следующим deploy выполнить security-upgrade в отдельном worktree и повторить полный набор проверок. Нельзя обходить блокер простым повтором build и считать это исправлением.

## 4. Работа с Next.js

Перед изменением маршрутов, caching, server/client boundaries, metadata или сборки:

1. прочитать `AGENTS.md`;
2. найти руководство именно установленной версии в `node_modules/next/dist/docs/`;
3. проверить deprecation notes;
4. не переносить старые Next.js-паттерны по памяти.

## 5. Правила безопасной разработки

- Сначала искать существующий helper и все его callers.
- Не смешивать production-код и одноразовые screening/probe-скрипты.
- Любая новая финансовая ветка, parser или очередь требует небольшого регрессионного теста.
- Decimal-значения и пороги не сравнивать через плавающий `Number`, если решение зависит от границы.
- Ошибка/пустой ответ источника не равны отсутствию позиции или нулевому PnL.
- При разрыве потока необходимы reconnect, gap detection и backfill.
- Не запускать параллельные workers одного источника в обход лимитов.

## 6. Тестовые данные

- Основные unit-тесты находятся рядом с `src/lib/*.ts`.
- QA fixture использует отдельную SQLite и fake admin.
- Production SQLite не должна использоваться в тестах на запись.
- Исследовательские evidence лежат в `backups/`; большинство из них не должно попадать в Git.

## 7. Работа с грязным деревом

На 2 ноября 2026 года tracked-файлы не изменены, но есть большой набор untracked-файлов. Перед любыми массовыми командами:

```bash
git status --short
git ls-files --others --exclude-standard
```

Не применять `git clean`, `git reset --hard` или удаление `backups/`: там находятся результаты многодневных проверок.
