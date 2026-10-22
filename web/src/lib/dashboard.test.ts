import { describe, it, expect } from "vitest";
import {
  chartRows,
  warningsFor,
  initialFilters,
  historyWindow,
  safeRepositoryUrl,
  copyName,
} from "./dashboard";
import { fixture, repository, snapshot } from "./fixtures";
import { stackedHistory } from "../../model.mjs";

describe("history projection", () => {
  it("preserves every change and unknown transition, removes only identical intermediate states", () => {
    const result = stackedHistory(
      [
        repository("early", [
          snapshot("2026-01-01", 10),
          snapshot("2026-01-02", 10),
          snapshot("2026-01-03", 5),
        ]),
        repository("late", [snapshot("2026-01-04", 5)]),
      ],
      { until: "2026-01-05T00:00:00Z" },
    );
    const rows = chartRows(result, false);
    expect(rows.map((row) => [row.timestamp, row.v0, row.v1])).toEqual([
      ["2026-01-01T00:00:00Z", 10, 0],
      ["2026-01-03T00:00:00Z", 5, 0],
      ["2026-01-04T00:00:00Z", 5, 5],
      ["2026-01-05T00:00:00Z", 5, 5],
    ]);
    expect(result.points[0].values[1]).toBeNull();
    expect(chartRows(result, true).at(-1)?.v1).toBe(50);
  });
  it("never compresses differing repository contributions when the total is unchanged", () => {
    const result = {
      series: [
        { id: "a", name: "a" },
        { id: "b", name: "b" },
      ],
      points: [
        { timestamp: "2026-01-01T00:00:00Z", value: 10, values: [10, 0] },
        { timestamp: "2026-01-02T00:00:00Z", value: 10, values: [5, 5] },
        { timestamp: "2026-01-03T00:00:00Z", value: 10, values: [5, 5] },
      ],
    };
    expect(chartRows(result, false)).toHaveLength(3);
  });
});
it("retains explicit empty selection and clamps history to display start", () => {
  const data = fixture();
  expect(initialFilters(data).ids).toEqual(["alpha", "beta"]);
  data.display = { historyStart: "2026-01-15T00:00:00Z" };
  expect(historyWindow(data, "all").since).toBe("2026-01-15T00:00:00.000Z");
});
it("warns about incomplete lineage, isolated old rules, stale omissions and retained dates", () => {
  const data = fixture();
  data.lineageVersion = "v1";
  data.completeness = { complete: false };
  data.repositories[0].status = "stale";
  data.repositories[1].rulesVersion = "old";
  data.publication = {
    privateStatus: "retained",
    privateUpdatedAt: "2026-01-02T00:00:00Z",
  };
  const text = warningsFor(data, initialFilters(data)).join(" ");
  expect(text).toContain("全量重算未完成");
  expect(text).toContain("旧规则");
  expect(text).toContain("过期");
  expect(text).toContain("2026/01/02");
});
it("allows only public GitHub https links without embedded credentials", () => {
  const repo = repository("alpha");
  expect(
    safeRepositoryUrl({ ...repo, url: "https://github.com/owner/alpha" }),
  ).toBe("https://github.com/owner/alpha");
  for (const url of [
    "javascript:alert(1)",
    "https://user:pass@github.com/x/y",
    "https://evil.test/x",
    "http://github.com/x/y",
  ])
    expect(safeRepositoryUrl({ ...repo, url })).toBeNull();
  expect(
    safeRepositoryUrl({
      ...repo,
      url: "https://github.com/x/y",
      visibility: "private",
    }),
  ).toBeNull();
});
it("waits for clipboard success and reports rejection honestly", async () => {
  let finish!: () => void;
  const pending = copyName(repository("alpha"), {
    writeText: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  finish();
  await expect(pending).resolves.toEqual({
    ok: true,
    message: "已复制 owner/alpha",
  });
  await expect(
    copyName(repository("alpha"), {
      writeText: async () => {
        throw new Error("denied");
      },
    }),
  ).resolves.toMatchObject({ ok: false });
});

it("overview includes the event exactly at the configured lower boundary using its retained earlier baseline", async () => {
  const { overviewChange } = await import("./dashboard");
  const data = fixture();
  data.generatedAt = "2026-01-31T00:00:00Z";
  data.display = { historyStart: "2026-01-01T00:00:00Z" };
  const repo = repository("boundary", [
    snapshot("2026-01-01", 20),
    snapshot("2026-01-31", 25),
  ]);
  repo.displayBaseline = snapshot("2025-12-31", 10);
  data.repositories = [repo];
  expect(overviewChange(data, [repo], initialFilters(data)).change).toBe(15);
});

it("counts only eligible stale snapshots as included, keeping old rules isolated", () => {
  const data = fixture();
  data.repositories[0].status = "stale";
  data.repositories[1].status = "stale";
  data.repositories[1].rulesVersion = "old";
  const filters = { ...initialFilters(data), includeStale: true };
  const warning = warningsFor(data, filters).find((message) =>
    message.includes("已明确纳入"),
  );
  expect(warning).toContain("已明确纳入 1 个");
});
