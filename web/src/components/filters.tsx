import { useDeferredValue, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Filter, RotateCcw, Search } from "lucide-react";
import {
  repositoryOptions,
  repositoryDisplayName,
  repositoryVisibility,
} from "../../model.mjs";
import type { Dataset, Filters } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SelectControl } from "./select-control";

export function DashboardFilters({
  data,
  filters,
  onChange,
  onReset,
}: {
  data: Dataset;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name-asc");
  const deferred = useDeferredValue(query);
  const options = useMemo(() => {
    const [key, direction] = sort.split("-");
    return repositoryOptions(data.repositories, {
      query: deferred,
      key,
      direction,
      metric: filters.metric,
      language: filters.language,
    });
  }, [data, deferred, sort, filters.metric, filters.language]);
  const languages = useMemo(
    () =>
      [
        ...new Set(
          data.repositories.flatMap((repository) =>
            repository.history.flatMap((snapshot) =>
              Object.keys(snapshot.languages),
            ),
          ),
        ),
      ].sort(),
    [data],
  );
  const selectedIds = useMemo(() => new Set(filters.ids), [filters.ids]);
  return (
    <section aria-label="全局筛选" className="filter-bar space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={filters.mode}
          onValueChange={(mode) => onChange({ mode: mode as Filters["mode"] })}
        >
          <TabsList>
            <TabsTrigger value="current">当前仓库</TabsTrigger>
            <TabsTrigger value="archive">历史档案</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="mx-1 hidden h-5 w-px bg-border md:block" />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="justify-between">
              <Filter className="size-4" />
              {filters.ids.length === data.repositories.length
                ? "全部仓库"
                : `已选 ${filters.ids.length} 个`}
              <ChevronsUpDown className="size-3.5 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(360px,calc(100vw-2rem))] p-3"
          >
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label="搜索可选仓库"
                placeholder="搜索仓库名称…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
              />
            </div>
            <SelectControl
              label="仓库选项排序"
              value={sort}
              onChange={setSort}
              className="w-full"
              options={[
                ["name-asc", "名称 A–Z"],
                ["name-desc", "名称 Z–A"],
                ["metric-desc", "当前指标从多到少"],
                ["metric-asc", "当前指标从少到多"],
                ["updated-desc", "最近更新"],
                ["status-asc", "仓库状态"],
                ["rules-asc", "统计规则"],
              ]}
            />
            <div className="my-2 flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({
                    ids: data.repositories.map((repository) => repository.id),
                  })
                }
              >
                全选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ids: [] })}
              >
                清空选择
              </Button>
              <span className="ml-auto self-center text-xs text-muted-foreground">
                {filters.ids.length} / {data.repositories.length}
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto overscroll-contain space-y-1">
              {options.length ? (
                options.map((repository) => (
                  <label
                    key={repository.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
                  >
                    <Checkbox
                      checked={selectedIds.has(repository.id)}
                      onCheckedChange={(checked) =>
                        onChange({
                          ids: checked
                            ? [...filters.ids, repository.id]
                            : filters.ids.filter((id) => id !== repository.id),
                        })
                      }
                      aria-label={`选择仓库 ${repository.name}`}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-sm"
                      title={repository.name}
                    >
                      {repositoryDisplayName(repository)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {repositoryVisibility(repository) === "private"
                        ? "私有"
                        : "公开"}
                    </span>
                  </label>
                ))
              ) : (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  没有匹配的仓库
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <SelectControl
          label="仓库范围"
          value={filters.scope}
          onChange={(scope) => onChange({ scope: scope as Filters["scope"] })}
          options={[
            ["all", "公开与私有"],
            ["public", "仅公开"],
            ["private", "仅私有"],
          ]}
        />
        <SelectControl
          label="语言筛选"
          value={filters.language}
          onChange={(language) => onChange({ language })}
          options={[
            ["all", "全部语言"],
            ...languages.map((name) => [name, name] as const),
          ]}
        />

        <SelectControl
          label="时间范围"
          value={filters.period}
          onChange={(period) => onChange({ period })}
          options={[
            ["all", "全部时间"],
            ["30", "近 30 天"],
            ["90", "近 90 天"],
            ["365", "近一年"],
          ]}
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" aria-label="更多筛选">
              更多筛选{filters.includeStale && <Check className="size-3.5" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <label className="flex items-center justify-between gap-4 text-sm">
              包含过期快照
              <Switch
                checked={filters.includeStale}
                onCheckedChange={(includeStale) => onChange({ includeStale })}
                aria-label="包含过期快照"
              />
            </label>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              纳入同规则的最后成功快照。过期和不可访问仓库可能与源仓库当前状态不同。
            </p>
          </PopoverContent>
        </Popover>
        <Button
          variant="ghost"
          size="icon"
          aria-label="重置筛选"
          title="重置筛选"
          onClick={() => {
            setQuery("");
            setSort("name-asc");
            onReset();
          }}
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
      {(filters.language !== "all" ||
        filters.scope !== "all" ||
        filters.mode === "archive" ||
        filters.includeStale) && (
        <div className="flex flex-wrap gap-2" aria-label="已启用筛选">
          {filters.language !== "all" && (
            <Badge variant="secondary" className="gap-2">
              {filters.language}
              <button
                aria-label="清除语言筛选"
                onClick={() => onChange({ language: "all" })}
              >
                ×
              </button>
            </Badge>
          )}
          {filters.scope !== "all" && (
            <Badge variant="secondary">
              {filters.scope === "private" ? "仅私有" : "仅公开"}
            </Badge>
          )}
          {filters.mode === "archive" && (
            <Badge variant="secondary">历史档案</Badge>
          )}
          {filters.includeStale && (
            <Badge variant="secondary">含过期快照</Badge>
          )}
        </div>
      )}
    </section>
  );
}
