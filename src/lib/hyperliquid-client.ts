type Task = { priority: number; weight: number; wallet?: string; recovery: boolean; queuedAt: number; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };

export function createInfoClient(fetcher: typeof fetch = fetch, observe?: (details: { operation: string; wallet?: string; code?: number; durationMs: number; attempt: number; priority: number; error?: string }) => void) {
  let diagnosticFailureReported = false;
  const report: NonNullable<typeof observe> = (details) => {
    try { observe?.(details); } catch { if (!diagnosticFailureReported) { console.error("Collector HTTP diagnostics unavailable; requests continue"); diagnosticFailureReported = true; } }
  };
  const queue: Task[] = []; let active = 0; let tokens = 150; let updated = Date.now(); let cooldownUntil = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  let recoveryReserved = 0;
  const required = (task: Task) => task.weight + (task.priority > 0 ? 20 : 0);
  const background = () => queue.filter((task) => task.recovery && task.priority >= 2).sort((a, b) => a.queuedAt - b.queuedAt)[0];
  function pump() {
    clearTimeout(timer); const now = Date.now(), elapsed = Math.max(0, now - updated); tokens = Math.min(150, tokens + elapsed / 100); updated = now;
    const waiting = background();
    // Accumulate 60 weight/minute from the existing 600 budget, including worst-case response reservation.
    recoveryReserved = waiting ? Math.min(required(waiting), recoveryReserved + elapsed / 1000) : 0;
    queue.sort((a, b) => a.priority - b.priority);
    if (queue.length && now < cooldownUntil) { timer = setTimeout(pump, cooldownUntil - now); return; }
    // Keep one HTTP slot available for new fill confirmations rather than backfill.
    while (queue.length) {
      const recovery = background();
      const task = recovery && recoveryReserved >= required(recovery) ? recovery : queue[0];
      const needed = required(task) + (task === recovery ? 0 : recoveryReserved);
      if (active >= (task.priority <= 0 ? 4 : 3) || tokens < needed) break;
      queue.splice(queue.indexOf(task), 1); tokens -= task.weight; active++;
      if (task === recovery) recoveryReserved = 0;
      task.run().then(task.resolve, task.reject).finally(() => { active--; pump(); });
    }
    if (queue.length) {
      const recovery = background(), task = recovery && recoveryReserved >= required(recovery) ? recovery : queue[0];
      const needed = required(task) + (task === recovery ? 0 : recoveryReserved);
      const reserveWait = recovery && recoveryReserved < required(recovery) ? (required(recovery) - recoveryReserved) * 1000 : Infinity;
      if (tokens < needed || reserveWait < Infinity) timer = setTimeout(pump, Math.max(10, Math.min(tokens < needed ? (needed - tokens) * 100 : Infinity, reserveWait)));
    }
  }
  async function post<T>(body: Record<string, unknown>, priority = 1): Promise<T> {
    const history = ["userFills", "userFillsByTime", "historicalOrders", "userFunding", "userNonFundingLedgerUpdates"].includes(String(body.type));
    const extraReserved = history && priority >= 2 ? 100 : 0;
    const weight = (["clearinghouseState", "spotClearinghouseState", "allMids"].includes(String(body.type)) ? 2 : 20) + extraReserved;
    for (let attempt = 0; attempt < 3; attempt++) {
    if (queue.length >= 200) throw new Error("Collector request queue is full");
    let retry = false;
    try { return await new Promise<T>((resolve, reject) => {
      queue.push({ priority, weight, recovery: history, queuedAt: Date.now(), wallet: typeof body.user === "string" ? body.user.toLowerCase() : undefined, resolve: resolve as (value: unknown) => void, reject, run: async () => {
          const started = Date.now(); let code: number | undefined;
          try {
          const response = await fetcher("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
          code = response.status;
          if (response.ok) {
            const value = await response.json();
            if (history && Array.isArray(value)) tokens += extraReserved - Math.ceil(value.length / 20);
            else tokens += extraReserved;
            report({ operation: String(body.type), wallet: typeof body.user === "string" ? body.user : undefined, code, durationMs: Date.now() - started, attempt: attempt + 1, priority });
            return value;
          }
          tokens += extraReserved;
          if (response.status !== 429 && response.status < 500) throw new Error(`Hyperliquid API: ${response.status}`);
          const retryAfter = response.headers.get("retry-after"); const seconds = Number(retryAfter);
          const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
          const delay = Number.isFinite(requestedDelay) ? Math.min(300_000, Math.max(10_000, requestedDelay)) : 10_000;
          cooldownUntil = Math.max(cooldownUntil, Date.now() + delay); retry = true;
          throw new Error(`Hyperliquid API: ${response.status}`);
          } catch (error) {
            report({ operation: String(body.type), wallet: typeof body.user === "string" ? body.user : undefined, code, durationMs: Date.now() - started, attempt: attempt + 1, priority, error: error instanceof Error ? error.message : "Unknown request error" });
            throw error;
          }
      } }); pump();
    }); } catch (error) { if (!retry || attempt === 2) throw error; }
    }
    throw new Error("Hyperliquid retries exhausted");
  }
  return { post, prioritizeWallet: (wallet: string) => { for (const task of queue) if (task.wallet === wallet.toLowerCase() && task.priority > 0) task.priority = 0; pump(); },
    pending: () => queue.length, active: () => active, budget: () => ({ tokens, cooldownUntil, weightPerMinute: 600, recoveryReserved, recoveryReservePerMinute: 60 }) };
}
