const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function fetchWithRetry(run: () => Promise<Response>, attempts = 3, pause = sleep) {
  let response: Response | undefined;
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      response = await run();
      if (response.ok || (response.status !== 429 && response.status < 500)) return response;
      const header = response.headers.get("retry-after"); const retryAfter = header === null ? Number.NaN : Number(header);
      if (attempt + 1 < attempts) await pause(Number.isFinite(retryAfter) ? Math.min(2_000, retryAfter * 1_000) : 200 * 2 ** attempt);
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
      failure = error;
      if (attempt + 1 < attempts) await pause(200 * 2 ** attempt);
    }
  }
  if (response) return response;
  throw failure;
}
