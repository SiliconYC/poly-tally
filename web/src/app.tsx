import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Code2,
  Files,
  GitFork,
  Layers2,
  MessageSquare,
  Moon,
  RefreshCw,
  Sun,
  TextCursorInput,
  BookOpen,
  ChevronDown,
  Info,
  CircleCheck,
} from "lucide-react";
import { ThemeProvider, useTheme } from "next-themes";
import { toast } from "sonner";
import {
  METRIC_LABELS,
  latestTotals,
  loadStats,
  publicationSummary,
  selectRepositories,
} from "../model.mjs";
import type { Dataset, Filters } from "@/lib/types";
import {
  copyName,
  dateLabel,
  format,
  historyWindow,
  initialFilters,
  metricOrder,
  repositoryColors,
  warningsFor,
} from "@/lib/dashboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { DashboardFilters } from "@/components/filters";
import { RepositoryTable } from "@/components/repository-table";
const HistoryChart = lazy(() =>
  import("@/components/history-chart").then((module) => ({
    default: module.HistoryChart,
  })),
);
const CompositionChart = lazy(() =>
  import("@/components/composition-chart").then((module) => ({
    default: module.CompositionChart,
  })),
);
const ChangesChart = lazy(() =>
  import("@/components/changes-chart").then((module) => ({
    default: module.ChangesChart,
  })),
);
import { cn } from "@/lib/utils";

const metricIcons = {
  total: Layers2,
  code: Code2,
  comment: MessageSquare,
  documentation: BookOpen,
  blank: TextCursorInput,
  files: Files,
};
const defaultLoad = () => loadStats();

