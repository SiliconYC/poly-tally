import { describe, expect, it } from "vitest";
import { categoryTickKeys, categoryTickLabel, timeAxisTicks, timeTickLabel } from "./chart-x-axis";

const utc = (value: string) => Date.parse(value);

describe("Qt-style calendar X axis", () => {
  it("selects aligned natural boundaries for a month, not arbitrary timestamp fractions", () => {
    const axis = timeAxisTicks(utc("2026-09-27T14:00:00Z"), utc("2026-10-24T00:00:00Z"), 650);
    expect(axis.unit).toBe("day");
    expect(axis.ticks).toEqual([
      utc("2026-09-28T00:00:00Z"), utc("2026-10-05T00:00:00Z"),
      utc("2026-10-12T00:00:00Z"), utc("2026-10-19T00:00:00Z"),
    ]);
  });
  it("adjusts density for mobile without shifting the full time domain", () => {
    const start = utc("2026-09-27T14:00:00Z");
    const end = utc("2026-10-24T00:00:00Z");
    const desktop = timeAxisTicks(start, end, 650);
    const mobile = timeAxisTicks(start, end, 240);
    expect(mobile.ticks.length).toBeLessThan(desktop.ticks.length);
    expect(mobile.ticks.every((time) => time >= start && time <= end)).toBe(true);
  });
  it("on narrow screens uses natural dates instead of arbitrary window boundaries", () => {
    const days = timeAxisTicks(
      utc("2026-01-01T10:17:00Z"),
      utc("2026-01-04T09:17:00Z"),
      180,
    );
    expect(days.ticks).toEqual([utc("2026-01-02"), utc("2026-01-04")]);
    const minutes = timeAxisTicks(
      utc("2026-10-24T08:17:00Z"),
      utc("2026-10-24T08:32:00Z"),
      180,
    );
    expect(minutes.ticks).toEqual([
      utc("2026-10-24T08:20:00Z"),
      utc("2026-10-24T08:30:00Z"),
    ]);
  });
  it("uses days rather than repeated hour labels for multi-day windows", () => {
    const axis = timeAxisTicks(utc("2026-01-01"), utc("2026-01-04"), 650);
    expect(axis.unit).toBe("day");
    expect(axis.ticks).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].map(utc));
  });
  it("uses true UTC month starts across February leap boundaries", () => {
    const axis = timeAxisTicks(utc("2024-01-15"), utc("2024-05-10"), 720);
    expect(axis.unit).toBe("month");
    expect(axis.ticks).toEqual(["2024-02-01", "2024-03-01", "2024-04-01", "2024-05-01"].map(utc));
    expect(timeTickLabel(axis.ticks[0], axis.unit)).toBe("2024-02");
  });
  it("does not assume the browser local timezone when showing a new year", () => {
    expect(timeTickLabel(utc("2027-01-01T00:00:00Z"), "day", true)).toBe("27-01-01");
    expect(timeTickLabel(utc("2027-01-01T03:00:00Z"), "hour")).toBe("01-01 03:00");
    expect(timeAxisTicks(1000, 1000, 200).ticks).toEqual([1000]);
    expect(timeAxisTicks(2000, 1000, 200).ticks).toEqual([]);
  });
  it("samples evenly spaced categories, keeping both ends on narrow charts", () => {
    const keys = Array.from({ length: 30 }, (_, i) => String(i).padStart(2, "0"));
    expect(categoryTickKeys(keys, 240, 78)).toEqual(["00", "15", "29"]);
    expect(categoryTickKeys(keys, 90, 78)).toEqual(["29"]);
    expect(categoryTickKeys(keys, 5000, 78)).toEqual(keys);
  });
  it("keeps years visible in monthly labels and labels spanning calendar years", () => {
    expect(categoryTickLabel("2026-09", true, false)).toBe("2026-09");
    expect(categoryTickLabel("2026-12-28", false, true)).toBe("26-12-28");
    expect(categoryTickLabel("2027-01-04", false, false)).toBe("01-04");
  });
});
