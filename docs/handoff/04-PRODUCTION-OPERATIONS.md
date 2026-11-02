# Production и эксплуатация

Подтверждено read-only проверкой 2 ноября 2026 года.

## Срочное предупреждение безопасности

Production и локальный checkout используют `next@16.4.0`. На 2 ноября `npm audit` сообщает две critical RCE advisory (`GHSA-2464-fhr4-w9xw`, `GHSA-673q-mjm6-r5xr`) и high DoS (`GHSA-p3m5-59mp-jv5r`) для диапазона до 16.4.0 включительно. Доступное non-major исправление — `16.4.4`.

Следующее изменение production должно сначала подготовить и проверить security-upgrade в отдельном release/worktree. Не обновлять зависимости непосредственно внутри работающей папки и не считать повторный build без обновления устранением риска.

## 1. Сервер

- Tailscale-имя: `mac-mini`.
- Несмотря на имя, ОС сервера: **Ubuntu 24.04.5 LTS**, не macOS.
- SSH-пользователь: `admin1337`.
- Проект: `/home/admin1337/Services/DeepCurrent`.
- Ветка: `main`.
- Git HEAD: `06dc6d94fc6788260f8f5d3c84996e5c35b81947`.
- Production build ID: `03D54Z0gEz8knHXMjDOHCPM2`.

SSH выполняется через Tailscale и SSH-ключ. Пароль Mac/Ubuntu в репозитории не нужен и не хранится.

Пример подключения:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=15 \
  -o 'ProxyCommand=/Applications/Tailscale.app/Contents/MacOS/Tailscale nc %h %p' \
  admin1337@mac-mini
```

Tailscale может периодически потребовать подтверждение входа владельцем tailnet. Это не следует обходить.

## 2. Процессы

На момент проверки online:

| PM2 name | Назначение | Режим |
| --- | --- | --- |
| `dc-pulse-web` | `npm start`, Next.js | 1 fork |
| `dc-pulse-bot` | `node scripts/bot.mjs`, collector + bot | 1 fork |

Оба запускаются через `/home/admin1337/server/bin/run-with-vpn`.

Проверка без раскрытия окружения:

```bash
pm2 status
pm2 logs dc-pulse-web --lines 100
pm2 logs dc-pulse-bot --lines 100
```

Не запускать второй collector и не переводить web в cluster mode без отдельной переработки хранения и live-state.

## 3. Сеть и постоянная ссылка

- Deep Current внутри tailnet: `http://mac-mini:3000/`.
- Публичный адрес: `https://mac-mini.tail50f09f.ts.net/`.
- Проверенный ответ: HTTP 200, title `Deep Current — whale intelligence`.

Текущая схема сложнее старого прямого proxy:

```text
Tailscale Funnel :443
  → 127.0.0.1:9080
  → shared router /home/admin1337/shmotki/server/src/tailscale-router.mjs
  → Deep Current 127.0.0.1:3000
```

Порт `:8443` ведёт к другому проекту (`Polycopi`, localhost:8082). Не менять Funnel/router как изолированную настройку Deep Current: он разделяется с другим приложением.

Для доступа к публичной ссылке пароль пользователя не требуется. Пароль администратора нужен только для отдельных системных изменений; текущий SSH использует ключ и Tailscale.

## 4. База и диск

На production:

- `.data/deep-current.sqlite` — около 38.4 GB;
- активный WAL на момент проверки — около 301 MB;
- вся `.data` — около 37 GB по `du`;
- `backups/` — около 263 MB.

Нельзя скачивать только `.sqlite`, пока collector пишет: получится неконсистентная копия. Использовать:

```bash
cd /home/admin1337/Services/DeepCurrent
npm run backup:db
```

После создания проверить путь, размер и `PRAGMA quick_check`. Не удалять старую БД или WAL до подтверждённого восстановления из backup.

## 5. Безопасное обновление

Сначала проверить:

```bash
cd /home/admin1337/Services/DeepCurrent
git status --short
git rev-parse HEAD
pm2 status
df -h
```

Затем:

1. Сделать консистентный backup БД.
2. Подготовить отдельную release-папку; первым изменением применить security-upgrade Next.js.
3. Выполнить там `npm ci`, `npm audit --omit=dev`, тесты, lint, TypeScript, live check и build.
4. Использовать только `git pull --ff-only origin main`.
5. Сохранить предыдущие `.next` и `node_modules` для отката.
6. Переключить сборку и перезапустить **существующие** два PM2-процесса с `--update-env`.
7. Проверить localhost, публичный HTTPS, API, SSE, collector health и логи.
8. При проблеме вернуть предыдущую сборку, не откатывая и не удаляя SQLite.

Не принимать наличие нового Git HEAD или папки release за доказательство того, что runtime действительно обновлён. Сравнивать build ID и фактические процессы.

## 6. Shadow и реальные действия

- Исследования и миграции сначала проводить в shadow.
- Не включать реальные Telegram/Web Push рассылки во время fixture/QA.
- Реальная торговля в текущем production отсутствует и не должна появляться как побочный эффект screening-скрипта.

## 7. Мониторинг

Минимум:

```bash
npm run check:journal
npm run report:collector -- 12
pm2 logs dc-pulse-bot --lines 200
curl -I http://127.0.0.1:3000/
curl -I https://mac-mini.tail50f09f.ts.net/
```

Следить за disconnect/reconnect, subscription limits, HTTP 429, recovery/projection backlog, возрастом snapshots, observed/confirmed задержкой и размером WAL/диска.
