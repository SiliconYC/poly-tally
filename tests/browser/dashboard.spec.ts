import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { fixture, repository, snapshot } from "../../web/src/lib/fixtures";
import { latestTotals, selectRepositories } from "../../web/model.mjs";
import type { Dataset } from "../../web/src/lib/types";

async function dataset(page: Page, data: Dataset) {
  await page.route("**/data/stats.json", (route) =>
    route.fulfill({ json: data }),
  );
}
async function open(page: Page, data: Dataset = fixture()) {
  await dataset(page, data);
  await page.goto("./");
  await expect(page.getByTestId("metric-code")).toBeVisible();
}

async function changeTooltip(page: Page, label: string) {
  const panel = page.locator('[data-panel="changes"]');
  const tick = panel
    .locator("text")
    .filter({ hasText: new RegExp(`^${label}$`) });
  await expect(tick).toBeVisible();
  await tick.scrollIntoViewIfNeeded();
  const tickBounds = await tick.boundingBox();
  const chartBounds = await panel.locator(".recharts-wrapper").boundingBox();
  expect(tickBounds).not.toBeNull();
  expect(chartBounds).not.toBeNull();
  await page.mouse.move(
    tickBounds!.x + tickBounds!.width / 2,
    chartBounds!.y + chartBounds!.height / 2,
  );
  const tooltip = panel.locator(".recharts-tooltip-wrapper");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(label);
  return tooltip;
}

