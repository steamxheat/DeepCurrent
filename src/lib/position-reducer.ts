export type Decimal = string;
const pattern = /^-?\d+(?:\.\d{1,30})?$/;

export function validDecimal(value: unknown): value is Decimal {
  return typeof value === "string" && value.length <= 100 && pattern.test(value);
}

function parts(value: Decimal) {
  if (!validDecimal(value)) throw new Error("Invalid decimal");
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

export function decimalAdd(left: Decimal, right: Decimal): Decimal {
  const a = parts(left); const b = parts(right); const scale = Math.max(a.scale, b.scale);
  const units = a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale);
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  const result = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "") : digits;
  return `${units < 0n ? "-" : ""}${result || "0"}`;
}

export const decimalSign = (value: Decimal) => { const n = parts(value).units; return n > 0n ? 1 : n < 0n ? -1 : 0; };
export const decimalEqual = (left: Decimal, right: Decimal) => decimalSign(decimalAdd(left, decimalNegate(right))) === 0;
export const decimalNegate = (value: Decimal) => value.startsWith("-") ? value.slice(1) : `-${value}`;
const abs = (value: Decimal) => value.startsWith("-") ? value.slice(1) : value;

export type PositionState = { size: Decimal; openedAt: number | null; lastTime: number; reason: string | null };
export type ReducerFill = { side: "A" | "B"; sz: Decimal; time: number; startPosition?: Decimal; coin: string };

export function fillTransition(fill: ReducerFill) {
  if (!["A", "B"].includes(fill.side) || !validDecimal(fill.sz) || decimalSign(fill.sz) <= 0 || !Number.isSafeInteger(fill.time) || fill.time < 0) throw new Error("Invalid fill");
  const delta = fill.side === "B" ? fill.sz : decimalNegate(fill.sz);
  if (!validDecimal(fill.startPosition)) return null;
  const before = fill.startPosition; const after = decimalAdd(before, delta);
  const a = decimalSign(before); const b = decimalSign(after);
  const action = fill.coin.startsWith("@") || fill.coin.startsWith("#") || fill.coin.includes("/") ? (fill.side === "B" ? "BUY" : "SELL")
    : a === 0 ? "OPEN" : b === 0 ? "CLOSE" : a !== b ? "FLIP" : decimalSign(decimalAdd(abs(after), decimalNegate(abs(before)))) > 0 ? "ADD" : "REDUCE";
  const direction = action === "BUY" || action === "SELL" ? action : (b || a) > 0 ? "LONG" : "SHORT";
  return { action, direction, before, after };
}

export function reducePosition(prior: PositionState | null, fill: ReducerFill): PositionState {
  const change = fillTransition(fill);
  if (!change) return { size: prior?.size ?? "0", openedAt: null, lastTime: fill.time, reason: "missing_start_position" };
  const continuous = prior !== null && prior.lastTime <= fill.time && prior.reason === null && decimalEqual(prior.size, change.before);
  const newLifecycle = change.action === "OPEN" || change.action === "FLIP";
  const closed = decimalSign(change.after) === 0;
  return { size: change.after, openedAt: closed ? null : newLifecycle ? fill.time : continuous ? prior.openedAt : null,
    lastTime: fill.time, reason: closed || newLifecycle || continuous ? null : "history_gap" };
}

// startPosition orders tied fills; tid and arrival order cannot establish exchange order.
export function orderFillChain<T extends ReducerFill>(fills: T[], initial: PositionState | null = null) {
  const ordered: T[] = []; let state = initial; const ambiguousTimes = new Set<number>();
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  for (let index = 0; index < sorted.length;) {
    const time = sorted[index].time; const remaining: T[] = [];
    while (index < sorted.length && sorted[index].time === time) remaining.push(sorted[index++]);
    while (remaining.length) {
      let matching = remaining.flatMap((fill, i) => validDecimal(fill.startPosition) && decimalEqual(fill.startPosition, state?.size ?? "0") ? [i] : []);
      if (!matching.length) matching = remaining.flatMap((fill, i) => validDecimal(fill.startPosition) && !remaining.some((other, j) => {
        const transition = j === i ? null : fillTransition(other);
        return transition && decimalEqual(transition.after, fill.startPosition!);
      }) ? [i] : []);
      if (remaining.length > 1 && matching.length !== 1) { ambiguousTimes.add(time); state = null; }
      const next = remaining.splice(matching.length === 1 ? matching[0] : 0, 1)[0];
      ordered.push(next); state = reducePosition(state, next);
      if (ambiguousTimes.has(time)) state = { ...state, openedAt: null, reason: "ambiguous_order" };
    }
  }
  return { fills: ordered, state, ambiguous: ambiguousTimes.size > 0, ambiguousTimes };
}
