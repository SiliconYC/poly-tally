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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format, metricOrder } from "@/lib/dashboard";
import { axisTickLabel, niceAxis } from "@/lib/chart-axis";
import type { ChangePeriod, Metric, Repository } from "@/lib/types";

type Props = {
  repositories: Repository[];
  language: string;
  since?: string;
  until: string;
};
const changeLabel = (period: ChangePeriod) =>
  period.change === null
    ? "暂无对比数据"
    : `${period.change > 0 ? "+" : ""}${format(period.change)}`;

export function ChangesChart({ repositories, language, since, until }: Props) {
  const [metric, setMetric] = useState<Metric>("code");
  const [period, setPeriod] = useState<"day" | "week" | "month">("month");
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
  // Keep the zero baseline, regular ticks and rounded endpoints in sync.
  const axis = useMemo(
    () => niceAxis(periods.map((item) => item.change)),
    [periods],
  );
  const config = useMemo(
    () => ({ change: { label: METRIC_LABELS[metric], color: "#0d9488" } }),
    [metric],
  );

  return (
    <Card
      data-panel="changes"
      className="min-w-0 gap-0 overflow-hidden rounded-lg border-border/70 py-0 shadow-none"
    >
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-border/60 px-5 py-4">
        <CardTitle className="text-base font-medium">净变化</CardTitle>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tabs
            value={period}
            onValueChange={(value) => setPeriod(value as typeof period)}
          >
            <TabsList aria-label="变化周期" className="h-8">
              <TabsTrigger value="day" className="text-xs">
                每日
              </TabsTrigger>
              <TabsTrigger value="week" className="text-xs">
                每周
              </TabsTrigger>
              <TabsTrigger value="month" className="text-xs">
                每月
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Select
            value={metric}
            onValueChange={(value) => setMetric(value as Metric)}
          >
            <SelectTrigger aria-label="净变化指标" className="h-8 w-28 text-xs">
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
      <CardContent className="p-5">
        {periods.length ? (
          <ChartContainer
            config={config}
            className="h-[280px] w-full aspect-auto"
          >
            <BarChart
              data={periods}
              margin={{ left: 0, right: 12, top: 16, bottom: 4 }}
              accessibilityLayer
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="key"
                axisLine={false}
                tickLine={false}
                minTickGap={36}
                tickMargin={10}
                tickFormatter={(value) =>
                  period === "month" ? String(value) : String(value).slice(5)
                }
              />
              <YAxis
                width={60}
                axisLine={false}
                tickLine={false}
                tickMargin={8}
                interval={0}
                allowDataOverflow
                tickFormatter={(value) => axisTickLabel(Number(value), axis.ticks)}
                domain={axis.domain}
                ticks={axis.ticks}
              />
              <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.6} strokeWidth={1.4} />
              <ChartTooltip
                filterNull={false}
                // Pin the panel vertically like the Qt chart; avoid a jittery
                // tooltip chasing every mouse movement up and down.
                position={{ y: 12 }}
                wrapperStyle={{ pointerEvents: "none" }}
                cursor={{ fill: "var(--muted)", opacity: 0.16 }}
                content={({ active, label }) => {
                  if (!active) return null;
                  const item = periods.find(
                    (item) => item.key === String(label),
                  );
                  if (!item) return null;
                  const note = [
                    item.partial ? "部分周期" : "",
                    item.missing && item.compared
                      ? `部分仓库（${item.compared}/${item.compared + item.missing}）`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <div className="min-w-40 max-w-[min(260px,calc(100vw-24px))] rounded-xl border border-border/70 bg-popover/95 px-3.5 py-3 text-xs text-popover-foreground shadow-lg backdrop-blur-sm">
                      <p className="font-medium text-muted-foreground">{item.label}</p>
                      <p className="mt-2 text-sm font-semibold tabular-nums">
                        {changeLabel(item)}
                        {item.change === null
                          ? ""
                          : ` ${METRIC_LABELS[metric]}`}
                      </p>
                      {note && (
                        <p className="mt-2 border-t border-border/60 pt-2 text-muted-foreground">{note}</p>
                      )}
                    </div>
                  );
                }}
              />
              <Bar
                dataKey="change"
                maxBarSize={32}
                radius={2}
                isAnimationActive={false}
              >
                {periods.map((item) => (
                  <Cell
                    key={item.key}
                    fill={
                      item.change !== null && item.change < 0
                        ? "#cb8063"
                        : "#0d9488"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            暂无历史数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}
