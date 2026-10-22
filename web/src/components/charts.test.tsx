import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { HistoryChart } from "./history-chart";
import { CompositionChart } from "./composition-chart";
import { ChangesChart } from "./changes-chart";
import { repository, snapshot } from "../lib/fixtures";

const { plotCommits } = vi.hoisted(() => ({ plotCommits: [] as string[] }));
vi.mock("@/components/ui/chart", async (load) => {
  const original = await load<typeof import("@/components/ui/chart")>();
  const { createElement, Profiler } = await import("react");
  return {
    ...original,
    ChartContainer: (
      props: React.ComponentProps<typeof original.ChartContainer>,
    ) =>
      createElement(
        Profiler,
        {
          id: props.config.total ? "navigator" : "plot",
          onRender: (id: string) => {
            plotCommits.push(id);
          },
        },
        createElement(original.ChartContainer, props),
      ),
  };
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 800,
    right: 800,
    top: 0,
    bottom: 320,
    height: 320,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

const repositories = [
  repository("early", [snapshot("2026-01-01", 10), snapshot("2026-01-03", 5)]),
  repository("late", [snapshot("2026-01-04", 20)]),
];
const colors = new Map([
  ["early", "#0d9488"],
  ["late", "#3b82f6"],
]);
const until = "2026-01-05T00:00:00Z";
const historyProps = {
  repositories,
  colors,
  until,
  metric: "code" as const,
  language: "all",
  range: null,
  onRangeChange: vi.fn(),
};

describe("history interactions", () => {
  it("keeps a not-yet-observed repository unknown in keyboard snapshot details", () => {
    render(<HistoryChart {...historyProps} />);
    const chart = screen.getByRole("region", { name: "历史趋势图" });
    fireEvent.keyDown(chart, { key: "Home" });
    const details = screen.getByRole("table", { name: "快照明细" });
    expect(
      within(details).getByRole("row", { name: /early 10/ }),
    ).toBeVisible();
    expect(
      within(details).getByRole("row", { name: /late 尚未观测/ }),
    ).toBeVisible();
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(within(details).getByRole("row", { name: /early 5/ })).toBeVisible();
    fireEvent.keyDown(chart, { key: "End" });
    expect(within(details).getByRole("row", { name: /late 20/ })).toBeVisible();
  });
  it("supports hide, shift-isolate, and explicit restore without filtering the other charts", () => {
    render(<HistoryChart {...historyProps} />);
    fireEvent.click(screen.getByText("仓库图层（2）"));
    fireEvent.click(screen.getByRole("button", { name: "显示或隐藏 early" }));
    expect(
      screen.getByRole("button", { name: "显示或隐藏 early" }),
    ).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "显示或隐藏 late" }), {
      shiftKey: true,
    });
    expect(
      screen.getByRole("button", { name: "显示或隐藏 late" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "全部显示" }));
    expect(
      screen.getByRole("button", { name: "显示或隐藏 early" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
  it("passes a UTC date window and can restore it", () => {
    const change = vi.fn();
    render(<HistoryChart {...historyProps} onRangeChange={change} />);
    fireEvent.change(screen.getByLabelText("时间范围开始日期 UTC"), {
      target: { value: "2026-01-02" },
    });
    expect(change).toHaveBeenLastCalledWith([
      Date.parse("2026-01-02T00:00:00Z"),
      Date.parse(until),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "恢复全部历史" }));
    expect(change).toHaveBeenLastCalledWith(null);
  });
});

it("composition repository copy and global selection remain independent", async () => {
  const copy = vi.fn(),
    select = vi.fn(),
    language = vi.fn();
  render(
    <CompositionChart
      repositories={repositories}
      metric="code"
      language="all"
      colors={colors}
      onCopy={copy}
      onRepositorySelect={select}
      onLanguageChange={language}
    />,
  );
  await userEvent.click(screen.getByRole("tab", { name: "仓库" }));
  fireEvent.click(
    screen.getByRole("button", { name: "复制完整仓库名称 owner/late" }),
  );
  expect(copy).toHaveBeenCalledWith(repositories[1]);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "筛选仓库 late" }));
  expect(select).toHaveBeenCalledWith("late");
  expect(language).not.toHaveBeenCalled();
});

it("unknown net change stays incomparable and selecting a period links its exact bounds", () => {
  const onRangeChange = vi.fn();
  render(
    <ChangesChart
      repositories={[repository("new", [snapshot("2026-01-03", 10)])]}
      language="all"
      since="2026-01-01T00:00:00Z"
      until={until}
      onRangeChange={onRangeChange}
    />,
  );
  expect(screen.getByLabelText("净变化周期明细")).toHaveTextContent(
    "暂无可比数据",
  );
  expect(screen.getByLabelText("净变化周期明细")).toHaveTextContent("缺少期初");
  fireEvent.click(
    screen.getByRole("button", { name: /2026-01.*暂无可比数据/ }),
  );
  expect(onRangeChange).toHaveBeenCalledWith([
    Date.parse("2026-01-01T00:00:00Z"),
    Date.parse(until),
  ]);
});

