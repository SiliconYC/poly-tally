import type { Dataset, Repository, Snapshot } from "./types";
export const snapshot = (date: string, code: number): Snapshot => ({
  timestamp: date.includes("T") ? date : date + "T00:00:00Z",
  metrics: { code, comment: 2, documentation: 3, blank: 1, files: 2 },
  languages: {
    TypeScript: { code, comment: 2, documentation: 3, blank: 1, files: 2 },
  },
});
export const repository = (
  id: string,
  history = [snapshot("2026-01-01", 10), snapshot("2026-02-01", 20)],
): Repository => ({
  id,
  name: `owner/${id}`,
  status: "active",
  rulesVersion: "v1",
  history,
  historyComplete: true,
  visibility: "public",
  url: `https://github.com/owner/${id}`,
  branch: "dev",
});
export const fixture = (): Dataset => ({
  schemaVersion: 1,
  generatedAt: "2026-02-15T12:00:00Z",
  rules: { version: "v1", description: "统一物理行口径" },
  repositories: [
    repository("alpha"),
    {
      ...repository("beta"),
      visibility: "private",
      url: null,
      branch: null,
      head: null,
      snapshotKind: "daily",
    },
  ],
  runs: [
    {
      finishedAt: "2026-02-15T12:00:00Z",
      repositories: 1,
      failed: 0,
      durationSeconds: 3,
    },
  ],
});
