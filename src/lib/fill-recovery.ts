import type { RawFill } from "./fill-journal.ts";

export type RecoveryResult = { fills: RawFill[]; complete: boolean; gaps: Array<{ from: number; to: number; reason: string }>; requests: number };

// Split inclusive intervals rather than advancing past a saturated millisecond.
export async function recoverFills(from: number, to: number, fetchPage: (from: number, to: number) => Promise<RawFill[]>, maxRequests = 64): Promise<RecoveryResult> {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || !Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("Invalid recovery interval or request budget");
  const result: RecoveryResult = { fills: [], complete: true, gaps: [], requests: 0 };
  const rows = new Map<string, RawFill>(); const intervals: Array<[number, number]> = [[from, to]];
  while (intervals.length) {
    const [start, end] = intervals.pop()!;
    if (result.requests >= maxRequests) { result.gaps.push({ from: start, to: end, reason: "request_budget" }); continue; }
    result.requests++;
    try {
      const page = await fetchPage(start, end);
      if (!Array.isArray(page)) throw new Error("Invalid history response");
      for (const fill of page) {
        if (!fill || typeof fill.coin !== "string" || typeof fill.tid !== "number" || !Number.isSafeInteger(fill.tid) || fill.tid < 0 || !Number.isSafeInteger(fill.time) || fill.time < start || fill.time > end) throw new Error("Invalid history fill");
        // Keep contradictory observations so the journal can flag conflicts instead of silently choosing one.
        rows.set(`${fill.coin}:${fill.time}:${fill.tid}:${JSON.stringify(fill)}`, fill);
      }
      if (page.length >= 2_000) {
        if (start === end) result.gaps.push({ from: start, to: end, reason: "saturated_timestamp" });
        else { const middle = start + Math.floor((end - start) / 2); intervals.push([middle + 1, end], [start, middle]); }
      }
    } catch (error) { result.gaps.push({ from: start, to: end, reason: error instanceof Error ? error.message : "fetch_failed" }); }
  }
  result.fills = [...rows.values()].sort((a, b) => a.time - b.time);
  result.complete = result.gaps.length === 0;
  return result;
}

export function recoveryCoverage(result: RecoveryResult, from: number, to: number, seedStart: number, unconfirmed: boolean, job?: { from_time: number | null; through_time: number | null }) {
  const provenFrom = Math.max(from, seedStart);
  const covered = result.complete && !unconfirmed;
  const complete = covered && (job?.from_time == null || job.from_time >= provenFrom) && (job?.through_time == null || job.through_time <= to);
  const reason = unconfirmed ? "unconfirmed_executions" : !result.complete ? "incomplete_interval" : job?.through_time != null && job.through_time > to ? "incomplete_interval" : !complete ? "older_history_not_proven" : null;
  return { from: covered ? provenFrom : from, through: to, status: covered ? "covered_interval" : "gap", complete, reason };
}
