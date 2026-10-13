# Deep Current: этап 1 — аудит достоверности и производительности

Дата: 13 октября 2026. Контрольная точка: перед проектированием нового журнала и переходом к реализации.

## Область проверки

Проверены текущая локальная рабочая копия, production на `macmini`, SQLite обоих окружений, Hyperliquid REST, публичные HTTP-страницы, логика профиля/ленты/совпадений/скрининга/Copyability и браузерные фильтры. Исходный commit обоих окружений: `55a3d5c`. Локально есть незакоммиченные PWA/Push/сессионные изменения; их нельзя включать в аудит-коммит или перезаписывать.

Production-код, процессы и торговая база не изменялись. Создана консистентная SQLite backup через `node:sqlite.backup`, сохранена конфигурация в каталоге с правами 700. Локальная backup: `.data/audit-2026-10-13T15-03-28.086Z/backup.sqlite`; серверная: `/home/admin1337/Services/DeepCurrent/backups/audit-stage1-20261013/database.sqlite`. Секретные env находятся только в этих закрытых backup-каталогах и не входят в Git. Проверка server backup: `quick_check=ok`.

Результаты независимого REST-аудита записываются в `.data/audit-2026-10-13T15-03-28.086Z/evidence.json`. Скрипт: `scripts/audit-data.mjs`; повторный запуск принимает путь каталога и продолжает непроверенные адреса. Он читает текущую базу без записи и не вызывает отправку уведомлений.

Завершённая выборка: **50/50 кошельков, 97 245 fills, 185 открытых позиций**. Адреса равномерно выбраны из bundled registry и сверены с текущим leaderboard; основной DEX проверен у всех 50, остальные DEX у первых пяти. У 48 адресов userFills достиг лимита 2000. Алгоритм вернул unknown для 99 позиций. В двух случаях последний fill-after расходится с последующим snapshot: это требует проверки race/неполной истории/изменения без fill, а не автоматического объявления ошибки биржи. В одном из них NIL алгоритм всё равно выдал openedAt, хотя согласованность с snapshot не доказана. Комиссия положительна в 97 206 fills, отрицательных в этой выборке нет. У трёх bundled адресов текущий 30D PnL неположителен: текущий getLeaderboard их исключает, но сам bundled registry не равен актуально прошедшей проверку выборке.

На момент завершения 162 REST-запроса: 154 успешных ответа, 8 ответов 429; после повторов все 50 проверок успешны. p50 успешного запроса 327мс, p95 1628мс, измерено с локального компьютера, не через серверный VPN. Проверка не является повторной полной 60-дневной квалификацией всех 1000 адресов.

## Карта данных

| Значение | Источник и обработчик | Хранилище | Реальное качество / проблема |
|---|---|---|---|
| Рейтинг, капитал, 30D PnL | leaderboard → getLeaderboard | кеш процесса 180 с | Ошибка источника превращается в пустой рейтинг, а не в сохранённую выборку |
| Winrate 60D | userFillsByTime → screenWallet | wallet_screenings + bundled JSON | Неверный знак fee; closing-транзакция не равна завершённой позиции; скрининг не имеет срока годности |
| Рыночное исполнение | WebSocket trades → recordTrade | processed_fills / wallet_events | Реальные время/цена/BUY/SELL; не содержит startPosition, fee, closedPnl, oid |
| Производное Open/Add/Reduce/Close | снимок + рыночные дельты → flushGroup | wallet_positions / wallet_events | Маркируется exact без доказательства непрерывности потока |
| История fills | REST → getWalletFills → getWalletDetail | кеш процесса + wallet_events | Импорт зависит от посещения профиля; нет единого курсора ingestion |
| Открытые позиции | clearinghouseState по DEX → getWalletDetail | position_snapshots | Частичная ошибка DEX незаметно убирает позиции; снимки разных моментов |
| Время открытия | positionOpenedAt(currentSize, fills) | вычисляется на запросе | Игнорирует startPosition и разрывы истории |
| Закрытые позиции | closedTrades(fills) | completed_trades | Неверная комиссия; неизвестный initial entry может превратиться в ложную среднюю цену |
| Торговый поток монеты | recentJournal → getCoinFlow | вычисляется на запросе | Включает ledger и другие неторговые события, дублирует raw/group |
| Участники монеты | latestCoinSnapshots + coinParticipants | position_snapshots | Закрытия не инвалидируют старые снимки; «нет данных» показывается как отсутствие трейдеров |
| Совпадения | findConfluences в браузере | буфер максимум 2000 событий | stillOpen без сверки; только часть кошельков; независимость эвристическая |
| Copyability | copyabilityScore + sampleCopyability | copy_samples / расчёт | Модельное проскальзывание, stale last trade; нет гарантии цены исполнения |
| LIVE | открытие браузерного WebSocket / updatedAt запроса | React state | Не доказывает успешную подписку и свежесть каждого значения |
| Уведомления | flushGroup → subscribers → send | inbox / внешняя доставка | Нет durable outbox; ошибки/рестарт теряют доставку |

