import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect } from "vitest";
import { App } from "./app";
import { fixture } from "./lib/fixtures";
vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: import("react").ReactNode }) =>
    children,
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));
vi.mock("./components/history-chart", () => ({
  HistoryChart: () => <div>历史图表</div>,
}));
vi.mock("./components/composition-chart", () => ({
  CompositionChart: () => <div>构成图表</div>,
}));
vi.mock("./components/changes-chart", () => ({
  ChangesChart: () => <div>变化图表</div>,
}));

it("loads six metrics and drives scope, metric and reset from a single state", async () => {
  const user = userEvent.setup();
  render(<App load={() => Promise.resolve(fixture())} />);
  await screen.findByTestId("metric-code");
  expect(screen.getByRole("button", { name: /总行数 52/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /代码行 40/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("button", { name: /总行数 52/ }));
  expect(screen.getByRole("button", { name: /总行数 52/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("combobox", { name: "仓库范围" }));
  await user.click(screen.getByRole("option", { name: "仅私有" }));
  expect(screen.getByRole("button", { name: /总行数 26/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重置筛选" }));
  expect(screen.getByRole("button", { name: /代码行 40/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
it("shows load failure with functional retry and an honest empty dataset", async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("HTTP 503"))
    .mockResolvedValueOnce({ ...fixture(), repositories: [] });
  render(<App load={load} />);
  await screen.findByText("暂时无法读取统计数据");
  await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByText(/尚无可发布的仓库数据/);
  expect(screen.getByRole("button", { name: /总行数 0/ })).toBeInTheDocument();
});
it("does not call an incomplete collection complete, and isolates mismatched rules", async () => {
  const data = fixture();
  data.lineageVersion = "v1";
  data.completeness = { complete: false };
  data.runs![0].completeness = { complete: false };
  data.repositories[0].rulesVersion = "old";
  render(<App load={() => Promise.resolve(data)} />);
  await screen.findByText(/全量重算未完成/);
  await userEvent.click(screen.getByText("统计说明", { selector: "summary" }));
  expect(screen.getByText("采集未完整")).toBeVisible();
  expect(screen.getByRole("button", { name: /代码行 20/ })).toBeInTheDocument();
});
it("searches the repository table and keeps CSV and totals scoped to visible search results", async () => {
  render(<App load={() => Promise.resolve(fixture())} />);
  const query = await screen.findByRole("textbox", { name: "搜索仓库列表" });
  await userEvent.type(query, "alpha");
  await waitFor(() => expect(screen.getByText("1 个仓库")).toBeInTheDocument());
  expect(
    screen.getByRole("button", { name: "复制完整仓库名称 owner/alpha" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "复制完整仓库名称 owner/beta" }),
  ).not.toBeInTheDocument();
});
