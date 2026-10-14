# BTC, cache, real positions and collector — 14 October 2026

## Reproduced cache and market lookup defects

The old coin loader waits for every DEX's context even when BTC is found on the main market. It also sends millisecond-varying start/end times in its candle POST body. Next's fetch cache includes the body in its key: the 15-second revalidation option does not make those distinct bodies share a cache entry.

Fix `eefd878`: resolve the main market first; explicitly namespaced assets only resolve on their requested DEX; preserve cross-DEX fallback for other assets. Quantize candle request boundaries to the existing 15-second cache lifetime. Journal windows still use the exact current time. No collection budget, positions, notification behavior or schema changed.

Regression tests cover BTC avoiding unrelated DEXes, explicit venue isolation, missing assets, failed DEX fallback, stable candle keys, different assets and TTL boundaries. 135/135 tests, lint, TypeScript, local/server builds and real API checks passed.

## Measured on the Mac mini

The profiler runs a separate temporary fixture server on localhost:3001. It instruments upstream calls and SQLite SELECTs without logging credentials or query parameters. It does not alter the production database or the ongoing 100-session soak. With proxy-enabled Node, localhost must bypass the proxy: `NO_PROXY=localhost,127.0.0.1,::1`.

| Measurement | Installed old build | Fixed isolated build |
| --- | ---: | ---: |
| Cold page, total | 2,622 ms | 1,223 ms |
| Cold external-request wall time | 1,288 ms | 774 ms |
| Cold SQLite SELECT time, fixture | 1.38 ms | 1.03 ms |
| Cold non-upstream wall time | 1,334 ms | 449 ms |
| Warm pages, total | 875 / 647 ms | 86 / 71 ms |
| Warm upstream requests | one candle request each | zero |

Non-upstream wall time includes rendering, scheduling, cache handling and body transfer; it is not a pure CPU measurement. The production coin journal query was separately measured read-only: 10,000 rows, SQL 37 ms, JSON parsing 64 ms. Three requests are not a latency SLA. The 11 prior >5-second soak responses cannot all be causally attributed to these defects without upstream traces from those exact requests.

## Public API and feed reconciliation

Three public wallets: `0x399965e15d4e61ec3529cc98b7f7ebb93b733336`, `0x024294c53a69c1e6b39810b3fac87385752fffa1`, `0xfdf891f2b214a4c9374d26595ec6d4080262e381`.

Two independent point-in-time checks retained 6,000 fills and 89 current positions across 36 successful scoped API responses. Replay produced no duplicate events. Latest sample: 26 opening dates proved by retained fills; 63 unknown. This is a bounded API seed, not a complete historical index. Earlier sample had 29 proved openings; changing API retention means independent short-history reconstructions can lose old evidence, reinforcing the need to preserve the journal.

Production feed: 100 exact events returned for each of the first two wallets; 96 and 99 executions matched the API sample. All matched price, size, side, fee, closed PnL, starting position, hash, action and direction. Five feed rows were outside the fetched sample, which is not proof of a mismatch: the fetches are not atomic and source history is capped. The third wallet returned zero exact feed events, so its feed cannot be certified by this check. Current-position status is not atomically reconciled by these execution comparisons.

## Collector observations, one-hour sample

Observed receive delay p95 approximately 0.66 seconds; exact confirmation p95 approximately 98 seconds; 4,900 sampled fills unconfirmed. HTTP userFillsByTime requests returned 200, average 303 ms, maximum 965 ms. No cooldown samples. Projection backlog zero; 871 markets and 10 exact user subscriptions.

Recovery backlog grew to 285 wallets. Sustained priority-0 confirmations consume the 600-weight/minute budget, while background history recovery waits at priority 4 and requires reserved weight. No recovery requests completed in the sampled hour: this is starvation of backfill, not evidence that exchange network requests themselves take 98 seconds. No budget or priority policy was silently changed.

One clean-but-unexpected WebSocket close (1000), reconnect after 3,597 ms. One rejected unresolved `#85530` market fill was recorded, not silently admitted as exact. Minute samples missed the brief disconnect; zero disconnected samples must not be reported as zero disconnects. Last saved scopes were old when no real profiles were open; that is not evidence of fresh positions for all wallets.

## Rollout state and remaining work

Fixes are committed/pushed and tested in an isolated server release, not yet swapped into the public site's running build. Keep the original eight-hour soak intact; deploy after it finishes using the backup/release checks in this chat. Review the final soak, prevent background-recovery starvation with an explicitly measured scheduling policy, and retain honest unknown-date/source-age labels. No phone Push delivery, complete 1,000-wallet correctness or exact <=3-second guarantee is certified.
