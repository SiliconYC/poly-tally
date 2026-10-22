import {
  latestTotals,
  repositoryVisibility,
  selectRepositories,
  stockChange,
} from "../../model.mjs";
import type { Dataset, Filters, HistoryResult, Repository } from "./types";

export const format = (value: number) =>
  new Intl.NumberFormat("zh-CN").format(value);
export const compact = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
export const dateLabel = (value: string | number | null | undefined) =>
  value != null && Number.isFinite(new Date(value).getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "尚未成功";
export const metricOrder = [
  "total",
  "code",
  "comment",
  "documentation",
  "blank",
  "files",
] as const;
export const categoricalPalette = [
  "#647f8d",
  "#ad8b73",
  "#83917b",
  "#94859d",
  "#ae8585",
  "#7e9898",
  "#a39a75",
  "#9d8192",
  "#6f7c86",
  "#758f86",
  "#8a87a1",
  "#9f826c",
  "#81949d",
  "#b6a08c",
  "#9ca690",
  "#a79aad",
  "#ba9b94",
  "#94abaa",
  "#b3aa8b",
  "#af97a4",
  "#8e969e",
  "#94a69a",
  "#a29fb5",
  "#b29a83",
];
export const repositoryColors = (repositories: Repository[]) =>
  new Map(
    [...repositories]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((repository, index) => [
        repository.id,
        categoricalPalette[index] ?? `hsl(${(index * 137.508) % 360} 18% 56%)`,
      ]),
  );
export const initialFilters = (data: Dataset): Filters => ({
  mode: "current",
  ids: data.repositories.map((repository) => repository.id),
  scope: "all",
  includeStale: false,
  language: "all",
  metric: "code",
  period: "all",
});
export function historyWindow(data: Dataset, period: string) {
  const end = Date.parse(data.generatedAt);
  const start = Math.max(
    data.display?.historyStart
      ? Date.parse(data.display.historyStart)
      : -Infinity,
    period === "all" ? -Infinity : end - Number(period) * 86400000,
  );
  return {
    since: Number.isFinite(start) ? new Date(start).toISOString() : undefined,
    until: data.generatedAt,
  };
}

export type ChartRow = {
  time: number;
  timestamp: string;
  total: number;
  [key: string]: string | number;
};
export function chartRows(result: HistoryResult, percent: boolean): ChartRow[] {
  const { points } = result;
  return points
    .filter(
      (point, index) =>
        index === 0 ||
        index === points.length - 1 ||
        point.values.some(
          (value, column) => value !== points[index - 1].values[column],
        ),
    )
    .map((point) => ({
      time: Date.parse(point.timestamp),
      timestamp: point.timestamp,
      total: point.value,
      ...Object.fromEntries(
        point.values.map((value, index) => [
          `v${index}`,
          percent
            ? point.value
              ? ((value ?? 0) / point.value) * 100
              : 0
            : (value ?? 0),
        ]),
      ),
    }));
}

export function warningsFor(data: Dataset, filters: Filters): string[] {
  const selected = selectRepositories(data, filters);
  const scoped = data.repositories.filter(
    (repository) =>
      filters.ids.includes(repository.id) &&
      (filters.scope === "all" ||
        repositoryVisibility(repository) === filters.scope),
  );
  const messages: string[] = [];
  const incomplete =
    Boolean(data.lineageVersion) && data.completeness?.complete !== true;
  if (incomplete)
    messages.push("全量重算未完成 · 当前总量尚不完整，待完整采集后更新。");
  if (data.publication?.privateStatus === "retained")
    messages.push(
      `私有快照待重算 · ${dateLabel(data.publication.privateUpdatedAt)} UTC，已计入授权保留的旧快照。`,
    );
  if (data.publication?.privateStatus === "stale")
    messages.push(
      `私有指标尚未刷新，保留最后成功快照 · ${dateLabel(data.publication.privateUpdatedAt)} UTC。`,
    );
  if (data.publication?.privateStatus === "pending-rebuild" && !incomplete)
    messages.push("当前仅含公开仓库；私有仓库等待重新采集，旧指标未计入。");
  if (!data.repositories.length)
    messages.push("尚无可发布的仓库数据，等待首次成功采集。");
  const mismatch = scoped.filter(
    (repository) =>
      repository.rulesVersion !== data.rules.version &&
      repository.dataFreshness !== "retained-private" &&
      repository.history.length,
  );
  if (mismatch.length)
    messages.push(`${mismatch.length} 个仓库保留旧规则快照，已隔离出汇总。`);
  const stale = (filters.includeStale ? selected : scoped).filter(
    (repository) => ["stale", "inaccessible"].includes(repository.status),
  );
  if (stale.length)
    messages.push(
      filters.includeStale
        ? `已明确纳入 ${stale.length} 个过期或不可访问仓库的最后成功快照，可能与当前源仓库不同。`
        : `${stale.length} 个过期或不可访问仓库未纳入汇总，可开启“包含过期快照”查看。`,
    );
  const partial = selected.filter((repository) => !repository.historyComplete);
  if (partial.length)
    messages.push(
      `${partial.length} 个仓库历史尚不完整，趋势仅反映已采集快照。`,
    );
  const cold = selected.filter((repository) => repository.status === "cold");
  if (cold.length)
    messages.push(
      `历史档案纳入 ${cold.length} 个冷数据仓库，向后延续最后成功快照。`,
    );
  return messages;
}

export function safeRepositoryUrl(repository: Repository): string | null {
  if (repositoryVisibility(repository) === "private") return null;
  try {
    const url = new URL(repository.url ?? "");
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export async function copyName(
  repository: Repository,
  clipboard: Pick<Clipboard, "writeText"> | undefined = navigator.clipboard,
) {
  try {
    if (!clipboard || !repository.name)
      throw new Error("Clipboard unavailable");
    await clipboard.writeText(repository.name);
    return { ok: true, message: `已复制 ${repository.name}` };
  } catch {
    return {
      ok: false,
      message: `复制失败：${repository.name}。请检查剪贴板权限后重试。`,
    };
  }
}
export function downloadCsv(content: string, generatedAt: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8;" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `poly-tally-${generatedAt.slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const repositoryContext = (repository: Repository) =>
  [
    repositoryVisibility(repository) === "private" ? "私有" : "公开",
    repository.dataFreshness === "retained-private"
      ? "旧快照待重算"
      : repository.lineage
        ? "同源组"
        : repositoryVisibility(repository) === "private"
          ? "按日规模"
          : (repository.branch ?? "尚无默认分支"),
  ].join(" · ");
export const tableRows = (repositories: Repository[], language: string) =>
  repositories.map((repository) => ({
    repository,
    ...latestTotals([repository], language),
  }));

export function overviewChange(
  data: Dataset,
  repositories: Repository[],
  filters: Filters,
) {
  const boundary = data.display?.historyStart
    ? Date.parse(data.display.historyStart)
    : -Infinity;
  const start = Math.max(
    boundary,
    Date.parse(data.generatedAt) -
      (filters.period === "all" ? 30 : Number(filters.period)) * 86400000,
  );
  return stockChange(repositories, {
    since: new Date(start).toISOString(),
    until: data.generatedAt,
    metric: filters.metric,
    language: filters.language,
    includeStart: start === boundary,
  });
}
