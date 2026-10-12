# Развёртывание Deep Current на Mac mini

Инструкция рассчитана на один Mac mini с macOS, один экземпляр Next.js и Telegram-бота. Для Telegram Mini App обязательно нужен публичный HTTPS-адрес.

## 1. Подготовить Mac mini

1. Включить **Системные настройки → Основные → Общий доступ → Удалённый вход**.
2. Установить Homebrew, Git и Node.js 22 LTS:

```bash
brew install git node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version
```

На Intel Mac путь Homebrew обычно `/usr/local`, поэтому отдельная строка с `/opt/homebrew` может не понадобиться.

## 2. Скачать проект

```bash
mkdir -p ~/Services
cd ~/Services
git clone https://github.com/steamxheat/DeepCurrent.git
cd DeepCurrent
npm ci
```

Если репозиторий уже приватный, удобнее добавить SSH deploy key в GitHub и клонировать так:

```bash
git clone git@github.com:steamxheat/DeepCurrent.git
```

## 3. Создать секретное окружение

Скопировать шаблон и открыть его только локально на сервере:

```bash
cp .env.example .env.local
chmod 600 .env.local
nano .env.local
```

Пример содержимого:

```dotenv
TELEGRAM_BOT_TOKEN=НОВЫЙ_ТОКЕН_ИЗ_BOTFATHER
APP_URL=https://pulse.example.com
ADMIN_TELEGRAM_IDS=123456789
```

- Старый токен, который отправлялся в чат, нужно отозвать в BotFather и выпустить заново.
- `ADMIN_TELEGRAM_IDS` — числовые Telegram ID администраторов через запятую.
- Никогда не добавлять `.env.local` в Git: файл уже исключён через `.gitignore`.

## 4. Проверить и собрать

```bash
npm test
npm run lint
npm run check:live
npm run build
```

Проверочный запуск:

```bash
npm start
```

Приложение должно открыться на `http://localhost:3000`. После проверки остановить его через `Ctrl+C`.

## 5. Запустить постоянно через PM2

```bash
npm install --global pm2
cd ~/Services/DeepCurrent
set -a
source .env.local
set +a
pm2 start npm --name dc-pulse-web -- start
pm2 start scripts/bot.mjs --name dc-pulse-bot
pm2 save
pm2 startup
```

Последняя команда покажет ещё одну команду с `sudo`; выполнить её и снова запустить `pm2 save`.

Проверка:

```bash
pm2 status
pm2 logs dc-pulse-web
pm2 logs dc-pulse-bot
```

Запускать несколько экземпляров `dc-pulse-web` пока нельзя: админ-состояние хранится в локальном `.data/admin-state.json`. Telegram-бот с long polling также должен работать только в одном экземпляре.

## 6. Сделать публичный HTTPS

### Рекомендуемый вариант: Cloudflare Tunnel

Он подходит даже без белого IP и не требует открывать порты роутера.

1. Добавить домен в Cloudflare.
2. В **Zero Trust → Networks → Tunnels** создать tunnel для Mac mini.
3. Установить `cloudflared` по команде, которую покажет Cloudflare.
4. Добавить Public Hostname, например `pulse.example.com`.
5. В качестве сервиса указать `http://localhost:3000`.
6. Установить tunnel как системный сервис командой из панели Cloudflare.

После этого проверить:

```bash
curl -I https://pulse.example.com
```

### Вариант с белым IP: Caddy

Понадобятся DNS-запись `A` на публичный IP и проброс портов 80/443 на Mac mini.

```bash
brew install caddy
```

Конфигурация Caddy:

```caddyfile
pulse.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

Caddy должен работать как системный сервис с правом слушать порты 80 и 443. Не публиковать сам порт 3000 напрямую: reverse proxy защищает Node.js от части некорректных и медленных запросов.

## 7. Подключить Telegram Mini App

1. Открыть `@BotFather`.
2. Выполнить `/mybots` и выбрать бота.
3. Открыть **Bot Settings → Menu Button → Configure menu button**.
4. Указать `https://pulse.example.com`.
5. Перезапустить Telegram и проверить кнопку открытия Mini App.
6. Открыть админ-раздел с Telegram-аккаунта, ID которого указан в `ADMIN_TELEGRAM_IDS`.

## 8. Обновление проекта

```bash
cd ~/Services/DeepCurrent
git pull --ff-only
npm ci
npm test
npm run build
set -a
source .env.local
set +a
pm2 restart dc-pulse-web --update-env
pm2 restart dc-pulse-bot --update-env
pm2 save
```

## 9. Полезные команды

```bash
pm2 status
pm2 logs --lines 100
pm2 restart dc-pulse-web
pm2 restart dc-pulse-bot
git log -1 --oneline
```

## Перед публичным запуском

- Сделать GitHub-репозиторий приватным.
- Перевыпустить Telegram bot token.
- Включить резервное копирование папки `.data`.
- Не запускать PM2 в cluster mode.
- Не обещать пользователям доходность: приложение показывает публичную аналитику, а не гарантированные торговые сигналы.
