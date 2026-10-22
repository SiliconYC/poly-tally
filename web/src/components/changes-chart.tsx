import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { periodChanges } from "../../insights.mjs";
import { METRIC_LABELS } from "../../model.mjs";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { compact, dateLabel, format, metricOrder } from "@/lib/dashboard";
import type { ChangePeriod, Metric, Repository } from "@/lib/types";

type Props = {
  repositories: Repository[];
  language: string;
  since?: string;
  until: string;
  onRangeChange: (range: [number, number] | null) => void;
};
const changeLabel = (period: ChangePeriod) =>
  period.change === null
    ? "暂无可比数据"
    : `${period.change > 0 ? "+" : ""}${format(period.change)}`;
const periodNotes = (period: ChangePeriod) =>
  [
    period.partial ? "部分周期" : "",
    period.missing
      ? `${period.missing} 个仓库缺少期初，未参与计算`
      : "所选仓库均可比",
  ]
    .filter(Boolean)
    .join(" · ");

export function ChangesChart({
  repositories,
  language,
  since,
  until,
  onRangeChange,
}: Props) {
  const [metric, setMetric] = useState<Metric>("code");
  const [period, setPeriod] = useState<"day" | "week" | "month">("month");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const periods = useMemo(
    () =>
      periodChanges(repositories, {
        period,
        since,
        until,
        metric,
        language,
        limit: period === "day" ? 30 : 12,
      }) as ChangePeriod[],
    [repositories, language, since, until, metric, period],
  );
  const selected =
    periods.find((item) => item.key === selectedKey) ??
    periods[periods.length - 1];
  const select = (item: ChangePeriod) => {
    setSelectedKey(item.key);
    onRangeChange([Date.parse(item.since), Date.parse(item.until)]);
  };
  const bounds = useMemo(() => {
    const values = periods.flatMap((item) =>
      item.change === null ? [] : [item.change],
    );
    const low = Math.min(0, ...values),
      high = Math.max(0, ...values),
      padding = (high - low || 1) * 0.15;
    return [low - padding, high + padding] as [number, number];
  }, [periods]);
  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3">
        <div className="space-y-1.5">
          <CardTitle>净变化</CardTitle>
          <CardDescription>
            UTC 日历周期 · 仅比较具有期初快照的仓库
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={period}
            onValueChange={(value) => {
              setPeriod(value as typeof period);
              setSelectedKey(null);
            }}
          >
            <TabsList aria-label="变化周期">
              <TabsTrigger value="day">每日</TabsTrigger>
              <TabsTrigger value="week">每周</TabsTrigger>
              <TabsTrigger value="month">每月</TabsTrigger>
            </TabsList>
          </Tabs>
          <Select
            value={metric}
            onValueChange={(value) => setMetric(value as Metric)}
          >
            <SelectTrigger aria-label="净变化指标" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metricOrder.map((item) => (
                <SelectItem key={item} value={item}>
                  {METRIC_LABELS[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {selected ? (
          <>
            <ChartContainer
              config={{
                change: { label: METRIC_LABELS[metric], color: "#0d9488" },
              }}
              className="h-[250px] w-full aspect-auto"
            >
              <BarChart
                data={periods}
                margin={{ left: 0, right: 12, top: 10, bottom: 4 }}
                accessibilityLayer={false}
                onMouseMove={(state) => {
                  if (state.activeLabel !== undefined)
                    setSelectedKey(String(state.activeLabel));
                }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="key"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={36}
                  tickFormatter={(value) =>
                    period === "month" ? String(value) : String(value).slice(5)
                  }
                />
                <YAxis
                  width={48}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={compact}
                  domain={bounds}
                />
                <ReferenceLine y={0} stroke="var(--muted-foreground)" />
                <ChartTooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                  content={() => (
                    <div className="rounded-lg border bg-background p-3 text-xs shadow-md">
                      <p className="font-medium">
                        {selected.label} · {changeLabel(selected)}{" "}
                        {selected.change === null ? "" : METRIC_LABELS[metric]}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        {periodNotes(selected)}
                      </p>
                    </div>
                  )}
                />
                <Bar
                  dataKey="change"
                  maxBarSize={36}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                  onClick={(data) => {
                    const item = periods.find((item) => item.key === data.key);
                    if (item) select(item);
                  }}
                >
                  {periods.map((item) => (
                    <Cell
                      key={item.key}
                      fill={
                        item.change !== null && item.change < 0
                          ? "#d97757"
                          : "#0d9488"
                      }
                      fillOpacity={selected.key === item.key ? 1 : 0.75}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
            <div
              aria-label="净变化周期明细"
              aria-live="polite"
              className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm"
            >
              <p className="font-medium">
                {selected.label} · {changeLabel(selected)}{" "}
                {selected.change === null ? "" : METRIC_LABELS[metric]}
              </p>
              <p className="text-xs text-muted-foreground">
                {selected.compared} 个可比仓库 · {periodNotes(selected)}
              </p>
              <p className="text-xs text-muted-foreground">
                {dateLabel(selected.since)} — {dateLabel(selected.until)} UTC
              </p>
            </div>
            <details
              className="rounded-lg border p-3"
              open={periods.length <= 12}
            >
              <summary className="cursor-pointer text-xs font-medium">
                周期列表与范围选择（{periods.length}）
              </summary>
              <div
                className="mt-2 max-h-52 space-y-1 overflow-auto"
                aria-label="净变化周期列表"
              >
                {periods.map((item) => (
                  <Button
                    key={item.key}
                    variant="ghost"
                    className="h-auto w-full justify-between gap-3 px-2 py-2 text-left font-normal"
                    aria-label={`${item.label}，${changeLabel(item)}，${periodNotes(item)}。查看此周期历史`}
                    onFocus={() => setSelectedKey(item.key)}
                    onMouseEnter={() => setSelectedKey(item.key)}
                    onClick={() => select(item)}
                  >
                    <span className="text-xs">
                      {item.label}
                      <span className="ml-1 text-muted-foreground">
                        {item.partial ? "· 部分" : ""}
                        {item.missing ? " · 缺期初" : ""}
                      </span>
                    </span>
                    <span
                      className={`text-xs tabular-nums ${item.change !== null && item.change < 0 ? "text-orange-600 dark:text-orange-400" : ""}`}
                    >
                      {changeLabel(item)}
                    </span>
                  </Button>
                ))}
              </div>
            </details>
            <p className="text-xs text-muted-foreground">
              未知周期保留“暂无可比数据”，不按零增长显示。选择周期可查看对应历史窗口。
            </p>
          </>
        ) : (
          <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            当前范围没有可用历史。
          </div>
        )}
      </CardContent>
    </Card>
  );
}