## Подтверждённые дефекты по приоритету

### P0 — нельзя считать безопасным основанием для автоматического копирования

1. **Неверный знак комиссии.** `src/lib/stats.ts:44`, `closedTrades`, `src/lib/wallet-screening.ts`, `src/lib/hyperliquid.ts:getCoinFlow`, `src/lib/copyability.ts`. Сейчас `closedPnl + fee`, должно учитывать API fee как расход: для USDC `closedPnl - fee`; отрицательная комиссия является rebate. Независимая фикстура: gross=10, fee=1 → приложение 11 вместо 9. Для spot нельзя складывать комиссию в другом токене с USD без конвертации. Текущие тесты используют отрицательную fee как расход и закрепляют ошибку.

2. **Ложное время открытия при неполной/несогласованной истории.** `src/lib/stats.ts:64`. Алгоритм идёт назад от currentSize, вычитая размеры fills, и не сравнивает с explicit startPosition. Фикстура: current=1, fill before=20, buy=1 → возвращает дату fill, хотя fill не открыл позицию. Нет согласованного времени снимка и журнала; добавление новых сделок между запросами также даёт расхождение.

3. **Нет восстановления пропущенных fills после reconnect.** `scripts/bot.mjs:recordTrade/connectMarkets`. События раньше streamStartedAt−2с игнорируются, затем выполняется seed состояния без backfill истории. Снимок восстанавливает количество, но не открытия/закрытия, время, fee и PnL пропущенной сделки.

4. **Производное событие объявляется точным.** `scripts/bot.mjs:flushGroup`. `exactWallets` означает полный seed по DEX, а не точную userFills-подписку: collector подписан только на `trades`. Любая потеря/перестановка/неполный seed ломает цепочку; события всё равно записываются `precision=exact`.

5. **Неатомарная обработка.** `markFillProcessed` выполняется до записи позиции и journal. Падение между операциями навсегда помечает необработанный fill обработанным. Группы находятся только в памяти; остановка в течение debounce 1500мс теряет journal/уведомление при уже изменённой позиции. Нет транзакции raw event + cursor + state + derived event + outbox.

6. **Неполный seed считается успешным и может удалить позиции.** `seedWallet` использует Promise.allSettled, объединяет только успешные DEX, затем replaceStoredPositions удаляет старые строки и readyWallets помечает кошелёк готовым. В профиле та же ошибка скрывает DEX как нулевой/отсутствующий, а не unavailable.

### P1 — конкретные несогласованности продукта

7. **Дубликаты одной сделки из разных источников.** `eventKey` в web и `keyId:...:group` в collector различаются. В production найдено 65 групп с одинаковыми wallet/coin/time/tid и двумя строками market/userFills. Пример BLUR у `0x185611e0343c14f53a4406891cb0fdc9e81808ae`: OPEN/OPEN. INSERT OR IGNORE защищает только строковый event_key и не решает межисточниковый дубль.

8. **Буфер ленты теряет отдельные fills и сохраняет агрегат рядом с raw.** `src/lib/live.ts:mergePulseFills` не включает tid в ключ. Два fills с одинаковыми hash/time/price/size, но разными tid → одна строка. В обратном сценарии агрегированная userFills-строка остаётся вместе с частичными рыночными исполнениями, объём считается повторно. Нужны отдельные raw fills и отображаемые order executions.

