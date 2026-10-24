import { memo, useMemo, useRef, useState } from "react";
import { timeAxisTicks, timeTickLabel } from "@/lib/chart-x-axis";
import { usePlotWidth } from "@/lib/use-plot-width";
import type { KeyboardEvent } from "react";
import { Area, AreaChart, Brush, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import {
  stackedHistory,
  rankRepositoriesByHistoricalArea,
  METRIC_LABELS,
} from "../../model.mjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CursorTooltip } from "./cursor-tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { chartRows, dateLabel, format } from "@/lib/dashboard";
import { axisTickLabel, niceAxis } from "@/lib/chart-axis";
import type { ChartRow } from "@/lib/dashboard";
import type {
  HistoryPoint,
  HistoryResult,
  Metric,
  Repository,
} from "@/lib/types";

type Props = {
  repositories: Repository[];
  metric: Metric;
  language: string;
  since?: string;
  until: string;
  colors: Map<string, string>;
  range: [number, number] | null;
  onRangeChange: (range: [number, number] | null) => void;
};

function pointAt(points: HistoryPoint[], time: number) {
  let low = 0,
    high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Date.parse(points[middle].timestamp) <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

// Snapshot navigation must not invalidate Recharts' geometry for large histories.
const HistoryPlot = memo(function HistoryPlot({
  rows,
  series,
  config,
  start,
  end,
  colors,
  percent,
  maximum,
  axisTicks,
  timeTicks,
  timeUnit,
}: {
  rows: ChartRow[];
  series: HistoryResult["series"];
  config: ChartConfig;
  start: number;
  end: number;
  colors: Map<string, string>;
  percent: boolean;
  maximum: number;
  axisTicks: number[];
  timeTicks: number[];
  timeUnit: ReturnType<typeof timeAxisTicks>["unit"];
}) {
  return (
    <ChartContainer
      config={config}
      className="pointer-events-none h-[320px] w-full aspect-auto sm:h-[380px]"
    >
      <AreaChart
        data={rows}
        margin={{ top: 12, right: 16, left: 12, bottom: 8 }}
        accessibilityLayer={false}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="time"
          type="number"
          domain={[start, end === start ? end + 1 : end]}
          allowDataOverflow
          scale="time"
          ticks={timeTicks}
          interval={0}
          tickFormatter={(time) =>
            timeTickLabel(Number(time), timeUnit, new Date(start).getUTCFullYear() !== new Date(end).getUTCFullYear())
          }
          tick={{ fontSize: 11, fontWeight: 500 }}
          tickLine={{ stroke: "var(--border)", strokeWidth: 1 }}
          tickSize={4}
          tickMargin={10}
          axisLine={false}
        />
        <YAxis
          width={60}
          domain={[0, percent ? 100 : maximum]}
          ticks={percent ? [0, 25, 50, 75, 100] : axisTicks}
          allowDataOverflow
          interval={0}
          tickFormatter={(value) =>
            percent ? `${value}%` : axisTickLabel(Number(value), axisTicks)
          }
          tickLine={false}
          axisLine={false}
        />
        {series.map((item, column) => (
          <Area
            key={item.id}
            name={item.name}
            type="stepAfter"
            dataKey={`v${column}`}
            stackId="stock"
            stroke={colors.get(item.id)}
            fill={colors.get(item.id)}
            fillOpacity={0.8}
            isAnimationActive={false}
            dot={false}
            activeDot={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
});

const navigatorConfig = { total: { label: "历史规模", color: "#0d9488" } };
const HistoryNavigator = memo(function HistoryNavigator({
  overview,
  start,
  end,
  onRangeChange,
}: {
  overview: ChartRow[];
  start: number;
  end: number;
  onRangeChange: Props["onRangeChange"];
}) {
  return (
    <ChartContainer
      config={navigatorConfig}
      className="h-11 w-full aspect-auto"
    >
      <AreaChart
        data={overview}
        margin={{ left: 4, right: 4, top: 0, bottom: 0 }}
        accessibilityLayer={false}
      >
        <Brush
          dataKey="time"
          height={30}
          travellerWidth={8}
          stroke="var(--muted-foreground)"
          fill="var(--background)"
          tickFormatter={(value) => day(Number(value)).slice(5)}
          startIndex={Math.max(
            0,
            overview.reduce(
              (last, row, index) => (row.time <= start ? index : last),
              0,
            ),
          )}
          endIndex={Math.max(
            0,
            overview.findIndex((row) => row.time >= end),
          )}
          onChange={(selection) => {
            if (
              selection.startIndex === undefined ||
              selection.endIndex === undefined
            )
              return;
            const next: [number, number] = [
              overview[selection.startIndex].time,
              overview[selection.endIndex].time,
            ];
            if (next[0] !== start || next[1] !== end) onRangeChange(next);
          }}
        >
          <AreaChart>
            <Area
              dataKey="total"
              type="stepAfter"
              stroke="#0d9488"
              fill="#0d9488"
              fillOpacity={0.2}
              isAnimationActive={false}
            />
          </AreaChart>
        </Brush>
      </AreaChart>
    </ChartContainer>
  );
});

export function HistoryChart({
  repositories,
  metric,
  language,
  since,
  until,
  colors,
  range,
  onRangeChange,
}: Props) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [percent, setPercent] = useState(false);
  const [selectedAt, setSelectedAt] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const chartWidth = usePlotWidth(plot);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const ordered = useMemo(
    () =>
      rankRepositoriesByHistoricalArea(repositories, {
        metric,
        language,
        until,
      }) as Repository[],
    [repositories, metric, language, until],
  );
  const visible = useMemo(
    () => ordered.filter((repository) => !hidden.has(repository.id)),
    [ordered, hidden],
  );
  const full = useMemo(
    () =>
      stackedHistory(visible, {
        metric,
        language,
        since,
        until,
      }) as HistoryResult,
    [visible, metric, language, since, until],
  );
  const min = full.points.length ? Date.parse(full.points[0].timestamp) : 0;
  const max = full.points.length
    ? Date.parse(full.points[full.points.length - 1].timestamp)
    : 0;
  const start = range ? Math.max(min, Math.min(max, range[0])) : min;
  const end = range ? Math.max(start, Math.min(max, range[1])) : max;
  const timeAxis = useMemo(
    () => timeAxisTicks(start, end, Math.max(100, chartWidth - 88)),
    [start, end, chartWidth],
  );
  const result = useMemo(
    () =>
      range && full.points.length
        ? (stackedHistory(visible, {
            metric,
            language,
            since: new Date(start).toISOString(),
            until: new Date(end).toISOString(),
          }) as HistoryResult)
        : full,
    [range, full, visible, metric, language, start, end],
  );
  const rows = useMemo(() => chartRows(result, percent), [result, percent]);
  const overview = useMemo(() => chartRows(full, false), [full]);
  const config = useMemo(
    () =>
      Object.fromEntries(
        result.series.map((series, index) => [
          `v${index}`,
          { label: series.name, color: colors.get(series.id) ?? "#0d9488" },
        ]),
      ),
    [result.series, colors],
  );
  const index =
    selectedAt === null
      ? result.points.length - 1
      : pointAt(result.points, selectedAt);
  const point = result.points[index];
  const label = METRIC_LABELS[metric];
  const stockAxis = useMemo(
    () => niceAxis(rows.map((row) => row.total)),
    [rows],
  );
  // The hover hit test must use the same rounded domain as the rendered axis.
  const maximum = stockAxis.domain[1];
  const hoveredSeries =
    hoveredColumn === null ? null : result.series[hoveredColumn];
  const hoveredValue =
    hoveredColumn === null ? null : point?.values[hoveredColumn];
  const cursor = point
    ? Math.max(
        0,
        Math.min(1, (Date.parse(point.timestamp) - start) / (end - start || 1)),
      )
    : 0;

  function select(next: number, pin = true, column: number | null = null) {
    if (!result.points.length) return;
    setSelectedAt(
      Date.parse(
        result.points[Math.max(0, Math.min(result.points.length - 1, next))]
          .timestamp,
      ),
    );
    setPinned(pin);
    setHoveredColumn(column);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.target !== event.currentTarget ||
      !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)
    )
      return;
    event.preventDefault();
    if (event.key === "Escape") {
      setPinned(false);
      setSelectedAt(null);
      setHoveredColumn(null);
      return;
    }
    const nextIndex = Math.max(
      0,
      Math.min(
        result.points.length - 1,
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? result.points.length - 1
            : index + (event.key === "ArrowRight" ? 1 : -1),
      ),
    );
    select(nextIndex);
    const rect = plot.current?.getBoundingClientRect();
    if (rect && result.points[nextIndex])
      setAnchor({
        x:
          rect.left +
          72 +
          ((Date.parse(result.points[nextIndex].timestamp) - start) /
            (end - start || 1)) *
            (rect.width - 88),
        y: rect.top + rect.height / 2,
      });
  }
  function pointerSelection(event: { clientX: number; clientY: number }) {
    const rect = plot.current?.getBoundingClientRect();
    if (!rect || rect.width <= 88 || !result.points.length) return null;
    const x = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left - 72) / (rect.width - 88)),
    );
    const next = pointAt(result.points, start + x * (end - start));
    const stock = result.points[next];
    const y =
      ((rect.bottom - 38 - event.clientY) / (rect.height - 50)) *
      (percent ? 100 : maximum);
    let lower = 0,
      column: number | null = null;
    for (let i = 0; i < stock.values.length; i++) {
      const value = percent
        ? stock.value
          ? ((stock.values[i] ?? 0) / stock.value) * 100
          : 0
        : (stock.values[i] ?? 0);
      const upper = lower + value;
      if (value > 0 && y >= lower && y <= upper) column = i;
      lower = upper;
    }
    return { index: next, column };
  }
  function isolate(id: string) {
    setHidden(
      new Set(
        repositories
          .filter((repository) => repository.id !== id)
          .map((repository) => repository.id),
      ),
    );
  }
  function changeDate(value: string, side: 0 | 1) {
    const time = Date.parse(
      `${value}T${side ? "23:59:59.999" : "00:00:00.000"}Z`,
    );
    if (!Number.isFinite(time)) return;
    const next: [number, number] = [start, end];
    next[side] = Math.max(min, Math.min(max, time));
    if (next[0] <= next[1]) onRangeChange(next);
  }

  return (
    <Card
      id="history"
      className="min-w-0 gap-0 overflow-hidden rounded-xl border-border/70 py-0 shadow-none scroll-mt-24"
    >
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
        <div className="space-y-1.5">
          <CardTitle className="text-base font-medium">
            历史趋势
            <span className="ml-3 text-xs font-normal text-muted-foreground">
              {label}
            </span>
          </CardTitle>
          <span className="sr-only">{label}，按仓库的阶梯存量</span>
        </div>
        <Tabs
          value={percent ? "percent" : "absolute"}
          onValueChange={(value) => setPercent(value === "percent")}
        >
          <TabsList aria-label="历史显示方式">
            <TabsTrigger value="absolute">绝对规模</TabsTrigger>
            <TabsTrigger value="percent">百分比</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        <details className="group">
          <summary className="w-fit cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            仓库图层（{ordered.length}）
          </summary>
          <div
            className="mt-3 flex max-h-48 flex-wrap gap-2 overflow-auto"
            aria-label="仓库图例"
          >
            {ordered.map((repository) => (
              <div
                className="inline-flex items-center rounded-md border"
                key={repository.id}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  className="max-w-52 gap-2 rounded-r-none"
                  aria-label={`显示或隐藏 ${repository.name.split("/").slice(1).join("/") || repository.name}`}
                  aria-pressed={!hidden.has(repository.id)}
                  title="点击显隐；Shift 点击单独查看"
                  onClick={(event) => {
                    if (event.shiftKey) {
                      isolate(repository.id);
                      return;
                    }
                    setHidden((previous) => {
                      const next = new Set(previous);
                      if (next.has(repository.id)) next.delete(repository.id);
                      else next.add(repository.id);
                      return next;
                    });
                  }}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: colors.get(repository.id),
                      opacity: hidden.has(repository.id) ? 0.25 : 1,
                    }}
                  />
                  <span
                    className={`truncate ${hidden.has(repository.id) ? "text-muted-foreground line-through" : ""}`}
                  >
                    {repository.name.split("/").slice(1).join("/") ||
                      repository.name}
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-l-none border-l px-2 text-xs text-muted-foreground"
                  aria-label={`只看 ${repository.name}`}
                  onClick={() => isolate(repository.id)}
                >
                  只看
                </Button>
              </div>
            ))}
            {hidden.size > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setHidden(new Set())}
              >
                全部显示
              </Button>
            )}
          </div>
        </details>
        {point ? (
          <>
            <div
              role="region"
              aria-label="历史趋势图"
              aria-describedby="history-keyboard-hint"
              tabIndex={0}
              onKeyDown={keyboard}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div
                ref={plot}
                className="relative touch-pan-y"
                onPointerMove={(event) => {
                  if (!pinned) {
                    const next = pointerSelection(event);
                    if (next !== null) {
                      setAnchor({ x: event.clientX, y: event.clientY });
                      select(next.index, false, next.column);
                    }
                  }
                }}
                onPointerLeave={() => {
                  if (!pinned) {
                    setSelectedAt(null);
                    setHoveredColumn(null);
                    setAnchor(null);
                  }
                }}
                onClick={(event) => {
                  const next = pointerSelection(event);
                  if (next !== null) {
                    setAnchor({ x: event.clientX, y: event.clientY });
                    select(next.index, !pinned, next.column);
                  }
                }}
                onDoubleClick={() => onRangeChange(null)}
              >
                <HistoryPlot
                  rows={rows}
                  series={result.series}
                  config={config}
                  start={start}
                  end={end}
                  colors={colors}
                  percent={percent}
                  maximum={maximum}
                  axisTicks={stockAxis.ticks}
                  timeTicks={timeAxis.ticks}
                  timeUnit={timeAxis.unit}
                />
                {selectedAt !== null && (
                  <>
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute top-3 right-4 bottom-[38px] left-[72px]"
                    >
                      <div
                        className="absolute inset-y-0 border-l border-dashed border-foreground/70"
                        style={{ left: `${cursor * 100}%` }}
                      />
                    </div>
                    {anchor && (
                      <CursorTooltip
                        anchor={anchor}
                        contextElement={plot.current}
                      >
                        <p className="text-muted-foreground">
                          {dateLabel(point.timestamp)} UTC
                        </p>
                        {hoveredSeries && (
                          <p className="mt-2 flex justify-between gap-6">
                            <span className="truncate font-medium">
                              {hoveredSeries.name}
                            </span>
                            <span className="tabular-nums">
                              {hoveredValue == null
                                ? "尚未观测"
                                : `${format(hoveredValue)} · ${(point.value ? (hoveredValue / point.value) * 100 : 0).toFixed(1)}%`}
                            </span>
                          </p>
                        )}
                        <p className="mt-2 flex justify-between gap-6 border-t pt-2">
                          <span className="text-muted-foreground">{label}</span>
                          <strong className="tabular-nums">
                            {format(point.value)}
                          </strong>
                        </p>
                      </CursorTooltip>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="space-y-3 border-t border-border/60 pt-3">
              <p id="history-keyboard-hint" className="sr-only">
                拖动下方手柄缩放，拖动选中窗口平移；双击恢复。聚焦图表后用 ← →
                查看快照，Home / End 跳到首尾，Escape 返回最新。
              </p>
              {overview.length > 1 && max > min && (
                <HistoryNavigator
                  overview={overview}
                  start={start}
                  end={end}
                  onRangeChange={onRangeChange}
                />
              )}
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-xs">
                  开始
                  <Input
                    type="date"
                    aria-label="时间范围开始日期 UTC"
                    min={day(min)}
                    max={day(max)}
                    value={day(start)}
                    onChange={(event) => changeDate(event.target.value, 0)}
                    className="w-auto text-sm"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  结束
                  <Input
                    type="date"
                    aria-label="时间范围结束日期 UTC"
                    min={day(min)}
                    max={day(max)}
                    value={day(end)}
                    onChange={(event) => changeDate(event.target.value, 1)}
                    className="w-auto text-sm"
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRangeChange(null)}
                >
                  <RotateCcw className="size-3.5" />
                  恢复全部历史
                </Button>
              </div>
            </div>
            <details className="group border-t border-border/60 pt-3">
              <summary className="cursor-pointer list-none text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
                快照明细
              </summary>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {dateLabel(point.timestamp)} UTC{" "}
                    {pinned ? "· 已固定" : "· 快照明细"}
                  </p>
                  <p className="sr-only">
                    已知合计 {format(point.value)} {label} · 首次观测前保留未知
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="上一个快照"
                    disabled={index <= 0}
                    onClick={() => select(index - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="下一个快照"
                    disabled={index >= result.points.length - 1}
                    onClick={() => select(index + 1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
              <div className="max-h-52 overflow-auto rounded-md border">
                <table aria-label="快照明细" className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="p-2 text-left font-medium">仓库</th>
                      <th className="p-2 text-right font-medium">{label}</th>
                      <th className="p-2 text-right font-medium">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.series.map((series, column) => (
                      <tr className="border-t" key={series.id}>
                        <td className="p-2">{series.name}</td>
                        <td className="p-2 text-right tabular-nums">
                          {point.values[column] === null
                            ? "尚未观测"
                            : format(point.values[column]!)}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {point.values[column] === null
                            ? "未知"
                            : `${(point.value ? (point.values[column]! / point.value) * 100 : 0).toFixed(1)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {repositories.length && !visible.length
              ? "所有仓库图层均已隐藏，请恢复图层。"
              : "这个范围还没有可用快照。"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
