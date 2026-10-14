type Task = { priority: number; weight: number; wallet?: string; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };

export function createInfoClient(fetcher: typeof fetch = fetch, observe?: (details: { operation: string; wallet?: string; code?: number; durationMs: number; attempt: number; priority: number; error?: string }) => void) {
  let diagnosticFailureReported = false;
  const report: NonNullable<typeof observe> = (details) => {
    try { observe?.(details); } catch { if (!diagnosticFailureReported) { console.error("Collector HTTP diagnostics unavailable; requests continue"); diagnosticFailureReported = true; } }
  };
  const queue: Task[] = []; let active = 0; let tokens = 150; let updated = Date.now(); let cooldownUntil = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const required = (task: Task) => task.weight + (task.priority > 0 ? 20 : 0);
  function pump() {
    clearTimeout(timer); const now = Date.now(); tokens = Math.min(150, tokens + (now - updated) / 100); updated = now;
    queue.sort((a, b) => a.priority - b.priority);
    // shortcut: sustained urgent traffic can delay backfill; never advertise complete history while recovery is pending.
    if (queue.length && now < cooldownUntil) { timer = setTimeout(pump, cooldownUntil - now); return; }
    // Keep one HTTP slot available for new fill confirmations rather than backfill.
    while (queue.length && active < (queue[0].priority <= 0 ? 4 : 3) && tokens >= required(queue[0])) {
      const task = queue.shift()!; tokens -= task.weight; active++;
      task.run().then(task.resolve, task.reject).finally(() => { active--; pump(); });
    }
    if (queue.length && tokens < required(queue[0])) timer = setTimeout(pump, Math.max(10, (required(queue[0]) - tokens) * 100));
  }
  async function post<T>(body: Record<string, unknown>, priority = 1): Promise<T> {
    const history = ["userFills", "userFillsByTime", "historicalOrders", "userFunding", "userNonFundingLedgerUpdates"].includes(String(body.type));
    const extraReserved = history && priority >= 2 ? 100 : 0;
    const weight = (["clearinghouseState", "spotClearinghouseState", "allMids"].includes(String(body.type)) ? 2 : 20) + extraReserved;
    for (let attempt = 0; attempt < 3; attempt++) {
    if (queue.length >= 200) throw new Error("Collector request queue is full");
    let retry = false;
    try { return await new Promise<T>((resolve, reject) => {
      queue.push({ priority, weight, wallet: typeof body.user === "string" ? body.user.toLowerCase() : undefined, resolve: resolve as (value: unknown) => void, reject, run: async () => {
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
    pending: () => queue.length, active: () => active, budget: () => ({ tokens, cooldownUntil, weightPerMinute: 600 }) };
}