9. **Старые позиции продолжают считаться открытыми.** `recordPositionSnapshots` пишет только присутствующие позиции; закрытия не оставляют zero/tombstone. `latestCoinSnapshots/currentPositionCoverage` выбирают последнее по каждой монете, а не актуальный полный scope-снимок кошелька. В production найдены 2 строки-кандидата, старше последнего снимка того же кошелька, но ещё внутри freshness-окна. Это кандидаты на stale, не доказанные закрытия. `coinParticipants` также превращает size=0 в SHORT; фикстура воспроизведена.

10. **Ledger считается торговлей.** `getCoinFlow` не фильтрует action. В браузере строка USDC показывает ~$3M «продали» по двум неторговым событиям. На странице монеты coinFlowChange аналогично не ограничивает action до торговли, если присутствует direction.

11. **Отсутствие охвата показывается как отсутствие трейдеров.** В локальной базе всего 3 кошелька имеют snapshots, и они устарели, но все 40 movers показывают «Наших трейдеров нет». Общий баннер есть, отрицательные утверждения строк всё равно ложны. Требуется три состояния: verified none / matches / coverage unavailable.

12. **Снимок основного DEX обновляется, HIP-3 — лишь для exact-set.** `syncPositionCoverage` вызывает clearinghouseState без dex. Для большинства 1000 адресов HIP-3 состоянию неоткуда появиться; рыночный BUY/SELL сам по себе не является открытием. Сам каталог также обрезается до 995 рынков без явного списка исключённых рынков.

13. **Неправильная точность и неизвестная длительность.** `src/app/wallet/[address]/page.tsx:held/opened`. Для неизвестного открытия выводится `≥ now-globalOldestFill`, хотя самая старая сделка другого рынка не доказывает нижнюю границу возраста этой позиции. Текст «точное по startPosition» не соответствует алгоритму. Текущая версия уже не назначает всем позициям snapshotTime как openedAt; старые скриншоты не доказывают, что это всё ещё происходит. В production wallet_positions одинаковые non-null opened_at в одном кошельке не найдены; основной дефект сейчас — неизвестные времена и недостоверное восстановление.

14. **Совпадения не сверяются с текущим состоянием.** `findConfluences` выставляет stillOpen=true по отсутствию close в ограниченном буфере. Только 120 fills/кошелёк, максимум 1200 exact +800 market, market исключается. Окно 24ч не означает наличие 24ч истории. Контекст copyability не передаётся из dashboard; корреляция трёх похожих входов не доказывает одного владельца.

15. **Фильтры работают по неполному буферу.** Профиль отдаёт 50 completed и 1000 fills; отображает 50 строк после сортировки. Нет серверной пагинации полного journal. Лента имеет newest/largest, но нет oldest/date-range и отдельных OPEN/ADD/REDUCE/CLOSE. Фильтр source проверяет transport source вместо confidence; undefined source считается exact. Long/Buy и Short/Sell смешивают сторону исполнения с направлением позиции. Браузерный порог $100K и сортировка largest прошли проверку, это не полностью сломанный интерфейс.

16. **ADD без startPosition отображается OPEN.** `activityKind`: fallback проверяет long/short, не ADD/FLIP. Фикстура `dir=ADD LONG, source=user, startPosition=undefined` → OPEN exact=true. Также raw journal→PulseFill при FLIP восстанавливает side по конечному направлению; спот должен иметь отдельную BUY/SELL модель.

17. **Ложный LIVE и свежесть.** `info` хранит fallback до 5 минут, но возвращает только value без source timestamp. Глобальный infoFallbackHits смешивает параллельные запросы. updatedAt=Date.now обозначает конец обработки, а не свежесть биржевого состояния. WebSocket onopen выставляет LIVE до subscription ack; error-channel и rejected subscription не обработаны.

18. **Неполная история может объявляться полной.** Страница с <2000 fills трактуется как полная; API предоставляет только 10000 последних fills, более старые сделки могут уже отсутствовать. Пагинация по oldest−1 может обрезать остальные исполнения с тем же millisecond на границе страницы. Нет проверки startPosition-chain и coveredFrom/coveredTo. Кеш истории только в процессе и 100 адресов; ошибка incremental fetch маскируется пустым массивом.

19. **Copyability не является реальным backtest копирования.** Last traded price берётся без timestamp/стакана, задержки отсчитываются после aggregation/получения, а не exchange time. `measured` означает несколько записанных last-price samples. Формула комиссий ошибочна и feeBps повторно добавляет комиссию в cost. Подменять это исполненным результатом 1/3/10/30 секунд нельзя.

