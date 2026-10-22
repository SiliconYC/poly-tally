import { useDeferredValue, useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FolderGit2,
  LockKeyhole,
  Search,
} from "lucide-react";
import {
  METRIC_LABELS,
  latestTotals,
  repositoryDisplayName,
} from "../../model.mjs";
import { repositoryCsv } from "../../insights.mjs";
import type { Repository } from "@/lib/types";
import {
  downloadCsv,
  format,
  metricOrder,
  repositoryContext,
  safeRepositoryUrl,
  tableRows,
} from "@/lib/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SelectControl } from "./select-control";

type Row = ReturnType<typeof tableRows>[number];
export function RepositoryTable({
  repositories,
  language,
  generatedAt,
  onCopy,
}: {
  repositories: Repository[];
  language: string;
  generatedAt: string;
  onCopy: (repository: Repository) => void;
}) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "total", desc: true },
  ]);
  const rows = useMemo(
    () => tableRows(repositories, language),
    [repositories, language],
  );
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.repository.name,
        header: "仓库",
        cell: ({ row }) => {
          const repository = row.original.repository,
            url = safeRepositoryUrl(repository);
          return (
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                {repository.visibility === "private" ? (
                  <LockKeyhole className="size-3.5 text-muted-foreground" />
                ) : (
                  <FolderGit2 className="size-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <button
                    className="max-w-56 truncate text-left font-medium hover:underline underline-offset-4"
                    aria-label={`复制完整仓库名称 ${repository.name}`}
                    title={`复制 ${repository.name}`}
                    onClick={() => onCopy(repository)}
                  >
                    {repositoryDisplayName(repository)}
                  </button>
                  {url && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      asChild
                    >
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`在 GitHub 打开 ${repository.name}（新标签页）`}
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    </Button>
                  )}
                </div>
                <p className="sr-only" title={repository.notice}>
                  {repositoryContext(repository)}
                </p>
              </div>
            </div>
          );
        },
      },
      ...metricOrder.map((key) => ({
        id: key,
        accessorKey: key,
        header: METRIC_LABELS[key],
        cell: ({ getValue }: { getValue: () => unknown }) => (
          <span className="tabular-nums">{format(getValue() as number)}</span>
        ),
      })),
    ],
    [onCopy],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: deferred },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 100 } },
    globalFilterFn: (row, _column, filter) =>
      row.original.repository.name
        .toLocaleLowerCase()
        .includes(String(filter).trim().toLocaleLowerCase()),
  });
  const filtered = table
    .getSortedRowModel()
    .rows.map((row) => row.original.repository);
  const totals = useMemo(
    () => latestTotals(filtered, language),
    [filtered, language],
  );
  return (
    <Card className="gap-4 shadow-none" id="repositories">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>
              仓库明细{" "}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {filtered.length} 个仓库
              </span>
            </CardTitle>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              downloadCsv(repositoryCsv(filtered, language), generatedAt)
            }
            disabled={!filtered.length}
          >
            <Download className="size-4" />
            导出 CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索仓库列表"
            placeholder="搜索仓库…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={
                        header.id === "name"
                          ? "min-w-56"
                          : "text-right whitespace-nowrap"
                      }
                      aria-sort={
                        header.column.getIsSorted() === "asc"
                          ? "ascending"
                          : header.column.getIsSorted() === "desc"
                            ? "descending"
                            : "none"
                      }
                    >
                      <button
                        className="inline-flex h-10 items-center gap-1.5 text-xs font-medium hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                        aria-label={`按${String(header.column.columnDef.header)}排序`}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {header.column.getIsSorted() === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : header.column.getIsSorted() === "desc" ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={
                          cell.column.id === "name" ? "py-3" : "text-right py-3"
                        }
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-32 text-center text-muted-foreground"
                  >
                    {query
                      ? "没有匹配的仓库，请调整搜索内容。"
                      : "没有选中的可用仓库，请调整筛选或等待首次采集。"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">当前列表合计</TableCell>
                {metricOrder.map((key) => (
                  <TableCell
                    key={key}
                    className="text-right tabular-nums font-semibold"
                  >
                    {format(totals[key])}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        {filtered.length > 100 && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              显示{" "}
              {filtered.length
                ? table.getState().pagination.pageIndex *
                    table.getState().pagination.pageSize +
                  1
                : 0}
              –
              {Math.min(
                (table.getState().pagination.pageIndex + 1) *
                  table.getState().pagination.pageSize,
                filtered.length,
              )}{" "}
              / {format(filtered.length)} 项
            </span>
            <div className="flex items-center gap-2">
              <SelectControl
                label="每页仓库数"
                value={String(table.getState().pagination.pageSize)}
                onChange={(value) => table.setPageSize(Number(value))}
                className="h-8"
                options={[
                  ["100", "100 / 页"],
                  ["200", "200 / 页"],
                  ["500", "500 / 页"],
                ]}
              />
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="上一页"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="下一页"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