function Header({
  loading,
  onRefresh,
  updatedAt,
}: {
  loading: boolean;
  onRefresh: () => void;
  updatedAt?: string;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-[76px] max-w-[1536px] items-center justify-between gap-3 px-4 sm:px-8">
        <a
          href="#main"
          className="flex items-center gap-2.5 font-semibold tracking-tight"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Layers2 className="size-4.5" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">
            Poly Tally<span className="text-primary">.</span>
          </h1>
          <span className="ml-3 hidden h-5 w-px bg-border sm:block" />
          {updatedAt && (
            <time
              dateTime={updatedAt}
              className="hidden text-xs font-normal text-muted-foreground sm:block"
            >
              {dateLabel(updatedAt)} UTC
            </time>
          )}
        </a>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              resolvedTheme === "dark" ? "切换浅色模式" : "切换深色模式"
            }
            title={resolvedTheme === "dark" ? "切换浅色模式" : "切换深色模式"}
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            {resolvedTheme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="重新加载统计数据"
            title="重新加载统计数据"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="outline" size="sm" asChild>
            <a
              href="https://github.com/SiliconYC/poly-tally"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitFork className="size-4" />
              <span className="hidden sm:inline">GitHub</span>
              <ArrowUpRight className="hidden size-3.5 sm:block" />
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}

function Dashboard({ data }: { data: Dataset }) {
  const [filters, setFilters] = useState(() => initialFilters(data));
  const [range, setRange] = useState<[number, number] | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const colors = useMemo(() => repositoryColors(data.repositories), [data]);
  const selected = useMemo(
    () => selectRepositories(data, filters),
    [data, filters.ids, filters.mode, filters.scope, filters.includeStale],
  );
  const totals = useMemo(
    () => latestTotals(selected, filters.language),
    [selected, filters.language],
  );
  const window = useMemo(
    () => historyWindow(data, filters.period),
    [data, filters.period],
  );
  const warnings = useMemo(() => warningsFor(data, filters), [data, filters]);
  const publication = useMemo(() => publicationSummary(data), [data]);
  const updateFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
    if ("period" in patch) setRange(null);
  }, []);
  const reset = () => {
    setFilters(initialFilters(data));
    setRange(null);
    setResetKey((key) => key + 1);
  };
  const onCopy = useCallback(
    async (repository: Dataset["repositories"][number]) => {
      const result = await copyName(repository);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    [],
  );
  const run = useMemo(
    () =>
      [...(data.runs ?? [])].sort(
        (a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt),
      )[0],
    [data],
  );
  const privateStatus: Record<string, string> = {
    available: "私有指标可用",
    retained: "私有旧快照待重算",
    stale: "私有快照尚未刷新",
    "not-configured": "未配置私有采集凭据",
    "pending-rebuild": "私有指标等待重新采集",
  };
  return (
    <div className="space-y-5">
      <DashboardFilters
        key={resetKey}
        data={data}
        filters={filters}
        onChange={updateFilters}
        onReset={reset}
      />
      {warnings.length > 0 && (
        <div
          role="status"
          className="flex gap-3 rounded-lg border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </div>
      )}
      <section
        aria-label="统计概览"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
      >
        {metricOrder.map((metric) => {
          const Icon = metricIcons[metric],
            active = filters.metric === metric;
          return (
            <Card
              key={metric}
              className={cn(
                "gap-0 overflow-hidden rounded-xl py-0 shadow-none transition-colors",
                active && "border-foreground bg-foreground text-background",
              )}
            >
              <button
                className="w-full rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:p-5"
                aria-label={`${METRIC_LABELS[metric]} ${format(totals[metric])}`}
                aria-pressed={active}
                onClick={() => updateFilters({ metric })}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "text-xs font-medium",
                      active ? "text-background/70" : "text-muted-foreground",
                    )}
                  >
                    {METRIC_LABELS[metric]}
                  </span>
                  <Icon
                    className={cn(
                      "size-4 text-muted-foreground/70",
                      active && "text-background/60",
                    )}
                  />
                </div>
                <div
                  className="mt-4 text-[27px] font-semibold tracking-[-0.045em] tabular-nums sm:text-[30px]"
                  data-testid={`metric-${metric}`}
                >
                  {format(totals[metric])}
                </div>
              </button>
            </Card>
          );
        })}
      </section>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <HistoryChart
          key={`history-${resetKey}`}
          repositories={selected}
          metric={filters.metric}
          language={filters.language}
          since={window.since}
          until={window.until}
          colors={colors}
          range={range}
          onRangeChange={setRange}
        />
      </Suspense>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <Suspense fallback={<Skeleton className="h-96" />}>
          <CompositionChart
            key={`composition-${resetKey}`}
            repositories={selected}
            metric={filters.metric}
            language={filters.language}
            colors={colors}
            onCopy={onCopy}
          />
        </Suspense>
        <Suspense fallback={<Skeleton className="h-96" />}>
          <ChangesChart
            key={`changes-${resetKey}`}
            repositories={selected}
            language={filters.language}
            since={window.since}
            until={window.until}
          />
        </Suspense>
      </div>
      <RepositoryTable
        key={`table-${resetKey}`}
        repositories={selected}
        language={filters.language}
        generatedAt={data.generatedAt}
        onCopy={onCopy}
      />
      <details className="group border-t pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
          <Info className="size-3.5" />
          统计说明
          <ChevronDown className="size-3.5 group-open:rotate-180" />
        </summary>
        <div className="space-y-6 pt-5">
          <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
            <Card className="gap-4 shadow-none">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Activity className="size-4 text-muted-foreground" />
                    最近运行
                  </CardTitle>
                  {run && (
                    <Badge variant="outline" className="font-normal">
                      {run.failed
                        ? `${run.failed} 个失败`
                        : run.completeness?.complete === false
                          ? "采集未完整"
                          : "采集完成"}
                    </Badge>
                  )}
                </div>
                <CardDescription>
                  {run
                    ? `${dateLabel(run.finishedAt)} UTC · 只读采集`
                    : "暂无运行记录"}
                </CardDescription>
              </CardHeader>
              {run && (
                <CardContent>
                  <div className="grid grid-cols-3 gap-y-5 sm:grid-cols-6">
                    {[
                      [format(run.repositories ?? 0), "公开仓库"],
                      [
                        `${Number(run.durationSeconds ?? 0).toFixed(1)}s`,
                        "运行耗时",
                      ],
                      [format(run.cacheHits ?? 0), "缓存命中"],
                      [format(run.parsedBlobs ?? 0), "解析对象"],
                      [format(run.objectReads ?? 0), "对象读取"],
                      [format(run.recomputedCommits ?? 0), "重算提交"],
                    ].map(([value, label]) => (
                      <div key={label}>
                        <p className="font-semibold tabular-nums">{value}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {label}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
            <Card className="gap-4 shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CircleCheck className="size-4 text-muted-foreground" />
                  发布状态
                </CardTitle>
                <CardDescription>
                  已发布 {publication.publicRepositories} 个公开仓库 +{" "}
                  {publication.privateRepositories} 个私有仓库
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  {privateStatus[publication.privateStatus] ??
                    "私有采集状态未知"}
                  {publication.privateSource
                    ? ` · ${{ local: "本地采集", "github-actions": "GitHub Actions" }[publication.privateSource] ?? publication.privateSource}`
                    : ""}
                </p>
                <p>
                  私有最后成功：{dateLabel(publication.privateUpdatedAt)}
                  {publication.privateUpdatedAt ? " UTC" : ""}
                </p>
              </CardContent>
            </Card>
          </div>
          <Card className="gap-0 py-0 shadow-none">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-6 py-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                  <Info className="size-4 text-muted-foreground" />
                  统计口径与数据说明
                </span>
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-3 border-t px-6 py-5 text-xs leading-relaxed text-muted-foreground">
                <p>
                  总行数 = 代码行 + 注释行 + 文档行 +
                  空行。混合代码与注释的物理行只计为代码行，文件数单独统计。
                </p>
                <p>
                  概览、构成与仓库表显示最新已知快照；时间筛选控制历史和变化比较。首次观测前保持未知，此后的存量延续到下一次快照，保留真实下降和同刻变化。
                </p>
                <p>
                  净变化只比较有期初快照的仓库。首次观测的存量不计入净变化；缺失期初、部分周期与不完整历史会明确标记。私有仓库仅发布脱敏后的按日规模，不公开源码、路径与提交细节。同源组由采集器折叠为单个统计对象。
                </p>
                <p>
                  规则 {data.rules.version} ·{" "}
                  {data.rules.description ?? "所有纳入仓库采用相同统计规则。"}
                  {data.publication?.privateStatus === "retained"
                    ? ` · 私有旧快照规则 ${data.publication.privateRulesVersion ?? "未知"}`
                    : ""}
                </p>
              </div>
            </details>
          </Card>
          <p className="text-xs text-muted-foreground">
            采集器 {data.collector?.version ?? "—"} · 规则 {data.rules.version}
          </p>
        </div>
      </details>
    </div>
  );
}

function Application({
  load = defaultLoad,
}: {
  load?: () => Promise<Dataset>;
}) {
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    load()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "连接失败");
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, revision]);
  return (
    <TooltipProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-4"
      >
        跳到主要内容
      </a>
      <Header
        loading={loading}
        updatedAt={data?.generatedAt}
        onRefresh={() => setRevision((value) => value + 1)}
      />
      <main
        id="main"
        className="mx-auto max-w-[1536px] px-4 py-5 sm:px-8 sm:py-7"
      >
        {loading ? (
          <div
            role="status"
            aria-label="正在加载统计数据"
            className="space-y-6"
          >
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-5 w-80 max-w-full" />
            <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton className="h-32" key={index} />
              ))}
            </div>
            <Skeleton className="h-96" />
            <span className="sr-only">正在加载统计数据</span>
          </div>
        ) : error ? (
          <Card className="mx-auto my-20 max-w-lg text-center" role="alert">
            <CardHeader>
              <AlertCircle className="mx-auto mb-3 size-8 text-muted-foreground" />
              <CardTitle>暂时无法读取统计数据</CardTitle>
              <CardDescription>
                {error}。请检查网络，或等待首次采集与发布完成后重试。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => setRevision((value) => value + 1)}>
                <RefreshCw className="size-4" />
                重新加载
              </Button>
            </CardContent>
          </Card>
        ) : data ? (
          <Dashboard key={revision} data={data} />
        ) : null}
      </main>
      <Toaster richColors position="bottom-right" closeButton />
    </TooltipProvider>
  );
}
export function App(props: { load?: () => Promise<Dataset> }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <Application {...props} />
    </ThemeProvider>
  );
}