it("clicking a carry-forward interval pins its actual earlier snapshot rather than the nearest later snapshot", () => {
  render(<HistoryChart {...historyProps} />);
  const region = screen.getByRole("region", { name: "历史趋势图" });
  const plot = region.firstElementChild as HTMLDivElement;
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 1000,
    right: 1000,
    top: 0,
    bottom: 320,
    height: 320,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent.click(plot, { clientX: 450 });
  expect(
    within(screen.getByRole("table", { name: "快照明细" })).getByRole("row", {
      name: /late 尚未观测/,
    }),
  ).toBeVisible();
  expect(
    within(screen.getByRole("table", { name: "快照明细" })).getByRole("row", {
      name: /early 10/,
    }),
  ).toBeVisible();
  fireEvent.keyDown(region, { key: "Escape" });
  expect(
    within(screen.getByRole("table", { name: "快照明细" })).getByRole("row", {
      name: /late 20/,
    }),
  ).toBeVisible();
});

it("percent mode retains exact absolute snapshot details while changing the rendered axis", async () => {
  render(<HistoryChart {...historyProps} />);
  await userEvent.click(screen.getByRole("tab", { name: "百分比" }));
  expect(screen.getByRole("tab", { name: "百分比" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
  expect(
    within(screen.getByRole("table", { name: "快照明细" })).getByRole("row", {
      name: /late 20 80.0%/,
    }),
  ).toBeVisible();
});
it("hiding every layer has a recoverable empty state", () => {
  render(<HistoryChart {...historyProps} />);
  fireEvent.click(screen.getByText("仓库图层（2）"));
  fireEvent.click(screen.getByRole("button", { name: "显示或隐藏 early" }));
  fireEvent.click(screen.getByRole("button", { name: "显示或隐藏 late" }));
  expect(screen.getByText(/所有仓库图层均已隐藏/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "全部显示" }));
  expect(screen.getByRole("table", { name: "快照明细" })).toBeVisible();
});
it("composition sorting changes actual repository order and language selection stays available", async () => {
  const language = vi.fn();
  render(
    <CompositionChart
      repositories={repositories}
      metric="code"
      language="all"
      colors={colors}
      onCopy={vi.fn()}
      onRepositorySelect={vi.fn()}
      onLanguageChange={language}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "筛选语言 TypeScript" }),
  );
  expect(language).toHaveBeenCalledWith("TypeScript");
  await userEvent.click(screen.getByRole("tab", { name: "仓库" }));
  const rows = screen.getByLabelText("仓库构成明细");
  expect(
    within(rows).getAllByRole("button", { name: /筛选仓库/ })[0],
  ).toHaveAccessibleName("筛选仓库 late");
  await userEvent.click(screen.getByRole("combobox", { name: "构成排序" }));
  await userEvent.click(screen.getByRole("option", { name: "规模升序" }));
  expect(
    within(rows).getAllByRole("button", { name: /筛选仓库/ })[0],
  ).toHaveAccessibleName("筛选仓库 early");
});
it("net changes distinguish a known zero from unknown and keep their metric independent", async () => {
  render(
    <ChangesChart
      repositories={[repositories[0]]}
      language="all"
      since="2026-01-02T00:00:00Z"
      until={until}
      onRangeChange={vi.fn()}
    />,
  );
  const details = screen.getByLabelText("净变化周期明细");
  expect(details).toHaveTextContent("-5 代码行");
  expect(details).toHaveTextContent("部分周期");
  await userEvent.click(screen.getByRole("combobox", { name: "净变化指标" }));
  await userEvent.click(screen.getByRole("option", { name: "文件数" }));
  expect(details).toHaveTextContent("0 文件数");
  expect(details).not.toHaveTextContent("暂无可比数据");
  await userEvent.click(screen.getByRole("tab", { name: "每日" }));
  expect(
    within(screen.getByLabelText("净变化周期列表")).getAllByRole("button"),
  ).toHaveLength(4);
});

it("history provides a scroll target and keeps the repository legend collapsed until requested", async () => {
  render(<HistoryChart {...historyProps} />);
  expect(document.getElementById("history")).toBeInTheDocument();
  const legend = screen.getByText("仓库图层（2）").closest("details");
  expect(legend).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("仓库图层（2）"));
  expect(legend).toHaveAttribute("open");
  expect(
    screen.getByRole("button", { name: "显示或隐藏 early" }),
  ).toBeVisible();
});

it("snapshot selection and hover update details without rendering either Recharts tree again", () => {
  render(<HistoryChart {...historyProps} />);
  const region = screen.getByRole("region", { name: "历史趋势图" });
  const plot = region.firstElementChild as HTMLDivElement;
  const commitsBefore = plotCommits.length;
  fireEvent.keyDown(region, { key: "Home" });
  expect(
    within(screen.getByRole("table", { name: "快照明细" })).getByRole("row", {
      name: /late 尚未观测/,
    }),
  ).toBeVisible();
  expect(plotCommits.slice(commitsBefore)).toEqual([]);
  fireEvent.keyDown(region, { key: "Escape" });
  fireEvent(
    plot,
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 360,
      clientY: 230,
    }),
  );
  expect(
    within(screen.getByRole("table", { name: "快照明细" })).getByRole("row", {
      name: /early 10/,
    }),
  ).toBeVisible();
  expect(plotCommits.slice(commitsBefore)).toEqual([]);
  expect(
    screen.getByRole("status", { name: "历史快照提示" }),
  ).toHaveTextContent("early · 10 · 100.0%");
});
