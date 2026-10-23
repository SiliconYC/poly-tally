/**
 * Human-readable linear axes, following Feijiang's Qt chart convention.
 * Keep domain endpoints and labels on the same regular step; Recharts'
 * automatic ticks can otherwise show unevenly-spaced numbers after padding.
 */
export type NiceAxis = { domain: [number, number]; ticks: number[] };

const STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

function niceStep(minimum: number): number {
  if (!Number.isFinite(minimum) || minimum <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(minimum));
  return (
    STEP_MULTIPLIERS.find((candidate) => candidate * magnitude >= minimum - magnitude * 1e-10) ??
    10
  ) * magnitude;
}

export function niceAxis(
  input: readonly (number | null | undefined)[],
  targetIntervals = 5,
): NiceAxis {
  const values = input.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (!values.length || values.every((value) => value === 0))
    return { domain: [0, 5], ticks: [0, 1, 2, 3, 4, 5] };

  // Histories may contain thousands of snapshots; avoid spreading a large
  // array into Math.min/Math.max, which can exceed the engine argument limit.
  let minimum = 0;
  let maximum = 0;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const low = minimum < 0 ? minimum * 1.08 : 0;
  const high = maximum > 0 ? maximum * 1.08 : 0;
  const step = Math.max(1, niceStep((high - low) / Math.max(2, targetIntervals)));
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  // Multiplication from an integer index, not repeated addition, avoids drift.
  const count = Math.min(20, Math.round((end - start) / step) + 1);
  const ticks = Array.from({ length: count }, (_, index) =>
    Number((start + step * index).toPrecision(14)),
  );
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}

/** Use one unit for every tick on the same axis, including negative values. */
export function axisTickLabel(value: number, ticks: readonly number[]): string {
  if (Math.abs(value) < 1e-10) return "0";
  const useWan = Math.max(0, ...ticks.map((tick) => Math.abs(tick))) > 40_000;
  if (useWan) return `${Number((value / 10_000).toFixed(2))}万`;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}
