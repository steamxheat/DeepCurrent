import type { RawFill } from "./fill-journal.ts";

export type RecoveryResult = { fills: RawFill[]; complete: boolean; gaps: Array<{ from: number; to: number; reason: string }>; requests: number };

// Split inclusive intervals rather than advancing past a saturated millisecond.
export async function recoverFills(from: number, to: number, fetchPage: (from: number, to: number) => Promise<RawFill[]>, maxRequests = 64): Promise<RecoveryResult> {
  const result: RecoveryResult = { fills: [], complete: true, gaps: [], requests: 0 };
  const rows = new Map<string, RawFill>(); const intervals: Array<[number, number]> = [[from, to]];
  while (intervals.length) {
    const [start, end] = intervals.pop()!;
    if (result.requests >= maxRequests) { result.gaps.push({ from: start, to: end, reason: "request_budget" }); continue; }
    result.requests++;
    try {
      const page = await fetchPage(start, end);
      if (!Array.isArray(page)) throw new Error("Invalid history response");
      for (const fill of page) if (fill.time >= start && fill.time <= end) rows.set(`${fill.coin}:${fill.time}:${fill.tid}`, fill);
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
