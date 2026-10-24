/**
 * Calendar-aligned UTC labels for PolyTally's time axes.
 * Based on Feijiang Qt's readable time steps; positions always remain linear
 * in elapsed time (months legitimately have different lengths).
 */
export type TimeUnit = "minute" | "hour" | "day" | "month" | "year";
type Step = { unit: TimeUnit; amount: number };
export type TimeAxis = { ticks: number[]; unit: TimeUnit };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONDAY_UTC = Date.UTC(1970, 0, 5);
const STEPS: Step[] = [
  { unit: "minute", amount: 5 },
  { unit: "minute", amount: 15 },
  { unit: "minute", amount: 30 },
  { unit: "hour", amount: 1 },
  { unit: "hour", amount: 3 },
  { unit: "hour", amount: 6 },
  { unit: "hour", amount: 12 },
  { unit: "day", amount: 1 },
  { unit: "day", amount: 2 },
  { unit: "day", amount: 3 },
  { unit: "day", amount: 7 },
  { unit: "day", amount: 14 },
  { unit: "month", amount: 1 },
  { unit: "month", amount: 2 },
  { unit: "month", amount: 3 },
  { unit: "month", amount: 6 },
  { unit: "year", amount: 1 },
  { unit: "year", amount: 2 },
  { unit: "year", amount: 5 },
  { unit: "year", amount: 10 },
  { unit: "year", amount: 20 },
];

function alignedTicks(start: number, end: number, step: Step): number[] {
  const ticks: number[] = [];
  if (step.unit === "month") {
    const date = new Date(start);
    const startMonth = date.getUTCFullYear() * 12 + date.getUTCMonth();
    let month = Math.ceil(startMonth / step.amount) * step.amount;
    // A boundary at the beginning of the current month may precede start.
    if (Date.UTC(Math.floor(month / 12), month % 12, 1) < start) month += step.amount;
    for (let i = 0; i < 128; i++, month += step.amount) {
      const tick = Date.UTC(Math.floor(month / 12), month % 12, 1);
      if (tick > end) break;
      ticks.push(tick);
    }
  } else if (step.unit === "year") {
    const year = new Date(start).getUTCFullYear();
    let aligned = Math.ceil(year / step.amount) * step.amount;
    if (Date.UTC(aligned, 0, 1) < start) aligned += step.amount;
    for (let i = 0; i < 128; i++, aligned += step.amount) {
      const tick = Date.UTC(aligned, 0, 1);
      if (tick > end) break;
      ticks.push(tick);
    }
  } else {
    const duration =
      step.amount * (step.unit === "minute" ? MINUTE : step.unit === "hour" ? HOUR : DAY);
    // Align weekly intervals to Mondays; smaller units to UTC boundaries.
    const origin = step.unit === "day" && step.amount >= 7 ? MONDAY_UTC : 0;
    let tick = origin + Math.ceil((start - origin) / duration) * duration;
    for (let i = 0; i < 128 && tick <= end; i++, tick += duration) {
      ticks.push(tick);
    }
  }
  return ticks;
}

/** Calculate stable UTC calendar ticks from the visible domain and plot width. */
export function timeAxisTicks(start: number, end: number, plotWidth: number): TimeAxis {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return { ticks: [], unit: "day" };
  if (end === start) return { ticks: [start], unit: "day" };

  const width = Math.max(100, Number.isFinite(plotWidth) ? plotWidth : 320);
  const maxLabels = Math.max(2, Math.min(8, Math.floor(width / 84)));
  for (const step of STEPS) {
    // Wider history windows read better with calendar months / years than
    // a dense stream of fortnight labels.
    if (end - start >= 75 * DAY && (step.unit === "minute" || step.unit === "hour" || step.unit === "day")) continue;
    if (end - start >= 3 * 365 * DAY && step.unit === "month") continue;
    const ticks = alignedTicks(start, end, step);
    if (ticks.length < 2 || ticks.length > maxLabels) continue;
    const minimumDistance = (ticks[1] - ticks[0]) / (end - start) * width;
    const labelWidth = step.unit === "minute" || step.unit === "hour" ? 90 : 62;
    if (minimumDistance >= labelWidth) return { ticks, unit: step.unit };
  }
  // Short windows may not contain two natural boundaries. Preserve exact dates.
  return { ticks: [start, end], unit: end - start < DAY ? "hour" : "day" };
}

/** The axis uses UTC, like snapshot details, even in non-UTC browsers. */
export function timeTickLabel(value: number, unit: TimeUnit, crossYear = false): string {
  const iso = new Date(value).toISOString();
  if (unit === "year") return iso.slice(0, 4);
  if (unit === "month") return iso.slice(0, 7);
  if (unit === "hour" || unit === "minute")
    return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  return crossYear ? iso.slice(2, 10) : iso.slice(5, 10);
}

/** Evenly sample category slots; missing periods must not be squeezed out. */
export function categoryTickKeys(keys: readonly string[], plotWidth: number, labelWidth = 78): string[] {
  if (!keys.length) return [];
  const width = Number.isFinite(plotWidth) ? Math.max(1, plotWidth) : 320;
  const count = Math.min(keys.length, Math.max(1, Math.floor(width / labelWidth)));
  if (count === 1) return [keys[keys.length - 1]];
  const indexes = Array.from({ length: count }, (_, index) =>
    Math.round((index * (keys.length - 1)) / (count - 1)),
  );
  return [...new Set(indexes)].map((index) => keys[index]);
}

/** Render categorical monthly dates in full; daily/weekly in compact UTC form. */
export function categoryTickLabel(key: string, monthly: boolean, crossYear: boolean): string {
  if (monthly) return key;
  return crossYear ? key.slice(2) : key.slice(5);
}
