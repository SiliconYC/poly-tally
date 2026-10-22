# 数据与模块

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `poly_tally/github.py` | 只读 REST 分页发现、当前默认分支 HEAD、有限重试 |
| `poly_tally/git.py` | 独立 bare 缓存、第一父链、Git 树 diff、批量 blob 管道 |
| `poly_tally/rules.py` | 全局路径、语言分类、统计器与规则版本 |
| `poly_tally/metrics.py` | 固定词法器的物理行分类 |
| `poly_tally/engine.py` | 共同前缀复用、增量文件清单、失效后缀撤销、冷数据离线重算 |
| `poly_tally/store.py` | SQLite 仓库状态、解析缓存、运行摘要与一致性备份 |
| `poly_tally/collector.py` | 生命周期状态、范围变更、公开检查点与恢复 |
| `poly_tally/export.py` | 公开字段白名单、静态数据指纹和原子替换 |
| `poly_tally/private_metrics.py` | 私有逐提交事实降为日级规模，保留授权公开的仓库名 |
| `poly_tally/credentials.py` | 显式读取环境令牌或本地 Git credential helper |
| `poly_tally/lock.py` | POSIX 进程锁，支持 macOS / Linux |
| `poly_tally/__main__.py` | 手动和定时任务共用命令入口 |
| `web/model.mjs` | 统一时间轴、筛选、阶梯存量、同源组选择与浏览器数据校验 |
| `web/insights.mjs` | 复用日／周／月可比净变化与 CSV 序列化函数 |
| `web/src/app.tsx` | 数据加载、全局筛选状态、六项概览和各视图组合 |
| `web/src/lib/` | TypeScript 数据契约、展示适配、告警、格式与安全链接 |
| `web/src/components/` | 历史趋势、规模构成、周期变化、仓库列表及 Floating UI 指针浮层 |
| `web/src/components/ui/` | 来自官方 registry 的 shadcn/ui 基础组件与 Chart 容器 |
| `vite.config.ts` | React / Tailwind 构建、路径别名、测试环境与 Pages 基路径 |
| `scripts/build-site.mjs` | 完整输入校验、私有合并、展示窗口、Vite 构建与安全数据输出 |
| `scripts/state.mjs` | 本项目专用 `tally-state` 分支持久化，不接触源仓库 |
| `scripts/metrics.mjs` | 私有公开快照严格校验、范围保护与混合数据合并 |

## 前端状态与迁移边界

页面由 React 与 TypeScript 渲染，使用 Tailwind CSS 和本地 shadcn/ui 组件。`components.json` 采用 `new-york` 风格，基础组件与 Chart 源码取自 shadcn/ui 官方 `new-york-v4` registry；源码随项目维护，不依赖运行时 CDN。图表采用 shadcn/ui Chart 容器和 Recharts，不需要 Tremor。

`App` 统一持有仓库选择、公开／私有范围、当前／档案模式、过期快照开关、语言和指标等全局筛选，并通过 `props` 与回调驱动各视图。历史窗口仅由趋势刷选、日期输入和恢复控件修改。构成图和净变化图没有修改全局筛选或历史窗口的回调，避免普通图表点击引发整页变化。图表内部只保留图例显隐、绝对值／占比、悬停或固定快照、构成维度与排序、净变化指标与周期等局部交互状态；隐藏趋势图层不会改写概览和列表使用的仓库集合。

`web/model.mjs` 的纯数据逻辑和 `web/insights.mjs` 的纯计算导出渐进保留，由 TypeScript 适配层直接调用。React 层不重新实现同源组、未知期初、规则隔离、阶梯延续或 CSV 安全转义。既有 `.mjs` 测试继续保护这些口径，React 测试验证筛选和交互连接。旧原生 DOM / SVG 渲染文件及其实现绑定测试已经删除；交互改由 React 组件测试和真实浏览器测试覆盖，历史版本仍可从 Git 查阅。

## 前端构建与静态数据

Vite 的源码根目录是 `web/`，产物目录是 `site/`，固定 `base: '/poly-tally/'`。开发用 `npm run dev`，生产用 `npm run build` 与 `npm run preview`。`publicDir: false` 关闭公共目录的自动复制；开发服务器仍会直接响应 `web/` 下的源文件，因此开发模式只使用仓库的公开空基线，不把它当作脱敏发布边界。

生产入口 `scripts/build-site.mjs` 先验证公开数据、可选私有快照、显式外部 blob 选择和 retained 基线约束，再合并完整事实并调用 `applyDisplayWindow`。这些检查失败时，已有站点不会被替换。随后真实调用 Vite，只打包入口可达的模块与内容 hash 资源；构建完成后单独写入 `site/data/stats.json`、favicon 和 `.nojekyll`。不发布独立 `private-metrics.json`、retained 文件、测试源码或嵌套预览。

