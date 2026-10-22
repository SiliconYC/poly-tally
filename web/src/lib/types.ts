export type Metric =
  "total" | "code" | "comment" | "documentation" | "blank" | "files";
export type Metrics = Record<Exclude<Metric, "total">, number>;
export interface Snapshot {
  timestamp: string;
  metrics: Metrics;
  languages: Record<string, Metrics>;
  sha?: string;
  committedAt?: string;
  authoredAt?: string;
  displayBoundary?: boolean;
}
export interface Repository {
  id: string;
  name: string;
  status: string;
  rulesVersion: string;
  history: Snapshot[];
  visibility?: "public" | "private";
  snapshotKind?: string;
  url?: string | null;
  branch?: string | null;
  head?: string | null;
  historyComplete?: boolean;
  lastSuccessAt?: string | null;
  lastCommitDate?: string | null;
  dataFreshness?: string;
  notice?: string;
  skippedFiles?: number;
  displayBaseline?: Snapshot;
  lineage?: { members?: unknown[]; dominantRepositoryId?: string };
}
export interface Run {
  finishedAt: string;
  repositories?: number;
  durationSeconds?: number;
  failed?: number;
  cacheHits?: number;
  parsedBlobs?: number;
  objectReads?: number;
  recomputedCommits?: number;
  completeness?: { complete?: boolean };
}
export interface Dataset {
  schemaVersion: number;
  generatedAt: string;
  rules: { version: string; description?: string };
  repositories: Repository[];
  collector?: { version?: string };
  runs?: Run[];
  display?: { historyStart?: string };
  lineageVersion?: string;
  completeness?: { complete?: boolean };
  publication?: {
    privateStatus?: string;
    privateUpdatedAt?: string | null;
    privateSource?: string | null;
    privateRulesVersion?: string;
  };
}
export interface Filters {
  mode: "current" | "archive";
  ids: string[];
  scope: "all" | "public" | "private";
  includeStale: boolean;
  language: string;
  metric: Metric;
  period: string;
}
export interface HistoryPoint {
  timestamp: string;
  value: number;
  values: (number | null)[];
}
export interface HistoryResult {
  series: { id: string; name: string }[];
  points: HistoryPoint[];
}
export interface ChangePeriod {
  period: "day" | "week" | "month";
  key: string;
  label: string;
  since: string;
  until: string;
  change: number | null;
  compared: number;
  missing: number;
  partial: boolean;
}
export interface HistoryOptions {
  metric?: Metric;
  language?: string;
  since?: string;
  until?: string;
}
