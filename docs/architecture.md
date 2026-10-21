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
| `web/model.mjs` | 统一时间轴、过滤与浏览器数据校验 |
| `web/app.mjs` | 全局筛选、概览卡片与仓库表交互 |
| `web/stacked-chart.mjs` | 按仓库堆叠面积、图例、快照明细与时间刷选 |
| `web/language-chart.mjs` | 语言环形饼图与可筛选明细 |
| `web/insights.mjs` | 可比仓库月度净变化与列表 CSV 导出 |
| `web/chart-utils.mjs` | 图表 DOM、格式与配色 |
| `scripts/state.mjs` | 本项目专用 `tally-state` 分支持久化，不接触源仓库 |
| `scripts/metrics.mjs` | 私有公开快照严格校验、范围保护与混合数据合并 |

## 版本与缓存

仓库以 GitHub 稳定 ID 建账，位置改名不新建账目。默认分支改变会完整重建当前生效历史；同一分支的 HEAD 变化按 SHA 链找共同前缀，后缀整体替换。Git 时间只用于展示，不能判定祖先关系。

解析缓存键为 `blob ID + 语言上下文 + 统计器/Pygments 版本 + 文件大小上限`。纳入路径规则在缓存之前判断，故同内容改名或进入排除目录不会错误复用旧分类。每提交记录语言汇总，最新文件清单支持后续树差分；解析事实缓存可跨仓库复用。

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