test("production Pages subpath serves hashed assets, favicon and the actual empty baseline", async ({
  page,
}) => {
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(response.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await expect(page.getByTestId("metric-code")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Poly Tally.", exact: true, level: 1 }),
  ).toBeVisible();
  expect(await page.locator("script[src]").last().getAttribute("src")).toMatch(
    /^\/poly-tally\/assets\/.*\.js$/,
  );
  expect(
    await page.locator('link[rel="stylesheet"]').getAttribute("href"),
  ).toMatch(/^\/poly-tally\/assets\/.*\.css$/);
  expect(failed).toEqual([]);
  expect(errors).toEqual([]);
  const response = await page.request.get("./data/stats.json");
  expect(response.ok()).toBe(true);
});

test("global metric, visibility, language, picker selection, search and reset remain linked", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "总行数 52", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "总行数 52", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("combobox", { name: "仓库范围", exact: true }).click();
  await page.getByRole("option", { name: "仅私有", exact: true }).click();
  await expect(page.getByTestId("metric-code")).toHaveText("20");
  await expect(
    page.getByRole("button", { name: "复制完整仓库名称 owner/beta" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "在 GitHub 打开 owner/beta（新标签页）" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await page.getByRole("combobox", { name: "语言筛选", exact: true }).click();
  await page.getByRole("option", { name: "TypeScript", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "语言筛选" })).toContainText(
    "TypeScript",
  );
  await expect(page.getByTestId("metric-code")).toHaveText("40");
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await page.getByRole("button", { name: "全部仓库", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索可选仓库" }).fill("alpha");
  await expect(
    page.getByRole("checkbox", { name: "选择仓库 owner/beta" }),
  ).toHaveCount(0);
  await page.getByRole("checkbox", { name: "选择仓库 owner/alpha" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("metric-code")).toHaveText("20");
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索仓库列表" }).fill("alpha");
  await expect(page.getByText("1 个仓库", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "复制完整仓库名称 owner/beta" }),
  ).toHaveCount(0);
});

test("history legend, snapshots, percent mode, dates, Brush and reset are interactive", async ({
  page,
}) => {
  await open(page);
  await page.getByText(/仓库图层（/).click();
  await page
    .getByRole("button", { name: "显示或隐藏 alpha", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "显示或隐藏 alpha", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("metric-code")).toHaveText("40");
  await page.getByRole("button", { name: "全部显示", exact: true }).click();
  await page.getByRole("tab", { name: "百分比", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "百分比", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("table", { name: "快照明细" })).not.toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: /^快照明细$/ })
    .click();
  await expect(page.getByRole("table", { name: "快照明细" })).toBeVisible();
  const history = page.getByRole("region", { name: "历史趋势图" });
  await history.focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("table", { name: "快照明细" })).toContainText(
    "10",
  );
  await page.keyboard.press("End");
  await expect(page.getByRole("table", { name: "快照明细" })).toContainText(
    "20",
  );
  await page.getByLabel("时间范围开始日期 UTC").fill("2026-01-15");
  await expect(page.getByLabel("时间范围开始日期 UTC")).toHaveValue(
    "2026-01-15",
  );
  const brush = page.locator(".recharts-brush-slide");
  await expect(brush).toBeVisible();
  const handle = page.locator(".recharts-brush-traveller").first();
  await handle.scrollIntoViewIfNeeded();
  const beforeBrush = await page
    .getByLabel("时间范围开始日期 UTC")
    .inputValue();
  const brushBounds = await page.locator(".recharts-brush").boundingBox();
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds!.x + brushBounds!.width * 0.55,
    bounds!.y + bounds!.height / 2,
    {
      steps: 5,
    },
  );
  await page.mouse.up();
  await expect(page.getByLabel("时间范围开始日期 UTC")).not.toHaveValue(
    beforeBrush,
  );
  await page.getByRole("button", { name: "恢复全部历史" }).click();
  await expect(page.getByLabel("时间范围开始日期 UTC")).toHaveValue(
    "2026-01-01",
  );
  await expect(page.locator(".recharts-area-area").first()).toHaveAttribute(
    "d",
    /H|h|L/,
  );
});

test("composition stays local while periods and an independent change metric preserve zero versus unknown", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("list", { name: "语言构成明细" })
    .getByRole("listitem")
    .filter({ hasText: "TypeScript" })
    .click();
  await expect(page.getByRole("combobox", { name: "语言筛选" })).toContainText(
    "全部语言",
  );
  await expect(page.getByTestId("metric-code")).toHaveText("40");
  await page.getByRole("tab", { name: "仓库", exact: true }).click();
  await page
    .getByRole("list", { name: "仓库构成明细" })
    .getByRole("listitem")
    .filter({ hasText: "beta" })
    .click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("metric-code")).toHaveText("40");
  await expect(
    page.getByRole("button", { name: "全部仓库", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "每日", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "每日", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "每周", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "每周", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "每月", exact: true }).click();
  const start = await page.getByLabel("时间范围开始日期 UTC").inputValue();
  const end = await page.getByLabel("时间范围结束日期 UTC").inputValue();
  await page
    .locator(
      '[data-panel="changes"] .recharts-bar-rectangle .recharts-rectangle',
    )
    .last()
    .click();
  await expect(page.getByLabel("时间范围开始日期 UTC")).toHaveValue(start);
  await expect(page.getByLabel("时间范围结束日期 UTC")).toHaveValue(end);
  await page.getByRole("combobox", { name: "净变化指标", exact: true }).click();
  await page.getByRole("option", { name: "文件数", exact: true }).click();
  const unknown = await changeTooltip(page, "2026-01");
  await expect(unknown).toContainText("暂无对比数据");
  await expect(unknown).not.toContainText("0 文件数");
  const zero = await changeTooltip(page, "2026-02");
  await expect(zero).toContainText("0 文件数");
  await expect(zero).not.toContainText("暂无对比数据");
  await expect(
    page.getByRole("button", { name: "代码行 40", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("CSV exports the sorted and searched list, and name copying uses the representative", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await page.getByRole("textbox", { name: "搜索仓库列表" }).fill("alpha");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const download = await downloadEvent;
  const path = await download.path();
  const csv = await readFile(path!, "utf8");
  expect(csv).toContain("alpha,公开");
  expect(csv).not.toContain("beta");
  expect(csv).toContain("26,20,2,3,1,2");
  await page
    .getByRole("button", { name: "复制完整仓库名称 owner/alpha", exact: true })
    .click();
  await expect(
    page.getByText("已复制 owner/alpha", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "owner/alpha",
  );
});

test("failure can retry, malformed data fails and a real empty result is recoverable", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/data/stats.json", (route) =>
    ++calls === 1
      ? route.fulfill({ status: 503, body: "Unavailable" })
      : route.fulfill({ json: fixture() }),
  );
  await page.goto("./");
  await expect(page.getByText("暂时无法读取统计数据")).toBeVisible();
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByTestId("metric-code")).toHaveText("40");
  await page.unroute("**/data/stats.json");
  await dataset(page, { ...fixture(), repositories: [] });
  await page.reload();
  await expect(page.getByText(/尚无可发布的仓库数据/)).toBeVisible();
  const invalid = fixture();
  invalid.repositories[0].history[0].metrics.code = -1;
  await page.unroute("**/data/stats.json");
  await dataset(page, invalid);
  await page.reload();
  await expect(page.getByText("暂时无法读取统计数据")).toBeVisible();
});

test("stale and mismatched data show warnings, archives and inclusion follow original semantics", async ({
  page,
}) => {
  const data = fixture();
  data.repositories[0].status = "stale";
  data.repositories[1].rulesVersion = "old";
  data.repositories.push({ ...repository("cold"), status: "cold" });
  await open(page, data);
  await expect(page.getByText(/旧规则快照/)).toBeVisible();
  await expect(page.getByText(/过期或不可访问仓库未纳入/)).toBeVisible();
  await expect(page.getByTestId("metric-code")).toHaveText("0");
  await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await page.getByRole("switch", { name: "包含过期快照", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("metric-code")).toHaveText("20");
  await page.getByRole("tab", { name: "历史档案", exact: true }).click();
  await expect(page.getByTestId("metric-code")).toHaveText("40");
  await expect(page.getByText(/冷数据仓库/)).toBeVisible();
});

test("pagination and additive multi-field sorting keep totals over the full filtered list", async ({
  page,
}) => {
  const data = fixture();
  data.repositories = Array.from({ length: 105 }, (_, i) =>
    repository(`repo-${String(i).padStart(3, "0")}`, [
      snapshot("2026-01-01", i + 1),
    ]),
  );
  await open(page, data);
  await expect(
    page.getByRole("button", { name: /复制完整仓库名称 owner\/repo-/ }),
  ).toHaveCount(100);
  await expect(page.getByText("显示 1–100 / 105 项")).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("显示 101–105 / 105 项")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /复制完整仓库名称 owner\/repo-/ }),
  ).toHaveCount(5);
  await page.getByRole("combobox", { name: "每页仓库数", exact: true }).click();
  for (const size of [100, 200, 500])
    await expect(
      page.getByRole("option", { name: `${size} / 页`, exact: true }),
    ).toBeVisible();
  await page.getByRole("option", { name: "200 / 页", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /复制完整仓库名称 owner\/repo-/ }),
  ).toHaveCount(105);
  await expect(page.getByText("显示 1–105 / 105 项")).toBeVisible();
  await page.getByRole("combobox", { name: "每页仓库数", exact: true }).click();
  await page.getByRole("option", { name: "100 / 页", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /复制完整仓库名称 owner\/repo-/ }),
  ).toHaveCount(100);
  await page.getByRole("button", { name: "按仓库排序", exact: true }).click();
  await page
    .getByRole("button", { name: "按代码行排序", exact: true })
    .click({ modifiers: ["Shift"] });
  const headers = page.locator("#repositories th[aria-sort]");
  expect(
    await headers.evaluateAll(
      (elements) =>
        elements.filter(
          (element) => element.getAttribute("aria-sort") !== "none",
        ).length,
    ),
  ).toBe(2);
  await expect(page.locator("tfoot")).toContainText("5,565");
  await page.getByRole("textbox", { name: "搜索仓库列表" }).fill("repo-");
  await expect(page.getByText("显示 1–100 / 105 项")).toBeVisible();
  await expect(page.locator("tfoot")).toContainText("5,565");
  const allDownloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const allCsv = await readFile(
    (await (await allDownloadEvent).path())!,
    "utf8",
  );
  expect(allCsv.trimEnd().split(/\r?\n/)).toHaveLength(106);
  expect(allCsv).toContain("repo-000,公开");
  expect(allCsv).toContain("repo-104,公开");
  await page.getByRole("textbox", { name: "搜索仓库列表" }).fill("repo-10");
  await expect(page.getByText("5 个仓库", { exact: true })).toBeVisible();
  await expect(page.locator("tfoot")).toContainText("515");
  const searchedDownloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const searchedCsv = await readFile(
    (await (await searchedDownloadEvent).path())!,
    "utf8",
  );
  expect(searchedCsv.trimEnd().split(/\r?\n/)).toHaveLength(6);
  expect(searchedCsv).toContain("repo-100,公开");
  expect(searchedCsv).toContain("repo-104,公开");
  expect(searchedCsv).not.toContain("repo-099,公开");
});