20. **История и рейтинг могут исчезать при ошибке API.** getDashboardData превращает failed leaderboard в []; тяжёлый getWalletDetail выполняет множество REST-запросов и синхронных SQLite-записей на каждый просмотр/refresh. Нет сохранённого ответа с per-field age. Все браузеры дополнительно открывают сотни market-подписок напрямую, конкурируя за лимиты и CPU клиента.

21. **Outbox и backpressure отсутствуют.** Notification delivery выполняется по подписчикам последовательно после journal; ошибка Web Push может прервать дальнейшую доставку. Ошибка Telegram лишь логируется. Не сохраняются durable pending/retry/attempts, нет bounded queue. Debounce по wallet/coin/side/hash не равен объединению одной заявки: oid отсутствует в trades.

22. **Скрининг не доказывает критерии навсегда.** bundled назначает historyComplete=true; merge не проверяет age screenedAt, future lastActive, коррекцию fee и rolling requalification. Требование >5 транзакций реализовано как >5 сгруппированных закрытий, а winrate не по полным позициям. 30D PnL повторно проверяется leaderboard, но остальные показатели остаются прежними.

## Измерения production

SSH доступен, проверка 13 октября примерно 18:05 MSK: load average 0.21/0.15/0.10, available RAM 14453MB, swap=0, диск свободен 39GB. Collector средний CPU ~6.9%, web ~1.6%; это один спокойный снимок, не нагрузочный тест.

Публичный HTTP, с gzip: главная first-byte 72мс, полная передача 6.08с, 152481 байт; профиль `0x3999...3336` first-byte 39мс, полная передача 5.13с, 125866 байт. Быстрый shell/TTFB не доказывает быструю готовность данных.

Production SQLite quick_check=ok. Снимки охватывали 587 адресов, из них 538 со снимком не старше 15 минут. Сохранено 2254 позиции, 2146 с opened_at=NULL (95.2%). Unknown не следует заменять guessed timestamp. Из последних 10 минут journal: market observed средняя задержка 477мс, max1835мс; derived exact средняя 1977мс, max2823мс. Это exchange timestamp→SQLite recorded_at, не время появления в браузере/уведомлении и не доказательство точности.

Дополнительный замер: observed 2608 событий, p50=411мс, p95=680мс, p99=865мс; derived exact 1016 событий, p50=1926мс, p95=2236мс, p99=2420мс. PM2 подтвердил ровно один online web и collector, NODE_USE_ENV_PROXY=1 у обоих. Сеть уже доставляет события быстро; latency точного полного lifecycle и render нужно измерить отдельно.

Многоступенчатый sequential coverage имеет паузу 250мс на адрес: минимум 250с на 1000 даже без сети. Заявление «точные позиции всех 1000 обновляются за 1–3 секунды» на текущей архитектуре не подтверждается. Быстрые BUY/SELL уже возможны; exact lifecycle требует достоверного baseline, непрерывности и recovery.

## Минимальная архитектура следующего этапа

1. Один raw fill со стабильным ключом `(chain, wallet, canonical market, exchange time, tid)`; hash/oid сохраняются отдельно. Market identity включает DEX и spot/perp, display symbol не ключ.
2. Raw поля: exchangeTime, receivedAt, persistedAt, startPosition, side, size, price, fee, feeToken, closedPnl, oid, taker/maker, source. Рыночный trade без этих полей хранится с evidence=observed.
3. Состояние позиции: signedSize, lifecycleId, openedAt nullable, confidence, checkpointTime, lastProcessedKey, continuity/gaps, scope coverage. Неизвестное открытие остаётся nullable.
4. Raw event, cursor, position state, derived lifecycle event, delivery outbox записываются атомарно. Replay одного журнала даёт одинаковый результат после любого рестарта.
5. REST bootstrap для всех DEX + stream buffering + catch-up до общей watermark. Partial scope никогда не считается пустым. При gap временно приостанавливать exact inference и восстанавливать fills, затем сверять snapshot.
6. Полный snapshot scope имеет capture/source timestamp и coverage; исчезнувшая позиция закрывается snapshot-tombstone, но точное закрытие не придумывается. Snapshot reconciliation не создаёт выдуманный Open.
7. Execution aggregation отдельна от raw ingestion: oid при наличии; иначе обозначенная эвристика. Хранить first/last execution time и список fill IDs, не один случайный hash/tid агрегата.
8. Web читает materialized state/history через собственный API, пагинацию и SSE/WebSocket. Цена обновляется общим потоком; пользовательская страница не импортирует историю синхронно. Active viewers/favorites задают приоритет сверки.
9. PostgreSQL нужна при подтверждённых требованиях к concurrent writes/долгой истории; Redis — при распределённой рассылке и очередях. Их установка сама по себе не исправляет P0. Сначала schema, invariants и replay, затем выбор storage по измерениям на целевом сервере.
10. Метрики: exchange→receive→persist→emit→render; freshness по полю, completeness scope/history; 429, reconnect gaps, reconciliation drift; notification enqueue/delivered отдельно.

