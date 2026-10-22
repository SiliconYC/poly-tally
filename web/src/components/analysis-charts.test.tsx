import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { CompositionChart } from "./composition-chart";
import { ChangesChart } from "./changes-chart";
import { repository, snapshot } from "../lib/fixtures";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(320);
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
  repository("alpha", [snapshot("2026-01-01", 10), snapshot("2026-02-01", 5)]),
  repository("beta", [snapshot("2026-01-01", 10), snapshot("2026-02-01", 20)]),
];
const colors = new Map([
  ["alpha", "#0d9488"],
  ["beta", "#3b82f6"],
]);

function composition() {
  const callbacks = {
    onLanguageChange: vi.fn(),
    onRepositorySelect: vi.fn(),
    onCopy: vi.fn(),
  };
  const view = render(
    <CompositionChart
      repositories={repositories}
      metric="code"
      language="all"
      colors={colors}
      {...callbacks}
    />,
  );
  return { ...view, ...callbacks };
}

describe("independent composition analysis", () => {
  it("language rows and pie clicks never change the dashboard filters", async () => {
    const { container, onLanguageChange, onRepositorySelect } = composition();
    const list = screen.getByLabelText("语言构成明细");
    await userEvent.click(within(list).getByText("TypeScript"));
    fireEvent.click(container.querySelector(".recharts-sector")!);
    expect(onLanguageChange).not.toHaveBeenCalled();
    expect(onRepositorySelect).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /筛选语言|筛选仓库/ }),
    ).not.toBeInTheDocument();
    const row = within(list).getByRole("listitem");
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.focus(row);
    expect(row).toHaveClass("bg-muted/50");
  });
  it("repository names only copy through their explicit button while sorting remains local", async () => {
    const { onCopy, onRepositorySelect, onLanguageChange } = composition();
    await userEvent.click(screen.getByRole("tab", { name: "仓库" }));
    const list = screen.getByLabelText("仓库构成明细");
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("beta");
    await userEvent.click(
      screen.getByRole("button", { name: "复制完整仓库名称 owner/beta" }),
    );
    expect(onCopy).toHaveBeenCalledWith(repositories[1]);
    expect(onRepositorySelect).not.toHaveBeenCalled();
    expect(onLanguageChange).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "仓库" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(screen.getByRole("combobox", { name: "构成排序" }));
    await userEvent.click(screen.getByRole("option", { name: "规模升序" }));
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("alpha");
  });
});

describe("independent change analysis", () => {
  it("bars have no history action and the card contains no period picker or permanent disclaimer", async () => {
    const callbacks = { onRangeChange: vi.fn() };
    const { container } = render(
      <ChangesChart
        repositories={repositories}
        language="all"
        since="2026-01-02T00:00:00Z"
        until="2026-02-15T00:00:00Z"
        {...callbacks}
      />,
    );
    const bar = container.querySelector(".recharts-bar-rectangle");
    expect(bar).not.toBeNull();
    fireEvent.click(bar!);
    expect(callbacks.onRangeChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("净变化周期明细")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("净变化周期列表")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/周期列表与范围选择|仅比较具有期初|不按零增长显示/),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "每日" }));
    expect(screen.getByRole("tab", { name: "每日" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(screen.getByRole("combobox", { name: "净变化指标" }));
    await userEvent.click(screen.getByRole("option", { name: "文件数" }));
    expect(
      screen.getByRole("combobox", { name: "净变化指标" }),
    ).toHaveTextContent("文件数");
    expect(callbacks.onRangeChange).not.toHaveBeenCalled();
  });
  it("unobserved opening stock remains absent rather than becoming a zero bar", async () => {
    const { container } = render(
      <ChangesChart
        repositories={[repository("new", [snapshot("2026-01-03", 10)])]}
        language="all"
        since="2026-01-01T00:00:00Z"
        until="2026-01-05T00:00:00Z"
        {...{ onRangeChange: vi.fn() }}
      />,
    );
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(
      0,
    );
    fireEvent.mouseMove(container.querySelector(".recharts-wrapper")!, {
      clientX: 400,
      clientY: 100,
    });
    expect(await screen.findByText("暂无对比数据")).toBeVisible();
    expect(screen.queryByLabelText("净变化周期明细")).not.toBeInTheDocument();
  });
});

it("a mixed-coverage change identifies its partial scope only inside the tooltip", async () => {
  const rows = [
    repository("known", [
      snapshot("2025-12-31", 10),
      snapshot("2026-01-31", 15),
    ]),
    repository("new", [snapshot("2026-01-15", 100)]),
  ];
  const { container } = render(
    <ChangesChart
      repositories={rows}
      language="all"
      since="2026-01-01T00:00:00Z"
      until="2026-01-31T23:59:59Z"
    />,
  );
  expect(screen.queryByText(/部分仓库（1\/2）/)).not.toBeInTheDocument();
  fireEvent.mouseMove(container.querySelector(".recharts-wrapper")!, {
    clientX: 400,
    clientY: 100,
  });
  expect(await screen.findByText("+5 代码行")).toBeVisible();
  expect(await screen.findByText(/部分仓库（1\/2）/)).toBeVisible();
});