test("mobile, tablet and desktop support light/dark without page overflow and persist theme", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  for (const width of [1440, 1200, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "重置筛选", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "切换浅色模式" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.getByRole("button", { name: "切换深色模式" }).click();
  }
});

test("published real data matches the existing model in every metric and leaves visual evidence", async ({
  page,
}) => {
  test.skip(
    !process.env.POLY_TALLY_REAL_STATS,
    "Set POLY_TALLY_REAL_STATS to a downloaded public dataset for real-data acceptance",
  );
  const data = JSON.parse(
    await readFile(process.env.POLY_TALLY_REAL_STATS!, "utf8"),
  ) as Dataset;
  const totals = latestTotals(selectRepositories(data));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, data);
  await expect(page.locator("#history .recharts-area").first()).toBeVisible();
  await expect(
    page.locator('[data-panel="composition"] .recharts-pie-sector').first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-panel="changes"] .recharts-bar-rectangle').first(),
  ).toBeVisible();
  for (const metric of [
    "total",
    "code",
    "comment",
    "documentation",
    "blank",
    "files",
  ] as const)
    await expect(page.getByTestId(`metric-${metric}`)).toHaveText(
      new Intl.NumberFormat("zh-CN").format(totals[metric]),
    );
  await mkdir("docs/qa/contrast-fix", { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    if (
      await page
        .locator("html")
        .evaluate((element) => element.classList.contains("dark"))
    )
      await page.getByRole("button", { name: "切换浅色模式" }).click();
    await page.screenshot({
      path: `docs/qa/contrast-fix/${width}-light.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "切换深色模式" }).click();
    await page.screenshot({
      path: `docs/qa/contrast-fix/${width}-dark.png`,
      fullPage: true,
    });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  expect(errors).toEqual([]);
});

test("large aligned histories render without discarding changes and remain interactive", async ({
  page,
}) => {
  test.setTimeout(90000);
  const { stressRepositories } = await import("../../scripts/bench-dashboard");
  const reports = [];
  for (const [name, count, snapshots, repeated] of [
    ["distinct", 20, 500, false],
    ["repeated", 40, 2500, true],
  ] as const) {
    const repositories = stressRepositories(count, snapshots, repeated);
    const data = {
      ...fixture(),
      generatedAt: repositories.at(-1)!.history.at(-1)!.timestamp,
      repositories,
    };
    await page.unroute("**/data/stats.json");
    await dataset(page, data);
    const start = performance.now();
    await page.goto("./");
    await expect(
      page
        .getByRole("region", { name: "历史趋势图" })
        .locator(".recharts-area-area"),
    ).toHaveCount(count, { timeout: 20000 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const renderMs = performance.now() - start;
    const percent = performance.now();
    await page.getByRole("tab", { name: "百分比", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "百分比", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const percentMs = performance.now() - percent;
    await page
      .locator("summary")
      .filter({ hasText: /^快照明细$/ })
      .click();
    await expect(page.getByRole("table", { name: "快照明细" })).toBeVisible();
    const keyboard = performance.now();
    await page.getByRole("region", { name: "历史趋势图" }).focus();
    await page.keyboard.press("Home");
    await expect(page.getByRole("table", { name: "快照明细" })).toContainText(
      "尚未观测",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const keyboardMs = performance.now() - keyboard;
    reports.push({
      name,
      repositories: count,
      snapshots: count * snapshots,
      renderMs: Math.round(renderMs),
      percentMs: Math.round(percentMs),
      keyboardMs: Math.round(keyboardMs),
    });
    expect(renderMs).toBeLessThan(20000);
    expect(percentMs).toBeLessThan(6000);
    expect(keyboardMs).toBeLessThan(6000);
  }
  await mkdir("docs/qa/contrast-fix", { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    "docs/qa/contrast-fix/browser-performance.json",
    JSON.stringify(
      {
        browser: await page.context().browser()!.version(),
        viewport: { width: 1440, height: 1100 },
        reports,
      },
      null,
      2,
    ) + "\n",
  );
});
