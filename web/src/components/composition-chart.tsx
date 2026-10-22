import { useMemo, useState } from "react";
import { Cell, Label, Pie, PieChart } from "recharts";
import { Copy } from "lucide-react";
import {
  languageTotals,
  repositoryShares,
  METRIC_LABELS,
} from "../../model.mjs";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { compact, format } from "@/lib/dashboard";
import type { Metric, Repository } from "@/lib/types";

type Props = {
  repositories: Repository[];
  metric: Metric;
  language: string;
  colors: Map<string, string>;
  onLanguageChange: (language: string) => void;
  onRepositorySelect: (id: string) => void;
  onCopy: (repository: Repository) => void;
};
type Item = { id: string; name: string; value: number; color: string };
const palette = [
  "#0d9488",
  "#3b82f6",
  "#8b5cf6",
  "#f59e0b",
  "#e879a2",
  "#64748b",
  "#06b6d4",
];
function languageColor(name: string) {
  let hash = 0;
  for (const character of name)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export function CompositionChart({
  repositories,
  metric,
  language,
  colors,
  onLanguageChange,
  onRepositorySelect,
  onCopy,
}: Props) {
  const [dimension, setDimension] = useState("language");
  const [sorting, setSorting] = useState("value-desc");
  const [active, setActive] = useState<string | null>(null);
  const items = useMemo(() => {
    const rows: Item[] =
      dimension === "repository"
        ? (
            repositoryShares(repositories, { metric, language }) as {
              id: string;
              name: string;
              value: number;
            }[]
          ).map((item) => ({
            ...item,
            color: colors.get(item.id) ?? "#0d9488",
          }))
        : (
            languageTotals(repositories, metric) as {
              name: string;
              value: number;
            }[]
          )
            .filter((item) => language === "all" || item.name === language)
            .map((item) => ({
              ...item,
              id: item.name,
              color: languageColor(item.name),
            }));
    const [key, direction] = sorting.split("-");
    return rows.sort(
      (a, b) =>
        (key === "name" ? a.name.localeCompare(b.name) : a.value - b.value) *
          (direction === "asc" ? 1 : -1) || a.id.localeCompare(b.id),
    );
  }, [repositories, metric, language, colors, dimension, sorting]);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const selected = items.find((item) => item.id === active);
  const config = useMemo(
    () =>
      Object.fromEntries(
        items.map((item, index) => [
          `slice${index}`,
          { label: item.name, color: item.color },
        ]),
      ),
    [items],
  );
  const slices = useMemo(
    () => items.map((item, index) => ({ ...item, chartKey: `slice${index}` })),
    [items],
  );
  const choose = (item: Item) =>
    dimension === "repository"
      ? onRepositorySelect(item.id)
      : onLanguageChange(item.name);
  const percentage = (value: number) =>
    (value / total) * 100 < 0.1
      ? "<0.1%"
      : `${((value / total) * 100).toFixed(1)}%`;

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3">
        <div className="space-y-1.5">
          <CardTitle>规模构成</CardTitle>
          <CardDescription>
            {METRIC_LABELS[metric]} · 最新已知快照 · 点击明细筛选
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={dimension}
            onValueChange={(value) => {
              setDimension(value);
              setActive(null);
            }}
          >
            <TabsList aria-label="构成维度">
              <TabsTrigger value="language">语言</TabsTrigger>
              <TabsTrigger value="repository">仓库</TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={sorting} onValueChange={setSorting}>
            <SelectTrigger aria-label="构成排序" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="value-desc">规模降序</SelectItem>
              <SelectItem value="value-asc">规模升序</SelectItem>
              <SelectItem value="name-asc">名称升序</SelectItem>
              <SelectItem value="name-desc">名称降序</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {total > 0 ? (
          <>
            <ChartContainer
              config={config}
              className="mx-auto h-[250px] w-full max-w-[350px] aspect-square"
            >
              <PieChart accessibilityLayer={false}>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      nameKey="name"
                      formatter={(value, name) => (
                        <span>
                          {name} · {format(Number(value))} ·{" "}
                          {percentage(Number(value))}
                        </span>
                      )}
                    />
                  }
                />
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={72}
                  outerRadius={106}
                  strokeWidth={2}
                  stroke="var(--background)"
                  isAnimationActive={false}
                  onMouseEnter={(_, index) => setActive(items[index].id)}
                  onMouseLeave={() => setActive(null)}
                  onClick={(_, index) => choose(items[index])}
                >
                  {items.map((item) => (
                    <Cell
                      key={item.id}
                      fill={item.color}
                      opacity={!selected || selected.id === item.id ? 1 : 0.25}
                    />
                  ))}
                  <Label
                    content={({ viewBox }) => {
                      if (!viewBox || !("cx" in viewBox) || !("cy" in viewBox))
                        return null;
                      const name =
                        selected?.name ??
                        (dimension === "repository" ? "全部仓库" : "全部语言");
                      return (
                        <text
                          x={viewBox.cx}
                          y={viewBox.cy}
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          <tspan
                            x={viewBox.cx}
                            dy="-18"
                            className="fill-muted-foreground text-xs"
                          >
                            {name.length > 14 ? `${name.slice(0, 13)}…` : name}
                          </tspan>
                          <tspan
                            x={viewBox.cx}
                            dy="27"
                            className="fill-foreground text-2xl font-semibold"
                          >
                            {compact(selected?.value ?? total)}
                          </tspan>
                          <tspan
                            x={viewBox.cx}
                            dy="21"
                            className="fill-muted-foreground text-xs"
                          >
                            {selected
                              ? percentage(selected.value)
                              : METRIC_LABELS[metric]}
                          </tspan>
                        </text>
                      );
                    }}
                  />
                </Pie>
              </PieChart>
            </ChartContainer>
            <div
              className="max-h-[310px] space-y-1 overflow-auto"
              aria-label={
                dimension === "repository" ? "仓库构成明细" : "语言构成明细"
              }
            >
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-1 rounded-md ${active === item.id ? "bg-muted" : ""}`}
                  onMouseEnter={() => setActive(item.id)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(item.id)}
                  onBlur={() => setActive(null)}
                >
                  <Button
                    variant="ghost"
                    className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-2 px-2 py-2 font-normal"
                    aria-label={`${dimension === "repository" ? "筛选仓库" : "筛选语言"} ${item.name}`}
                    onClick={() => choose(item)}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: item.color }}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-left"
                      title={item.name}
                    >
                      {item.name}
                    </span>
                    <span className="tabular-nums">{format(item.value)}</span>
                    <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">
                      {percentage(item.value)}
                    </span>
                  </Button>
                  {dimension === "repository" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      aria-label={`复制完整仓库名称 ${repositories.find((repository) => repository.id === item.id)?.name ?? item.name}`}
                      onClick={() => {
                        const repository = repositories.find(
                          (repository) => repository.id === item.id,
                        );
                        if (repository) onCopy(repository);
                      }}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              合计 {format(total)} {METRIC_LABELS[metric]} · {items.length}{" "}
              {dimension === "repository" ? "个仓库" : "种语言"}
            </p>
          </>
        ) : (
          <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            当前筛选下暂无{dimension === "repository" ? "仓库" : "语言"}数据。
          </div>
        )}
      </CardContent>
    </Card>
  );
}
