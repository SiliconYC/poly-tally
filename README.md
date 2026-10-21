# poly-tally

跨仓库的代码规模观察站。独立、只读地从 Git 历史重建代码存量，再把静态数据发布到 GitHub Pages。

**在线页面：[代码观察站](https://siliconyc.github.io/poly-tally/)**

[工程约定 Discussion #1](https://github.com/SiliconYC/poly-tally/discussions/1) · [实施与验收 Issue #2](https://github.com/SiliconYC/poly-tally/issues/2) · [采集和部署](https://github.com/SiliconYC/poly-tally/actions/workflows/pages.yml)

私有仓库现已纳入：按用户要求显示真实仓库名与日级规模，源码和 Git 提交细节仍不公开。操作与只读 Secret 配置见 [私有采集说明](docs/private-collection.md)。

下载依赖、构建产物、日志和调试输出使用统一规则排除，修改规则会重算历史。识别依据、保留边界和修改方法见 [收录与屏蔽规则](docs/content-policy.md)。

## 解决什么问题

- 只配置账号或组织范围，分页发现符合统一规则的仓库，每轮重新读取当前默认分支。
- 新仓库完整回填历史，不把已有代码量全部记作发现当天新增。
- 修改排除、分类规则后重算历史；切换默认分支、回退或重写历史后撤销失效快照。
- 各仓库独立采集，以历史时点的最后一个提交树汇总，无需同时扫描多个目录。
- 页面支持仓库、语言、指标和时间筛选；显示默认分支、HEAD、口径版本、数据状态与扫描时间。

这里统计的是排除可识别依赖与产物后的代码存量；不推断所有源码的作者，不是累计新增量或生产力评分。跨仓库相同源码不自动去重，真实批量导入仍会产生跃升。

## 当前运行方式

`config.json` 发现 `SiliconYC` 名下授权可见的全部非 fork 仓库，包括私有仓库；归档仓库仍纳入，空仓库等待首次提交。GitHub Actions 每天北京时间 **09:17、21:17** 运行，也可以在 Actions 页面手动运行；GitHub 的定时触发可能延迟。推送 `dev` 会自动验证、采集并发布。

页面可按全部、公开、私有范围筛选。公开仓库保留逐提交统计；私有仓库展示真实名称、日级规模及独立更新时间。浏览器不连接 GitHub API、不持有令牌。

私有统计可以在本地使用现有 Git 凭证增量更新。配置 `POLY_TALLY_READ_TOKEN` 只读 Actions Secret 后，私有仓库也会自动采集；未配置时保留最近收到的脱敏私有快照，公开采集不会覆盖或伪装刷新私有数据。

普通采集是确定性程序，无需 AI 参与决策。网络失败、限流或权限撤回会保留上次成功结果并标记状态；真正需要人工处理时检查 Actions 日志或本地运行摘要即可。

## 快速运行

需要 Python 3.12+、Git 和 Node.js 22+。Node.js 用于测试与打包静态文件，无需 npm 依赖。

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps -e .
python -m pytest -q
node --test web/*.test.mjs
node --test scripts/*.test.mjs
python -m poly_tally collect --public-only
node scripts/build-site.mjs
python -m http.server 4187 --bind 127.0.0.1 --directory site
```

打开本地 `http://127.0.0.1:4187/`。首次回填可能较慢；后续运行复用 blob 解析与历史前缀。HEAD、分支、规则不变时，文件解析数、对象读取数和重算提交数均为零。

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
| 程序、脚本、配置、JSON、YAML、XML、SVG | 按固定版本 Pygments 词法器分为代码、注释、空行 |
| 混合代码与注释的物理行 | 归代码行，只计一次 |
| Python docstring | 归注释行 |
| Markdown、MDX、RST、TXT、TeX | 非空行归文档，空行单列；Entrepi Markdown 完全相同 |
| 未知扩展名、非 UTF-8 文本、含 NUL 的文件 | 排除 |
| 依赖目录、构建目录、lock 文件、压缩 JS/CSS、source map | 按全局路径规则排除 |
| Git LFS 指针、symlink、submodule | 排除；不下载 LFS，不递归 submodule |
| 日志、缓存、实验结果与调试报告 | 按统一路径规则排除，包括已跟踪进历史的文件 |
| 移出常规目录的下载 / 生成内容 | 使用明确生成器头、React 分发头、Sphinx 导航多重特征或重复运行日志识别；具体边界见收录规则 |
| Cython | 统计 `.pyx` / `.pxd` / `.pxi`，排除带生成头的 C 输出 |
| 三维网格、烘焙动画、绑定导出的 JSON 载荷 | 按完整数据结构识别为资产，排除；普通关卡、配置与资产生成脚本仍统计 |

词法统计不是编译器解析。Svelte 使用 HTML 词法器，解析嵌入的 script/style；特殊语法、模板与非法源文件存在词法器近似。空文件计一个文件、零行；末尾换行不会额外增加空行。`skippedBlobs` 表示本轮遇到的二进制、编码不支持、LFS 或超大 blob 次数，不是未知扩展名文件总数。

## 私有计算与凭证

可设置环境变量 `POLY_TALLY_TOKEN`。本地令牌只需要目标源仓库的 Metadata / Contents 读取权限；不要把令牌写入配置、URL、源码或 shell 历史。

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

Actions 将公开与私有计算分开。公开作业使用本仓库 `contents: read` 与公开缓存；可选私有作业使用专用只读 Secret，原始对象和 SQLite 不缓存或上传，只有验证后的日级规模可进入产物。独立持久化作业才拥有 `contents: write`，只写本项目 `tally-state`；部署作业只有 Pages 和 OIDC 权限。不会向源仓库写入。

## 持久化、恢复与冷数据

默认状态目录 `.poly-tally/` 已被 Git 忽略。

- `stats.sqlite`：仓库状态、当前生效历史、文件指标清单、blob 解析缓存、最近运行摘要。
- `objects/<仓库 ID>.git`：独立 bare 对象缓存；所有 fetch 发生在这里，不修改用户工作区。
- `run.lock`：操作系统文件锁，阻止同一目录并发运行；崩溃自动释放。
- `web/data/stats.json`：公开字段白名单，完整生成后原子替换。

SQLite 使用事务；每仓库重建成功后才替换旧历史。检查点导入先完整校验，再用一个事务写入。公开 JSON 原子切换。进程中断后直接重新运行，无需清空状态。

```bash
python -m poly_tally backup --backup /安全目录/poly-tally.sqlite
python -m poly_tally restore --backup /安全目录/poly-tally.sqlite
python -m poly_tally export --refresh
```

SQLite 备份保存全部已采集统计与解析缓存；还需单独备份状态目录中的 `objects/` 才能保证已删除仓库的未来规则重算能力。活跃仓库对象丢失后可以重新 fetch。

列表缺失、403/404、超时不等于已删除。只有明确确认删除或决定永久停止跟踪后，才执行：

```bash
python -m poly_tally retire 123456789
python -m poly_tally resume 123456789
python -m poly_tally collect --public-only
```

`retire` 保留全部历史并标为冷数据，不再抓取新提交，但仍读取可用元数据以更新名称和公开状态；`resume` 恢复发现与同步。冷数据不计入当前活动总量，可以在历史档案查看。规则变化后若保有对象会离线重算；若对象丢失则保留原规则版本，界面隔离旧口径，不伪装成统一总量。

Actions cache 只用于公开计算加速，不能保证永久存在。`tally-state/checkpoint.json` 保存公开仓库的完整统计检查点；同分支的 `private-metrics.json` 保存私有仓库名与日级规模，不保存私有源码、路径、blob 或 commit ID。每轮先恢复持久数据再扫描，旧缓存不能覆盖冷数据。无规模、口径或状态变化时不生成数据提交。请勿删除该数据分支。

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
| `active` / `archived` | 当前口径成功快照，进入默认总量 |
| `empty` | 等待首个提交，不计入代码仓库总数 |
| `inaccessible` | 本轮不可访问，保留上次历史，默认不计入当前总量 |
| `stale` | 分支或规则改变后重建失败，旧版本明确标为过期 |
| `excluded` | 移出授权或规则范围，保留历史但不汇总 |
| `cold` | 人工确认删除或停止跟踪，永久保留历史档案 |

可勾选查看同口径过期快照；不同规则版本始终隔离，不能混加。

## GitHub Pages 部署

仓库设置的 Pages 发布来源为 **GitHub Actions**，默认开发分支为 `dev`。仓库公开本身不会自动部署页面。

`.github/workflows/pages.yml` 依次运行 Python / Node 测试、恢复状态、采集、保存公开检查点、上传并部署静态页面。前端没有运行时 CDN 依赖，所有链接和数据请求都支持 `/poly-tally/` 项目路径。

`web/data/stats.json` 是公开基线，`web/data/private-metrics.json` 是脱敏私有基线。构建时合并，后续优先从持久数据分支及本轮作业取得最新规模，无需反复向 `dev` 提交统计。`--refresh` 刷新产物时间，私有更新时间单独显示。`dev` 保存代码，`tally-state` 保存可公开采集状态。

## 验收复现

```bash
python -m pytest -q
node --test web/*.test.mjs
python -m poly_tally collect --public-only
python -m poly_tally collect --public-only
node scripts/build-site.mjs
```

第二次无变化采集应报告 `parsedBlobs=0`、`objectReads=0`、`recomputedCommits=0`。真实 Git fixture 覆盖新增、修改、删除、改名、合并、revert、分支切换/改名、祖先回退、分叉和无公共历史、倒序时间、规则重算与冷数据离线重算。发现与运维测试覆盖分页、组织/私有范围、身份稳定、限流、权限故障、事务恢复、公开隐私和锁；Node 测试覆盖三仓库时间对齐、同刻覆盖、筛选、旧规则隔离与空态。

实现边界与数据协议见 [数据与模块](docs/architecture.md)。
