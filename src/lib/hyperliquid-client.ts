type Task = { priority: number; basePriority: number; weight: number; wallet?: string; recovery: boolean; queuedAt: number; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };

export function createInfoClient(fetcher: typeof fetch = fetch, observe?: (details: { operation: string; wallet?: string; code?: number; durationMs: number; attempt: number; priority: number; error?: string }) => void,
  options: { archiveInfoUrl?: string; archiveWallets?: Iterable<string> } = {}) {
  const archiveInfoUrl = options.archiveInfoUrl ?? process.env.DC_ARCHIVE_INFO_URL;
  const configuredArchiveWallets = options.archiveWallets ?? process.env.DC_ARCHIVE_WALLETS?.split(",");
  const archiveWallets = new Set([...(configuredArchiveWallets ?? [])].map(wallet => wallet.trim().toLowerCase()).filter(Boolean));
  if (archiveInfoUrl) {
    const url = new URL(archiveInfoUrl);
    if (url.protocol !== "https:" || url.hostname !== "api-hyperliquid-index.n.dwellir.com" || !url.pathname.endsWith("/info") || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid Dwellir Hyperliquid Index URL");
    }
  }
  let diagnosticFailureReported = false;
  const report: NonNullable<typeof observe> = (details) => {
    try { observe?.(details); } catch { if (!diagnosticFailureReported) { console.error("Collector HTTP diagnostics unavailable; requests continue"); diagnosticFailureReported = true; } }
  };
  const queue: Task[] = []; let active = 0; let tokens = 150; let updated = Date.now(); let cooldownUntil = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  let recoveryReserved = 0;
  let viewers = new Set<string>(), favorites = new Set<string>();
  const walletPriority = (wallet: string | undefined, priority: number) => Math.min(priority, wallet && viewers.has(wallet) ? 0 : wallet && favorites.has(wallet) ? 1 : priority);
  function prioritizeWallets(active: Iterable<string>, watched: Iterable<string>) {
    viewers = new Set([...active].map(wallet => wallet.toLowerCase())); favorites = new Set([...watched].map(wallet => wallet.toLowerCase()));
    let changed = false;
    for (const task of queue) { const priority = walletPriority(task.wallet, task.basePriority); if (priority !== task.priority) { task.priority = priority; changed = true; } }
    if (changed) pump();
  }
  const required = (task: Task) => task.weight + (task.priority > 0 ? 20 : 0);
  const background = () => queue.filter((task) => task.recovery && task.basePriority >= 2).sort((a, b) => a.queuedAt - b.queuedAt)[0];
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
  async function post<T>(body: Record<string, unknown>, priority = 1, forceOfficial = false): Promise<T> {
    const history = ["userFills", "userFillsByTime", "historicalOrders", "userFunding", "userNonFundingLedgerUpdates"].includes(String(body.type));
    const wallet = typeof body.user === "string" ? body.user.toLowerCase() : undefined;
    const archive = Boolean(!forceOfficial && archiveInfoUrl && wallet && archiveWallets.has(wallet) && ["userFills", "userFillsByTime"].includes(String(body.type)));
    const extraReserved = history && priority >= 2 && !archive ? 100 : 0;
    const weight = (archive ? 1 : ["clearinghouseState", "spotClearinghouseState", "allMids"].includes(String(body.type)) ? 2 : 20) + extraReserved;
    const attempts = archive ? 2 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
    if (queue.length >= 200) throw new Error("Collector request queue is full");
    let retry = false, retryDelay = 0;
    try { return await new Promise<T>((resolve, reject) => {
      queue.push({ priority: walletPriority(wallet, priority), basePriority: priority, weight, recovery: history, queuedAt: Date.now(), wallet, resolve: resolve as (value: unknown) => void, reject, run: async () => {
          const started = Date.now(), requestPriority = walletPriority(wallet, priority); let code: number | undefined;
          try {
          const response = await fetcher(archive ? archiveInfoUrl! : "https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
          code = response.status;
          if (response.ok) {
            const value = await response.json();
            if (history && Array.isArray(value)) tokens += extraReserved - Math.ceil(value.length / 20);
            else tokens += extraReserved;
            report({ operation: String(body.type), wallet: typeof body.user === "string" ? body.user : undefined, code, durationMs: Date.now() - started, attempt: attempt + 1, priority: requestPriority });
            return value;
          }
          tokens += extraReserved;
          if (response.status !== 429 && response.status < 500) throw new Error(`Hyperliquid API: ${response.status}`);
          const retryAfter = response.headers.get("retry-after"); const seconds = Number(retryAfter);
          const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
          const delay = Number.isFinite(requestedDelay) ? Math.min(300_000, Math.max(10_000, requestedDelay)) : 10_000;
          if (archive) retryDelay = delay; else cooldownUntil = Math.max(cooldownUntil, Date.now() + delay); retry = true;
          throw new Error(`Hyperliquid API: ${response.status}`);
          } catch (error) {
            report({ operation: String(body.type), wallet: typeof body.user === "string" ? body.user : undefined, code, durationMs: Date.now() - started, attempt: attempt + 1, priority: requestPriority, error: error instanceof Error ? error.message : "Unknown request error" });
            throw error;
          }
      } }); pump();
    }); } catch (error) {
      if (!retry || attempt === attempts - 1) {
        if (archive) return post<T>(body, priority, true);
        throw error;
      }
      if (retryDelay) await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
    }
    throw new Error("Hyperliquid retries exhausted");
  }
  return { post, prioritizeWallets, prioritizeWallet: (wallet: string) => prioritizeWallets([...viewers, wallet], favorites),
    pending: () => queue.length, active: () => active, budget: () => ({ tokens, cooldownUntil, weightPerMinute: 600, recoveryReserved, recoveryReservePerMinute: 60 }) };
}
