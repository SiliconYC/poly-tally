# poly-tally

跨仓库的代码规模观察站。独立、只读地从 Git 历史重建代码存量，再把静态数据发布到 GitHub Pages。

收录了所有未被 `archived` 的 Public 和 Private 仓库。私有仓库的源码不公开，但仓库名称与代码规模必须在页面中显示；更新失败或历史重算不得导致已有私有仓库从页面消失。

**在线页面：[代码观察站](https://siliconyc.github.io/poly-tally/)**

[工程约定 Discussion #1](https://github.com/SiliconYC/poly-tally/discussions/1) · [实施与验收 Issue #2](https://github.com/SiliconYC/poly-tally/issues/2) · [采集和部署](https://github.com/SiliconYC/poly-tally/actions/workflows/pages.yml)

私有规模支持按用户授权显示真实仓库名与日级规模，源码和 Git 提交细节不公开。活动统计以 `tally-state` 的完整采集及实际 Pages 发布为准；本地 Native Git 支持持久缓存和增量更新。已有授权与可选云端配置见 [私有采集说明](docs/private-collection.md)。

下载依赖、构建产物、日志和调试输出使用统一规则排除，修改规则会重算历史。识别依据、保留边界和修改方法见 [收录与屏蔽规则](docs/content-policy.md)。

`Eigen` 目录在所有仓库、所有历史提交中统一排除。已有本地对象和仓库记录时，可运行 `rebuild --from-state` 完全离线纠偏；操作步骤与缓存边界见 [离线历史重算](docs/offline-rebuild.md)。

## 解决什么问题

- 只配置账号或组织范围，分页发现符合统一规则的仓库，每轮重新读取当前默认分支。
- 新仓库完整回填历史，不把已有代码量全部记作发现当天新增。
- 修改排除、分类规则后重算历史；切换默认分支、回退或重写历史后撤销失效快照。
- 各仓库独立采集，以历史时点的最后一个提交树汇总，无需同时扫描多个目录。
- 页面提供按仓库堆叠的交互面积图、语言与仓库构成环形图、六项分类概览和日／周／月净变化；支持时间刷选、仓库与语言筛选，以及列表搜索、排序、名称复制和 CSV 导出。

这里统计的是排除可识别依赖与产物后的代码存量；不推断所有源码的作者，不是累计新增量或生产力评分。跨仓库相同源码不自动去重，真实批量导入仍会产生跃升。

## 当前运行方式

`config.json` 发现 `SiliconYC` 名下授权可见的全部非 fork 仓库，包括私有仓库；普通 GitHub Archived 仓库不统计；显式同源组成员例外。空仓库须经可读分支列表确认。GitHub Actions 每天北京时间 **09:17、21:17** 运行，也可以在 Actions 页面手动运行；GitHub 的定时触发可能延迟。推送 `dev` 会自动验证、采集并发布。

页面可按全部、公开、私有范围筛选。公开仓库保留逐提交统计；私有仓库展示真实名称、日级规模及独立更新时间。浏览器不连接 GitHub API、不持有令牌。

私有统计可以使用已有授权 connector 或本机 Git 凭证重新计算，不要求新建 Key。外部计算完成后，可显式填写 `external_private_blob_sha` 发布经过精确字节及当前契约验证的脱敏结果。可选的 `POLY_TALLY_READ_TOKEN` Secret 仅用于显式启用的受保护持久 runner 采集。未完成新鲜核对时，保留已有私有统计并显示未刷新状态；不删除私有仓库，也不把原采集时间改成现在。

普通采集是确定性程序，无需 AI 参与决策。网络失败、限流或权限撤回会保留上次成功结果并标记状态；真正需要人工处理时检查 Actions 日志或本地运行摘要即可。

2026-10-22 已完成本机空缓存全量实测：29/29 个源仓库，完整采集约 9 分钟，保留对象与事实后的全历史重算约 39 秒。后续使用 `node scripts/update-local.mjs` 增量采集并发布，详见 [性能记录与更新方法](docs/native-history-performance.md)。

## 历史显示起点

`config.json` 的 `display.historyStart` 控制全部统计的最早显示时间，当前设为 `2025-01-17T00:00:00+08:00`，即北京时间 2025 年 1 月 17 日 00:00（UTC 为 1 月 16 日 16:00）。配置必须包含时区，避免不同运行环境解释为不同瞬间；图表日期标注仍使用 UTC。

此配置只作用于网页构建，不参与采集规则、`datasetEpoch` 或缓存键。完整历史仍保留在本地及 `tally-state`，站点构建读取原始输入后生成展示范围。起点前最后一次已知存量会延续到起点，不丢弃此前积累的代码；起点前的时间点不进入图表、周期净变化、历史面积排序或可见快照计数。没有起点前观测的仓库仍保持期初未知，不用零值假造新增。边界显示点不是新提交，仓库真实更新时间不变。

修改该值后重新构建、发布网页即可，不需要重新采集或重算历史。改为更早的日期也能从完整输入恢复对应显示；删除 `display.historyStart` 可恢复不限制起点的展示。本地已安装前端依赖，并备有完整公开统计和脱敏私有快照时，运行 `npm run build`；GitHub Pages 正常发布流程会自动读取配置。可见快照计数包含为延续存量生成的边界显示点，运行日志中的实际解析/提交计数保持原义。

## 快速运行

需要 Python 3.12+、Git 和 Node.js 22.12+。前端使用 React、TypeScript、Vite 和 Tailwind CSS；界面基于本地 shadcn/ui 组件，图表使用 shadcn/ui Chart 与 Recharts。

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps -e .
npm ci
python -m pytest -q
npm run typecheck
npm test
npm run test:legacy
npm run build
npm run preview -- --port 4187
```

打开本地 `http://127.0.0.1:4187/poly-tally/`。`npm run build` 先验证并合并公开统计与可选脱敏私有快照，再裁剪展示窗口、运行 Vite，并写入 `site/data/stats.json`。构建结果只含静态资源和可发布数据，不复制源文件或独立私有快照。

仅开发界面时运行 `npm run dev`，打开终端提示地址下的 `/poly-tally/`。开发服务器从 `web/` 提供源码和现有 `web/data/stats.json`，不会执行私有合并或展示窗口构建；仓库保留空 pending 基线，便于检查加载与空态。真实数据验收应把完整测试工作目录和快照暂存在 `/tmp/`，使用同一构建入口生成临时站点，随后预览；不要将实际统计替换并提交到 `dev` 的基线。

需要采集公开数据时运行 `python -m poly_tally collect --public-only`，默认更新 `web/data/stats.json`。首次回填可能较慢；后续运行复用 blob 解析与历史前缀。本轮授权元数据确认 HEAD、分支、规则不变时，Git fetch、文件解析、对象读取和重算提交数均为零。

运行摘要包含 `parsedBlobs`、`objectReads`、`cacheHits`、`recomputedCommits`、`skippedBlobs`、失败仓库数与耗时。部分失败默认返回非零退出码，同时导出完整的最后成功版本；`--allow-partial` 允许带明确失败状态发布。

## 授权范围与统一规则

修改 `config.json`：

- `owners`：账号或组织名称列表，自动判断类型并分页发现，不逐仓库登记。
- `repositories.include` / `repositories.exclude`：仓库全名的通配符；排除优先。
- `rules.include_forks`：默认 `false`。设置为 `true` 时，fork 的代码也会进入总量。
- `rules.include` / `rules.exclude`：仓库根目录相对路径通配符；`**/` 也匹配根目录。排除优先。
- `rules.artifact_exclude` / `rules.source_preserve`：对有歧义的日志、报告和结果命名执行产物过滤，同时保护源码、测试和 README 上下文；不能覆盖 `rules.exclude` 的明确排除。具体模式和边界见收录规则。
- `rules.languages`：全局扩展名映射，例如 `{ ".custom": "Markdown" }`。支持的语言在 `poly_tally/rules.py` 中列出。
- `rules.max_blob_bytes`：单文件最大字节数，默认 `2000000`，超出排除。

所有仓库使用相同规则。规则摘要包含分类表、配置、统计器及 Pygments 版本；修改后下一次采集自动重算可获得的全部历史。扫描程序自身语义变化时必须提升 `规则_类.统计器版本`，避免复用旧口径缓存。

### 行数口径

| 内容 | 处理 |
| --- | --- |
| 程序、脚本及未被排除的文本类别 | 按固定版本 Pygments 词法器分为代码、注释、空行 |
| JSON、JSONC、YAML/YML、XML（含 SVG 与等价映射类别） | 全局硬排除，大小写不敏感；不读 blob、不计行、不计文件；源码保护与 include 不能救回 |
| 混合代码与注释的物理行 | 归代码行，只计一次 |
| Python docstring | 归注释行 |
| Markdown、MDX、RST、TXT、TeX | 非空行归文档，空行单列；Entrepi Markdown 完全相同 |
| 未知扩展名、非 UTF-8 文本、含 NUL 的文件 | 排除 |
| 依赖目录、构建目录、lock 文件、压缩 JS/CSS、source map | 按全局路径规则排除 |
| Git LFS 指针、symlink、submodule | 排除；不下载 LFS，不递归 submodule |
| 日志、缓存、实验结果与调试报告 | 按统一路径规则排除，包括已跟踪进历史的文件 |
| 移出常规目录的下载 / 生成内容 | 使用明确生成器头、React 分发头、Sphinx 导航多重特征或重复运行日志识别；具体边界见收录规则 |
| Cython | 统计 `.pyx` / `.pxd` / `.pxi`，排除带生成头的 C 输出 |
| JSON 配置、静态注册、关卡与测试 fixture | 同样硬排除，没有内容识别例外；生成/处理它们的源码仍按原规则统计 |

词法统计不是编译器解析。Svelte 使用 HTML 词法器，解析嵌入的 script/style；特殊语法、模板与非法源文件存在词法器近似。空文件计一个文件、零行；末尾换行不会额外增加空行。`skippedBlobs` 表示本轮遇到的二进制、编码不支持、LFS 或超大 blob 次数，不是未知扩展名文件总数。

## 私有计算与凭证

优先复用已有授权；授权 connector 对象可经 `scripts/import-connector-bundle.py` 验证后使用同一统计引擎，无需新 Key。外部快照精确 SHA 发布见 [私有采集说明](docs/private-collection.md#显式发布外部完成的私有快照)。如另行获准使用令牌，也支持环境变量 `POLY_TALLY_TOKEN`；不要把令牌写入配置、URL、源码或 shell 历史。

```bash
read -rs POLY_TALLY_TOKEN
export POLY_TALLY_TOKEN
python -m poly_tally collect --state /安全目录/poly-tally-state
unset POLY_TALLY_TOKEN
```

省略 `--public-only` 时，必须有可用凭证；在公开列表之外补全令牌可见的私有仓库，并按指定 `owners` 过滤。默认导出仍排除私有记录，追加 `--include-private-metrics` 才公开仓库名称与日级规模。文件路径、SHA、原始提交时间和源码不会进入私有公开数据。完整 SQLite、bare 对象缓存与备份需要放在受保护目录。

可复用本机已配置的 Git credential helper，不需要复制令牌到文件：

```bash
python -m poly_tally collect --git-credential --include-private-metrics --private-metrics-output .poly-tally/private-metrics.json --output .poly-tally/combined-stats.json --refresh
```

Actions 的 Pages 工作流只采集公开范围，不等待私有重建。私有范围使用本地持久状态，或显式启用 `private-local.yml` 的专用 self-hosted runner。私有原始对象和 SQLite 不进入公开 Actions cache/artifact，只有验证后的日级规模可上传。独立持久化作业才拥有 `contents: write`，只写本项目 `tally-state`；部署作业只有 Pages 和 OIDC 权限。不会向源仓库写入。

## 本次全量重算批次与同源组

当前批次为 `source-only-no-eigen-2026-10-22-v1`，配置和工作流一致。JSON/JSONC/YAML/YML/XML 整类及 Eigen 依赖目录不再纳入。私有历史已从缓存按新规则重算，原始源码不公开。明确配置 `vitro → vitro_zero_lab → vitro_union_lab` 为一个统计项；代表名取成员默认分支最新实际提交者，逐时刻只取唯一主导仓库全部指标。挑战者须严格超过当前主导的历史最大代码行才切换，缩减不追随当前最大者，高点跨回切保留。

`vitro_union_260204_obsoleted` 是普通已归档仓库，不统计；`vitro_agent_foundry` 是独立文档副仓库，不属于继承链。配置组成员即使以后归档仍须扫描。

新 epoch 不直接导入旧批次的历史汇总。CLI 将原始对象与按内容/解析版本索引的事实保存在独立 `cache/<public|private>/`，可跨批次复用；规则或同源关系变化仍从零计算派生历史。完整离线重算可作为同批次的 `rebuilt-private-metrics.json` 展示，保留原采集时间并标记未刷新；它不是一次新的成功采集。只有完整的新鲜核对才能发布 fresh。自动发现只证实凭据可见范围，可通过 `--expected-inventory` 检测范围缺失。

精确同刻/平局/空值/分支重算规则、JSON 配置、混合公私隐私边界、CLI 重算与 API 见 [同源组与严格重算](docs/lineage.md)。

## 持久化、恢复与冷数据

默认状态目录 `.poly-tally/` 已被 Git 忽略。

- `epochs/<批次>/stats.sqlite`：仓库状态、当前生效历史、文件指标清单和最近运行摘要。
- `cache/<public|private>/parser.sqlite`：按内容、语言、统计器版本和大小上限索引的解析事实。
- `cache/<public|private>/objects/<仓库 ID>.git`：独立 bare 对象缓存；所有 fetch 发生在这里，不修改用户工作区。
- `--cache <根目录>` 可指定长期缓存位置，CLI 自动附加范围目录；不同批次共享同一缓存运行锁。
- `run.lock`：操作系统文件锁，阻止同一目录并发运行；崩溃自动释放。
- `web/data/stats.json`：公开字段白名单，完整生成后原子替换。

SQLite 使用事务；每仓库重建成功后才替换旧历史。检查点导入先完整校验，再用一个事务写入。公开 JSON 原子切换。进程中断后直接重新运行，无需清空状态。

```bash
python -m poly_tally backup --backup /安全目录/poly-tally.sqlite
python -m poly_tally restore --backup /安全目录/poly-tally.sqlite
python -m poly_tally export --refresh
```

SQLite backup 保存派生统计。还需在停止采集后单独备份 `cache/`（含解析事实和 Git 对象），才能保证已删除仓库未来离线重算。只恢复派生统计也能继续检查 HEAD；对象缺失时，有新提交的活动仓库可重新 fetch。旧 API 未指定独立缓存时，仍使用状态目录内的旧布局。

列表缺失、403/404、超时不等于已删除。只有明确确认删除或决定永久停止跟踪后，才执行：

```bash
python -m poly_tally retire 123456789
python -m poly_tally resume 123456789
python -m poly_tally collect --public-only
```

`retire` 保留全部历史并标为冷数据，不再抓取新提交，但仍读取可用元数据以更新名称和公开状态；`resume` 恢复发现与同步。冷数据不计入当前活动总量，可以在历史档案查看。规则变化后若保有对象会离线重算；若对象丢失则保留原规则版本，界面隔离旧口径，不伪装成统一总量。

Actions cache 只用于公开计算加速，不能保证永久存在。`tally-state/checkpoint.json` 保存公开仓库的完整统计检查点；同分支的 `private-metrics.json` 保存私有仓库名与日级规模，不保存私有源码、路径、blob 或 commit ID。每轮只恢复同一 `datasetEpoch` 的持久数据再扫描，旧批次和旧缓存不能复活失效历史。无规模、口径或状态变化时不生成数据提交。请勿删除该数据分支。

```bash
python -m poly_tally checkpoint --public-only --checkpoint /备份目录/checkpoint.json
python -m poly_tally collect --public-only --import-checkpoint /备份目录/checkpoint.json
```

默认导入只补齐缺失仓库；以检查点覆盖已有公开状态时追加 `--authoritative-checkpoint`。该选项撤下检查点已不存在的旧公开记录，但不覆盖本地已知私有状态。完整私有状态应使用 SQLite 备份；CLI 检查点始终过滤私有完整记录，私有规模通过独立脱敏文件发布。

仓库转私有后停止公开 Git 详情，只按显式授权发布名称与日级规模，旧公开缓存不能冒充新的私有提交。此前已公开的统计可能仍在数据分支历史中；该分支不新增私有源码或私有提交详情。私有转公开按稳定键去重，不会重复加总。

## 历史含义与异常状态

计算快照沿当前默认分支第一父链排列，合并统计结果树，不把父分支相加。计算轴使用 UTC committer 时间的累计最大值。公开仓库保留原始 `committedAt` / `authoredAt`；私有发布先按日归并并去掉全部提交标识和原始时间。同刻最后一个有效快照覆盖，跨仓库一起汇总。

这是“按当前默认分支和当前规则重建的历史”，不声称还原过去真实默认分支、未提交工作区或缺失的 Git 对象。真实首次导入代码、合并等跳升会保留。仓库范围和规则变化导致的是历史曲线重建，不是今天的代码增长。

| 状态 | 含义 |
| --- | --- |
| `active` | 当前口径成功快照，进入默认总量 |
| `archived` | GitHub 已归档，不抓取源码、不展示、不计入任何统计；内部仅留排除证据 |
| `empty` | 等待首个提交，不计入代码仓库总数 |
| `inaccessible` | 本轮不可访问，保留上次历史，默认不计入当前总量 |
| `stale` | 分支或规则改变后重建失败，旧版本明确标为过期 |
| `excluded` | 移出授权或规则范围，保留历史但不汇总 |
| `cold` | 人工确认删除或停止跟踪，永久保留历史档案 |

可勾选查看同口径过期快照；不同规则版本始终隔离，不能混加。

## GitHub Pages 部署

仓库设置的 Pages 发布来源为 **GitHub Actions**，默认开发分支为 `dev`。仓库公开本身不会自动部署页面。

`.github/workflows/pages.yml` 先安装锁定的 Python 与 npm 依赖，执行类型检查、React 测试及原有 Python / Node 测试，再恢复状态、采集、安全合并数据、构建、保存公开检查点并部署 `site/`。Vite 固定使用 `/poly-tally/` 项目路径，资源带内容 hash；前端没有运行时 CDN 依赖。`publicDir: false` 禁止整目录复制公开资源，最终数据由 `scripts/build-site.mjs` 在校验后单独写入。

正式发布必须带有私有统计。若当前批次既没有完整私有快照，也没有经过范围校验的离线重算快照，构建失败并保留已上线页面，禁止发布只有 Public 仓库的替代页面。离线重算快照通过 `node scripts/state.mjs save-rebuilt-private <文件> --git-credential` 单独保存，验证不得缩减原有私有范围；后续完整采集成功后自动使用更新结果。`dev` 保存代码，`tally-state` 保存公开检查点及脱敏私有统计，无需反复向 `dev` 提交统计。

## 验收复现

```bash
python -m pytest -q
npm ci
npm run typecheck
npm test
npm run test:legacy
python -m poly_tally collect --public-only
python -m poly_tally collect --public-only
npm run build
npm run preview -- --port 4187
```

第二次无变化采集应报告 `parsedBlobs=0`、`objectReads=0`、`recomputedCommits=0`。真实 Git fixture 覆盖新增、修改、删除、改名、合并、revert、分支切换/改名、祖先回退、分叉和无公共历史、倒序时间、规则重算与冷数据离线重算。发现与运维测试覆盖分页、组织/私有范围、身份稳定、限流、权限故障、事务恢复、公开隐私和锁；Node 测试覆盖三仓库时间对齐、同刻覆盖、筛选、旧规则隔离与空态。

浏览器测试入口为 `npm run test:e2e`，性能测量入口为 `npm run bench`；运行前按对应测试配置准备浏览器和数据，实际结果以当次输出为准。真实数据测试仍在 `/tmp/` 临时工作目录进行，不提交实际统计。

实现边界与数据协议见 [数据与模块](docs/architecture.md)。两个 Qt 参考项目的功能分析、React 迁移取舍和新版图表操作见 [仪表盘升级说明](docs/dashboard-upgrade.md)。

### Cloudflare 免费密钥代理（代码准备，生产验收待完成）

可选 `node scripts/update-local.mjs --gateway` 保持本地 Python / 原生 Git 统计，
由固定 SiliconYC 只读代理及脱敏快照发布代理隔离 GitHub PAT。Dot 只使用独立代理口令；
真实 Secrets 仅由所有者安全输入 Cloudflare。大 Git pack 流式传输，小快照有 1 MiB 硬上限，
不会恢复已暂停定时任务。部署、最小权限、代理口令文件、缓存/CPU验收和限制见
[操作说明](docs/operations/cloudflare-gateway.md)。
真实 bootstrap 运行数据不进入源码：部署前显式生成至 gitignored 的
`workers/gateway/.local/`，缺失即停止生产构建；所有单元和 workerd 测试只用合成数据。
