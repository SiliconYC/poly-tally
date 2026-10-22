import { useMemo, useState } from "react";
import { Cell, Label, Pie, PieChart } from "recharts";
import { Copy } from "lucide-react";
import {
  languageTotals,
  repositoryShares,
  METRIC_LABELS,
} from "../../model.mjs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { categoricalPalette, compact, format } from "@/lib/dashboard";
import type { Metric, Repository } from "@/lib/types";

type Props = {
  repositories: Repository[];
  metric: Metric;
  language: string;
  colors: Map<string, string>;
  onCopy: (repository: Repository) => void;
};
type Item = { id: string; name: string; value: number; color: string };
const languageColors: Record<string, string> = {
  Python: "#9c8971",
  C: "#83917b",
  "C++": "#8a87a1",
  "C#": "#7a8062",
  TypeScript: "#647f8d",
  JavaScript: "#a39a75",
  TSX: "#94859d",
  Go: "#7e9898",
  Rust: "#a37970",
  Markdown: "#6f7c86",
  HTML: "#ad8b73",
  CSS: "#9d8192",
  QML: "#758f86",
};
function languageColor(name: string) {
  let hash = 0;
  for (const character of name)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (
    languageColors[name] ?? categoricalPalette[hash % categoricalPalette.length]
  );
}

export function CompositionChart({
  repositories,
  metric,
  language,
  colors,
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
            color: colors.get(item.id) ?? "var(--chart-1)",
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
  const percentage = (value: number) =>
    (value / total) * 100 < 0.1
      ? "<0.1%"
      : `${((value / total) * 100).toFixed(1)}%`;

  return (
    <Card
      data-panel="composition"
      className="dashboard-panel @container min-w-0 gap-0 py-0 shadow-none"
    >
      <CardHeader className="panel-heading flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <CardTitle className="text-base font-medium">规模构成</CardTitle>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tabs
            value={dimension}
            onValueChange={(value) => {
              setDimension(value);
              setActive(null);
            }}
          >
            <TabsList aria-label="构成维度" className="h-8">
              <TabsTrigger value="language" className="text-xs">
                语言
              </TabsTrigger>
              <TabsTrigger value="repository" className="text-xs">
                仓库
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={sorting} onValueChange={setSorting}>
            <SelectTrigger aria-label="构成排序" className="h-8 w-28 text-xs">
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
      <CardContent className="analysis-content">
        {total > 0 ? (
          <div className="composition-layout">
            <ChartContainer
              config={config}
              className="composition-donut mx-auto aspect-square"
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
                  data={items}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="72%"
                  outerRadius="92%"
                  strokeWidth={2}
                  stroke="var(--background)"
                  isAnimationActive={false}
                  onMouseEnter={(_, index) => setActive(items[index].id)}
                  onMouseLeave={() => setActive(null)}
                >
                  {items.map((item) => (
                    <Cell
                      key={item.id}
                      fill={item.color}
                      opacity={!selected || selected.id === item.id ? 1 : 0.3}
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
                            className="composition-total fill-foreground tabular-nums"
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
            <div className="min-w-0">
              <div className="mb-2 flex justify-between px-2 text-xs text-muted-foreground">
                <span>{dimension === "repository" ? "仓库" : "语言"}</span>
                <span>{METRIC_LABELS[metric]} / 占比</span>
              </div>
              <ul
                className="composition-list divide-y divide-border/50 overflow-auto"
                aria-label={
                  dimension === "repository" ? "仓库构成明细" : "语言构成明细"
                }
              >
                {items.map((item) => (
                  <li
                    key={item.id}
                    tabIndex={0}
                    className={`flex min-h-11 items-center gap-2 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${active === item.id ? "bg-muted/50" : ""}`}
                    onMouseEnter={() => setActive(item.id)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(item.id)}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget))
                        setActive(null);
                    }}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: item.color }}
                    />
                    {dimension === "repository" ? (
                      <Button
                        variant="ghost"
                        className="h-8 min-w-0 flex-1 justify-start gap-1.5 px-0 font-normal hover:bg-transparent"
                        aria-label={`复制完整仓库名称 ${repositories.find((repository) => repository.id === item.id)?.name ?? item.name}`}
                        onClick={() => {
                          const repository = repositories.find(
                            (repository) => repository.id === item.id,
                          );
                          if (repository) onCopy(repository);
                        }}
                      >
                        <span className="truncate" title={item.name}>
                          {item.name}
                        </span>
                        <Copy className="size-3 shrink-0 text-muted-foreground" />
                      </Button>
                    ) : (
                      <span
                        className="min-w-0 flex-1 truncate text-sm"
                        title={item.name}
                      >
                        {item.name}
                      </span>
                    )}
                    <span className="text-sm tabular-nums">
                      {format(item.value)}
                    </span>
                    <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {percentage(item.value)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            暂无{dimension === "repository" ? "仓库" : "语言"}数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}
