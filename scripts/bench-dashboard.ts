import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { stackedHistory, latestTotals, stockChange } from "../web/model.mjs";
import { periodChanges } from "../web/insights.mjs";
import { chartRows } from "../web/src/lib/dashboard";
import type { Repository } from "../web/src/lib/types";

const start = Date.parse("2025-01-01T00:00:00Z");
function measure<T>(name: string, callback: () => T) {
  const before = performance.now();
  const result = callback();
  return { name, ms: Number((performance.now() - before).toFixed(2)), result };
}
export function stressRepositories(
  count = 20,
  snapshots = 500,
  repeated = false,
): Repository[] {
  return Array.from({ length: count }, (_, repoIndex) => ({
    id: `stress-${repoIndex}`,
    name: `Benchmark/repository-${repoIndex}`,
    status: "active",
    rulesVersion: "v1",
    historyComplete: true,
    history: Array.from({ length: snapshots }, (_, index) => {
      const code =
        1000 + (repeated ? Math.floor(index / 100) : index) * 10 + repoIndex;
      const metrics = {
        code,
        comment: 20,
        documentation: 30,
        blank: 40,
        files: 10,
      };
      return {
        timestamp: new Date(
          start + (index * count + repoIndex) * 360000,
        ).toISOString(),
        metrics,
        languages: { TypeScript: metrics },
      };
    }),
  }));
}
if (process.argv[1]?.endsWith("bench-dashboard.ts")) {
  const reports = [];
  for (const [name, count, snapshots, repeated] of [
    ["distinct", 20, 500, false],
    ["repeated", 40, 2500, true],
  ] as const) {
    const repositories = stressRepositories(count, snapshots, repeated);
    const until = repositories.at(-1)!.history.at(-1)!.timestamp;
    const history = measure("stackedHistory", () =>
      stackedHistory(repositories, { until }),
    );
    const projected = measure("chartRows", () =>
      chartRows(history.result, false),
    );
    const totals = measure("latestTotals", () => latestTotals(repositories));
    const changes = measure("periodChanges", () =>
      periodChanges(repositories, { period: "month", until }),
    );
    const delta = measure("stockChange", () =>
      stockChange(repositories, { since: "2025-01-02T00:00:00Z", until }),
    );
    reports.push({
      name,
      repositories: count,
      snapshots: count * snapshots,
      alignedPoints: history.result.points.length,
      renderPoints: projected.result.length,
      measurements: [history, projected, totals, changes, delta].map(
        ({ name, ms }) => ({ name, ms }),
      ),
    });
  }
  await mkdir("docs/qa/react", { recursive: true });
  const report = {
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    generatedAt: new Date().toISOString(),
    reports,
  };
  await writeFile(
    "docs/qa/react/performance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
