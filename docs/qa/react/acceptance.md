# React 前端迁移验收

验收日期：2026-10-22，环境为 macOS arm64、Node.js 22.20.0、Chrome 156。使用真实浏览器运行生产产物，基路径为 `/poly-tally/`。

## 交付架构

- 唯一入口为 `web/src/main.tsx`，页面由 React 与 TypeScript 组件声明式渲染。
- 基础组件来自 shadcn/ui 官方 `new-york-v4` registry，保留 MIT 许可；使用 Card、Button、Select、Popover、Checkbox、Switch、Tabs、Table、Input、Badge、Skeleton、Tooltip 和 Sonner。
- Tailwind CSS 管理布局、响应式和浅深色设计变量，Recharts 配合 shadcn/ui Chart 绘制面积、环形和柱图，Lucide 提供图标，TanStack Table 提供多字段排序与分页。
- 不引入 Tremor，已有组件和图表已满足需求。三个图表通过动态导入共享图表依赖，主入口约 428 kB，gzip 约 132 kB；最大图表共享块约 309 kB，gzip 约 93 kB。
- `web/model.mjs` 完整保留；`web/insights.mjs` 仅移除旧渲染器，统计和 CSV 函数语义保持一致。旧原生 DOM 渲染器、自绘图表、CSS 和依赖其结构的测试已删除。

设计参考：[dashboard-01](https://ui.shadcn.com/blocks)、[Vite 安装](https://ui.shadcn.com/docs/installation/vite)、[Chart 组件](https://ui.shadcn.com/docs/components/chart)。

## 自动化与浏览器覆盖

| 验证项 | 实际覆盖 |
| --- | --- |
| 类型检查 | 前端、Vite、Playwright 配置、浏览器测试和性能脚本，启用严格及未使用变量检查 |
| React 单元测试（24 项通过） | 全局状态、六指标、范围、重置、搜索、失败重试、空数据、同源与不完整运行提示、图例、键盘、未知、百分比、日期、排序、复制隔离、零与未知变化、绘图记忆化 |
| 既有 Node 回归及构建（110 项通过） | 时间轴对齐、同刻覆盖、下降、未知期初、展示边界、历史排序、规则隔离、私有合并与来源验证、CSV 安全、状态持久化 |
| Vite 集成 | 真正打包 React fixture、内容 hash、动态资源、清理旧产物、子路径 HTTP 请求、仅发布安全数据和可达资源 |
| Python 回归 | 198 项测试、148 项子测试通过，采集与分类后端未修改 |
| 浏览器（11 项通过） | 11 个场景，含 1440px / 390px、深浅模式及持久化、真实数据、筛选搜索、图例、键盘、真实 Brush 拖动和恢复、构成、指标周期、CSV 文件、剪贴板、分页多排序、空数据、HTTP 失败重试、无效数值、过期与旧规则隔离、档案 |

旧测试中依赖手写 SVG 路径、手动 DOM 钩子、像素几何和 CSS 字符串的断言，已由 React 组件行为及生产浏览器行为验证取代；纯模型断言继续运行。额外回归覆盖展示起点的净变化基线、旧规则过期快照的实际纳入数，以及快照浏览不触发两棵 Recharts 树重新提交。

## 真实数据核对

从已发布的 `https://siliconyc.github.io/poly-tally/data/stats.json` 下载公开数据，生成时间为 `2026-10-22T02:28:43.371789Z`，包含 27 个仓库、665 条快照。按原模型默认范围纳入 26 个仓库。

生产页面的数据请求由 Playwright 重放该公开响应，其他资源从实际 Vite 产物加载；未改写源数据、发布输入或私有采集状态，也没有把真实数据文件提交到代码分支。六项结果逐一与原 `selectRepositories` / `latestTotals` 输出比对：

| 指标 | 一致结果 |
| --- | ---: |
| 总行数 | 1,421,016 |
| 代码行 | 829,740 |
| 注释行 | 213,943 |
| 文档行 | 147,096 |
| 空行 | 230,237 |
| 文件数 | 12,405 |

截图：[桌面浅色](1440-light.png)、[桌面深色](1440-dark.png)、[手机浅色](390-light.png)、[手机深色](390-dark.png)。四种布局均检查页面无横向溢出；宽表格在局部容器内横向滚动。

## 性能

完整可复核记录见 `performance.json` 与 `browser-performance.json`。包含两个独立规模：

- 20 个仓库、10,000 条互不同时的变化快照，保留全部 10,000 个绘图时点，不做抽样。
- 40 个仓库、100,000 条快照，只移除各仓库存量完全相同的连续中间绘图点，得到 1,001 个时点；每个变化、未知转换、首尾均保留，原始快照继续用于明细与键盘选择。

在此机器上，两种规模的首屏约 2.3 秒和 1.6 秒；键盘选快照约 51ms 和 83ms。数据变更导致的百分比重算约 1.5 秒和 0.37 秒。主图与导航单独记忆化，hover 与键盘只更新 HTML 浮层和快照明细；组件 Profiler 回归验证这两棵 Recharts 树不因快照浏览重新提交。

这是真实机器的合成压力测试，不是所有设备的响应承诺。不同仓库的每次存量都变化时保留完整阶梯，百分比转换和首次绘制仍比悬停操作更昂贵。

## 复现

```bash
npm ci
npm run typecheck
npm test
npm run test:legacy
.venv/bin/python -m pytest -q
npm run build
npm run bench
POLY_TALLY_REAL_STATS=/tmp/poly-real-stats.json npm run test:e2e
```

本地浏览器配置使用已安装的 Chrome；CI 使用 Playwright Chromium，先运行 `npx playwright install --with-deps chromium`。未提供 `POLY_TALLY_REAL_STATS` 时只跳过真实数据核对，其余功能和性能场景继续执行。Pages 工作流已接入类型、React、Node、Python 与生产浏览器检查。