浏览器仅请求 `/poly-tally/data/stats.json`，不访问 GitHub API 或原始私有状态。`npm run dev` 不执行上述合并与窗口处理；需要检查实际发布结果时，应在 `/tmp/` 暂存完整测试工作目录与快照，执行同一生产构建并预览。真实数据与临时产物不提交到 `dev`，源仓库保留 pending 基线。

## 版本与缓存

仓库以 GitHub 稳定 ID 建账，位置改名不新建账目。默认分支改变会完整重建当前生效历史；同一分支的 HEAD 变化按 SHA 链找共同前缀，后缀整体替换。Git 时间只用于展示，不能判定祖先关系。

解析缓存键为 `blob ID + 语言上下文 + 统计器/Pygments 版本 + 文件大小上限`。纳入路径规则在缓存之前判断，故同内容改名或进入排除目录不会错误复用旧分类。每提交记录语言汇总，最新文件清单支持后续树差分；解析事实缓存可跨仓库复用。

CLI 将派生状态放入 `epochs/<批次>/stats.sqlite`，原始对象与解析事实放入独立 `cache/<public|private>/`。新批次重建派生历史，原始对象不随统计口径失效；解析事实仅在其完整缓存键匹配时复用。共享缓存与派生状态分别持有运行锁。`backup` 只保存派生数据库，缓存应单独备份。

本轮授权元数据及默认分支 HEAD 均验证后，HEAD、分支、规则和完整性不变的仓库直接复用历史，跳过 Git fetch。其余仓库增量传输 Git pack，再从共同前缀继续计算。`--report` 保存本地逐仓库测量；公开 `runs` 只包含公开范围的计数与阶段数据。

规则实例在构造时固定版本并编译路径匹配组；构造后不要原地修改其配置，变更规则必须新建
`规则_类` 实例。连接器导入按 `(tree SHA, 完整路径前缀)` 复用验证，并通过 Merkle 子树
差分避免每提交展开全树；仍校验所有唯一原始树，包括路径排除的目录。复杂度下界、
冷/暖缓存边界及可复现基准见 [历史重建性能](history-rebuild-compute.md)。

## 公开 JSON 协议

`schemaVersion` 当前为 `1`。

- `generatedAt`：产物生成时间，ISO UTC。
- `rules`：`version` 与统一口径 `description`。
- `collector.version`：统计器及 Pygments 版本。
- `summary`：当前同口径活动仓库的最新总量，含 `repositories`、`commits` 与行指标。
- `repositories`：公开仓库记录数组。
- `runs`：仅公开范围的最近运行摘要，含耗时、失败数、解析数、读取数、缓存命中和重算提交数。

仓库记录含 `id`、`name`、`url`、`branch`、`head`、`status`、`lastSuccessAt`、`rulesVersion`、`historyComplete`、`notice`、`skippedFiles`、`history`。浏览器 JSON 没有文件路径清单、提交消息或作者身份。

`history` 中每个快照含 `sha`、`timestamp`、`committedAt`、`authoredAt`、`metrics` 和 `languages`。`metrics` 为 `{code, comment, blank, documentation, files}`，`languages` 按语言名映射至同形指标。

上述提交字段只适用于公开仓库。私有记录使用 `visibility: private`、`snapshotKind: daily` 和稳定标识，`name` 按用户要求保留真实仓库名，`url` / `branch` / `head` 为 `null`；其 `history` 只有 `timestamp`、`metrics`、`languages`。`publication` 单独保存私有采集时间、来源与可用状态。私有快照包的字段白名单与合并逻辑由 `scripts/metrics.mjs` 校验，兼容旧匿名显示名，但不能把完整私有状态当作快照包上传。

浏览器对各仓库按归一化时点进行阶梯合并，某仓库第一条快照之前为未知，不贡献已知存量面积；其后保持最后已知状态。某一仓库的同刻提交以拓扑中最后一个为准；所有仓库同刻更新后再输出一个观察点。

## 故障边界

- 发现分页任何一页失败，整轮发现不冒充完整列表，不根据部分结果判定删除。
- 每仓库历史和最新文件清单一起保存；解析事实是不可变缓存，中断留下缓存不改变生效历史。
- 公开检查点先全量验证，再事务导入。Actions 强制权威检查点覆盖缓存；手动导入默认只补缺失仓库。
- JSON 在同目录生成临时文件并 `fsync` 后 `os.replace`，读者只能看到完整旧版或新版。
- 部分仓库失败仍可发布保留的完整快照，但明确展示过期/不可访问和运行失败数。
- 当前首版不支持 Windows 原生采集；可以使用 WSL，静态前端不受影响。
