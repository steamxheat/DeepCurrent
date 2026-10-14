# 100-session overnight QA

`npm run test:soak -- 8 30000 --detach` starts 100 independent virtual HTTP sessions for eight hours. Four requests run concurrently; sessions exercise different scenarios each round. This is not 100 real browsers or a promise of complete UI coverage.

The fixture runs on **127.0.0.1:3002 only** with temporary SQLite and separate admin JSON. All 100 test identities have administrator access **only on that fixture** using a generated dummy signing token. Real production cookies, tokens, admin roles and user records are not used. Telegram and Web Push delivery credentials are disabled. No new PM2 service is created.

Scenarios cover session restoration, wallet snapshots, exact-event filtering/sorting, confluence windows, per-user settings/language/favorites, notification-center create/read/clear, admin configuration, invalid requests/foreign-origin rejection, PWA files, wallet/coin/home HTML, and SSE connect/read/disconnect. The fixture continuously cycles Open/Add/Reduce/Close with fresh snapshots, rather than leaving all data static.

Logs: `backups/qa-soak-<timestamp>/actions.jsonl` and `summary.json`. Every request includes session number, scenario round, route, expected/actual status and duration. No session cookies or signing keys are logged. Summary includes activity/error counts for each of the 100 sessions. Five scenario failures in a round stop the run; slow requests fail checks. Processes run with reduced scheduling priority. Detached runs cap Node heaps at 384 MB per process.

On the server use `DC_SOAK_PRODUCTION_URL=http://127.0.0.1:3000 npm run test:soak -- 8 30000 --detach`. A read-only production request runs once per round; two consecutive failures or responses above two seconds stop QA. This is a safety guard, not full hardware-resource monitoring.

The launcher prints its worker PID. Send SIGTERM to that exact worker PID to stop the run; it stops its fixture server too. Logs and temporary test data are preserved for investigation. Source updates should wait for the run to finish or explicitly stop it first, because the fixture shares the tested build read-only.

Not covered: touch/visual usability, real-device installation/permission prompts, actual phone Push delivery, exchange latency for every wallet, and real copy-trading. Production collector diagnostics must be reviewed alongside QA logs. A passing synthetic run does not certify correct complete historical data.

## Launch verified — 14 October 2026

Source/build: `665b509`, pushed and installed after backup and all server checks. Local short soak: 5,214 checks, all 100 sessions active, 49–54 actions each, zero failures. Server short soak: 4,492 checks, zero failures. Night run: `/home/admin1337/Services/DeepCurrent/backups/qa-soak-1791938276515`, worker PID 77365, eight hours, 30-second rounds. After launch: 100/100 sessions active, at least two actions each, zero errors; production guard 44 ms; fixture listens only on 127.0.0.1:3002. This records startup, not a completed overnight result.

An hourly thread follow-up named “Deep Current: ночной QA и исправления” was created to inspect this run, investigate failures, perform verified fixes and stop after reporting completion. Its local scheduled reviews require the desktop computer and app to remain running; server-side simulation does not depend on the app.