## Критерии приёмки этапов 2–6

- Fee=+1 уменьшает USDC PnL на 1, fee=−1 увеличивает на 1; commission token конвертируется явно. Пересчитать производные показатели после миграции, исходные fills сохранить.
- Один fill, пришедший через REST+WS и после 3 reconnect, присутствует один раз; несколько разных tid в одной millisecond не сливаются.
- Open→Add→Reduce→Close и Flip проходят replay, out-of-order и crash-between-writes тесты; Add/Reduce не меняют openedAt.
- Missing baseline/gap/partial DEX → unknown или reconstructed с причиной. Ни одного guessed exact timestamp.
- Безопасный backfill восстанавливает пропущенные исполнения; граница страницы с несколькими одинаковыми timestamp не теряет записи.
- Закрытая позиция не остаётся в coin coverage; пустой успешно проверенный scope отличается от failed scope.
- Ledger/funding/order/collateral не увеличивают торговые volume/net-flow; spot sell не называется SHORT.
- Фильтры и sort применяются к полному серверному query с pagination, а не только к 50/120 строкам.
- Confluence отражает реальную coverage, current-state и неизвестность, перечисляет участников; эвристика связи адресов помечена.
- Доставка outbox переживает рестарт; повторной видимой записи уведомления нет, ошибки не прерывают остальных получателей.
- Цель latency p95≤3с — измеряемое условие для live events при заданном потоке и покрытии; unknown нельзя скрывать ради достижения метрики. 1000 concurrent users — отдельный нагрузочный тест, текущего доказательства нет.
- Production переход только после shadow comparison и проверенного rollback; исторические данные мигрируются с происхождением и неизвестностью.

## Источники и ограничения

Hyperliquid: [WebSocket schema](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions), [info endpoint/history cap](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), [IP limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits). Актуальная schema явно говорит fee<0=rebate и глобальный trade ID=(block_time, coin, tid). Next.js guides прочитаны из установленного Next16.4: connection/fetch.

46/46 существующих тестов, ESLint и production build прошли. Это baseline сборки, не сертификат правильности финансовых данных. Отдельные audit assertions воспроизвели четыре ошибки; браузерная проверка подтвердила ошибку USDC-flow и рабочие amount/sort controls.

Поправка к исходному большому плану: историческое открытие должно оставаться в ленте после закрытия, с отдельным current-status, а не удаляться как будто его не было. Exact время исходного fill не означает exact время начала жизненного цикла. Обещание 1–3 секунд для всех точных данных всех 1000 адресов было предварительной оценкой без нагрузочного доказательства; сохраняем его только как целевой SLO, проверяемый по каждому типу данных и покрытию. Приватный ключ/автоторговля не входят в текущую реализацию.

Не выполнены реальные торговые заявки, отправка тестовых Telegram/Push, стресс 1000 пользователей, полный многодневный backfill и сравнение автоматически восстановленной истории с полным chain index. Неизвестную историю нельзя сделать точной задним числом из ограниченного REST.

## Передача на первую контрольную точку

Следующая задача: проверить эту архитектуру и P0 findings, зафиксировать schema/инварианты/план миграции и только затем переходить к реализации журнала. Модель: GPT-6 Astra, Medium для независимого архитектурного review; затем GPT-6.1 Sol, High для этапов 2–6. Production не деплоить на основании прохождения нынешних тестов. Незакоммиченные PWA изменения принадлежат прежней работе, сохранять.
