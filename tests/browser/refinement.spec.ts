import { test, expect, type Page } from "@playwright/test";
import { fixture, repository } from "../../web/src/lib/fixtures";
async function open(page: Page, data = fixture()) {
  await page.route("**/data/stats.json", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("./");
  await expect(page.getByTestId("metric-code")).toHaveText(
    new Intl.NumberFormat("zh-CN").format(data.repositories.length * 20),
  );
}
test("analysis charts are read-only and never change the global scope or history window", async ({
  page,
}) => {
  await open(page);
  const before = await page.getByLabel("时间范围开始日期 UTC").inputValue();
  const composition = page.locator('[data-panel="composition"]');
  // Find the current implementation too, so this fails on the accidental filtering itself.
  const pie = page.locator(".recharts-pie-sector").first();
  await pie.click({ force: true });
  await expect(page.getByRole("combobox", { name: "语言筛选" })).toContainText(
    "全部语言",
  );
  await expect(page.getByTestId("metric-code")).toHaveText("40");
  const bars = page.locator(".recharts-bar-rectangle path");
  if (await bars.count()) await bars.last().click({ force: true });
  await expect(page.getByLabel("时间范围开始日期 UTC")).toHaveValue(before);
  await expect(page.getByText(/周期列表与范围选择/)).toHaveCount(0);
  await expect(composition).toBeVisible();
});
test("100 repository rows are visible by default", async ({ page }) => {
  const data = fixture();
  data.repositories = Array.from({ length: 105 }, (_, index) =>
    repository(`repo-${index}`),
  );
  await open(page, data);
  await expect(page.locator("#repositories tbody tr")).toHaveCount(100);
  await expect(
    page.getByRole("combobox", { name: "每页仓库数" }),
  ).toContainText("100");
});
test("non-editable text has no caret or selection while search remains editable", async ({
  page,
}) => {
  await open(page);
  const styles = await page.getByTestId("metric-code").evaluate((element) => ({
    caret: getComputedStyle(element).caretColor,
    selection: getComputedStyle(element).userSelect,
  }));
  expect(styles.caret).toBe("rgba(0, 0, 0, 0)");
  expect(styles.selection).toBe("none");
  const input = page.getByRole("textbox", { name: "搜索仓库列表" });
  await input.fill("alpha");
  await expect(input).toHaveValue("alpha");
  expect(
    await input.evaluate((element) => getComputedStyle(element).caretColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
});
test("history tooltip follows the pointer, avoids edges, and clears on leave", async ({
  page,
}) => {
  await open(page);
  const plot = page.getByRole("region", { name: "历史趋势图" });
  await plot.scrollIntoViewIfNeeded();
  const bounds = (await plot.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.3,
    bounds.y + bounds.height * 0.45,
  );
  const tip = page.getByRole("status", { name: "历史快照提示" });
  await expect(tip).toBeVisible();
  const first = (await tip.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.65,
    bounds.y + bounds.height * 0.65,
  );
  await expect
    .poll(async () => Math.abs((await tip.boundingBox())!.x - first.x))
    .toBeGreaterThan(80);
  await page.mouse.move(bounds.x + bounds.width - 18, bounds.y + 30);
  await expect
    .poll(async () => {
      const b = (await tip.boundingBox())!;
      return b.x >= 0 && b.x + b.width <= 1440;
    })
    .toBe(true);
  await page.mouse.move(5, 5);
  await expect(tip).toHaveCount(0);
});
test("routine explanatory text and expanded technical blocks do not occupy the dashboard", async ({
  page,
}) => {
  await open(page);
  for (const text of [
    "工作空间",
    "跨仓库的代码规模、语言构成与历史变化。",
    "个仓库缺少期初",
    "拖动下方手柄缩放",
  ])
    await expect(page.getByText(text, { exact: false })).not.toBeVisible();
  await expect(page.getByRole("table", { name: "快照明细" })).not.toBeVisible();
  await expect(page.getByText("最近运行", { exact: true })).not.toBeVisible();
});

test("a pinned tooltip does not float over unrelated panels after scrolling away", async ({
  page,
}) => {
  await open(page);
  const plot = page.getByRole("region", { name: "历史趋势图" });
  await plot.scrollIntoViewIfNeeded();
  const bounds = (await plot.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width * 0.6,
    bounds.y + bounds.height * 0.5,
  );
  const tooltip = page.getByRole("status", { name: "历史快照提示" });
  await expect(tooltip).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(tooltip).not.toBeVisible();
});
