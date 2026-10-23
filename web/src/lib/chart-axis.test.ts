import { describe, expect, it } from "vitest";
import { axisTickLabel, niceAxis } from "./chart-axis";

describe("regular Qt-style vertical axes", () => {
  it("uses equal round steps, zero baseline and visible headroom for growing stock", () => {
    const axis = niceAxis([57500, 100000]);
    expect(axis.domain).toEqual([0, 125000]);
    expect(axis.ticks).toEqual([0, 25000, 50000, 75000, 100000, 125000]);
    expect(axis.ticks.map((tick) => axisTickLabel(tick, axis.ticks))).toEqual([
      "0", "2.5万", "5万", "7.5万", "10万", "12.5万",
    ]);
  });

  it("keeps negative and positive ticks aligned across zero", () => {
    const axis = niceAxis([-12500, 100000, null]);
    expect(axis.ticks).toEqual([-25000, 0, 25000, 50000, 75000, 100000, 125000]);
    expect(axisTickLabel(-25000, axis.ticks)).toBe("-2.5万");
  });

  it("places zero at the top for exclusively negative changes", () => {
    const axis = niceAxis([-9300, -200]);
    expect(axis.domain[1]).toBe(0);
    expect(axis.ticks).toEqual([-12500, -10000, -7500, -5000, -2500, 0]);
  });

  it("shows exact integers for small changes and is safe for missing values", () => {
    expect(niceAxis([null, Number.NaN, undefined, 0]).ticks).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceAxis([1]).ticks).toEqual([0, 1, 2]);
    expect(axisTickLabel(2500, [0, 2500, 5000])).toBe("2,500");
  });
});
