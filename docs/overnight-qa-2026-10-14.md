# Overnight QA — failed original run, fixes and retest

Original fixture run `qa-soak-1791938545579`: stopped by its failure guard after 6.7107 hours, not a completed eight-hour pass. All 100 sessions executed at least 1,170 actions. Total checks: 117,425; failures: 85, all `/coin/BTC` slow responses or request timeouts. Session, settings, favorites, admin, events, confluence, wallet HTML, PWA and notification-center scenarios recorded no failures. SSE scenarios have separate `sse_frame` logs, not normal HTTP request counters. This is virtual HTTP testing, not touch/visual or real phone Push certification.

Production guard stayed fast around the stop (110–115 ms), and production returned HTTP 200 afterwards. This does not certify every production page.

Prepared/verified cache changes avoid waiting for unrelated venues and reuse stable 15-second candle POST keys. New fix `11381d4` adds one four-second upstream deadline for the entire coin request, stops retries after AbortError/TimeoutError, and labels unavailable or previously saved market data. A deliberately stalled API on the local isolated build returned three pages in 4,052 / 4,030 / 4,029 ms with the degraded-source label. This bounds external waiting, not all server CPU or end-to-end network time. 136 unit tests passed locally, along with lint, TypeScript and build.

Twelve-hour diagnostics include earlier manual restarts and the already-fixed subscription errors; they must not be counted as new incidents. Latest report: 871 markets, 10 exact user subscriptions, recovery backlog 344, about 20,206 unconfirmed entries in a capped 100,000-fill sample. Receive p95 619 ms; confirmation p95 82,217 ms. UserFillsByTime HTTP: 17,557 successes averaging 306 ms, 24 responses with 429. Extra diagnostic requests can contribute to throttling when they use the same exchange-facing IP; the report does not establish whether the synthetic fixture and proxy-backed collector had the same egress, or which caller caused each 429. Background recovery remains starved by urgent confirmations. This scheduler limitation is not fixed by the page-cache patch.

Retain the original logs. Validate/install the patch using isolated-release checks, consistent DB backup and only the existing single-instance PM2 services. Then start a fresh eight-hour run and keep the current follow-up active until the retest and analysis finish. Do not report the failed run as acceptance passed; exact three-second coverage, all opening dates and physical Web Push remain unverified.

## Installed and retesting

`6e3510c` installed after 137/137 server tests, lint, live check and isolated production build. Server fault injection returned degraded pages in 4,198 / 4,089 / 4,112 ms; short 100-session test: 11,500 checks, zero failures. Continuous writes stalled the original unpinned online backup; a tested read transaction now pins a consistent WAL snapshot. Backup `.data/journal-backup-XxGUU1` verified `quick_check=ok`; interrupted `.data/journal-backup-CceFEf` was retained but is **not a verified backup**. Existing single fork-mode web/collector services restarted with shadow retained.

New eight-hour run: `backups/qa-soak-1791971582228`, runner PID 89616. Original failed run remains preserved. The scheduled follow-up remains active because the full post-fix retest is not complete.
