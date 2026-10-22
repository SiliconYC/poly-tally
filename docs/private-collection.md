# 私有仓库采集与公开规模

## 已生效的边界

私有仓库与公开仓库使用相同规则、当前默认分支和第一父历史计算。按用户要求，发布真实仓库名、稳定仓库标识、按日规模、语言汇总、状态及采集时间。名称用于选择与比较仓库；改名沿用稳定标识，不新增或截断历史。

公开的 `private-metrics.json` 中 `name` 是 `owner/repository` 形式的真实名称；不含链接、分支、HEAD、SHA、作者、提交消息、原始 author/committer 时间、文件路径或源码。同源组先在完整逐提交历史上确定唯一主导仓库，再按天取最终规模；历史日期显示 UTC 日末，当天显示采集时间。相邻日期完全相同的规模可省略。页面中的私有规模点不是提交数量。

通用备份读取器仍支持旧匿名显示名；这不授权本批次恢复旧统计。新导出使用真实名称。仅重新导出或重新发布不刷新采集时间，也不改动历史规模。

完整逐提交事实、SQLite 和 Git 对象仍在本地 `.poly-tally/`，不要提交该目录。仅公开 LOC 趋势不会使原私有仓库变为公开。

## 已有授权采集，无需创建新 Key

本次用户未提供新 Key；不因此要求新建或复制凭据。可以使用已经获准读取目标仓库的 connector，或本机已有的 Git 授权。两条路径共用当前配置、源码类别硬排除、完整默认分支历史、同源组与完整性门槛。只有范围和对象齐全的新计算才能发布；授权不足的仓库不能记成空仓库。

已授权 connector 的对象捕获由本地 `scripts/import-connector-bundle.py` 验证/导入。它本身不认证也不联网；原始 commit/tree/blob、路径和源码必须留在本地私有工作目录，不可上传到公开分支。仅导出的脱敏统计可以发布。参见脚本 `--help` 与 [同源组规则](lineage.md)。

### 复用本机 Git 授权

如果本机 Git 已经能够访问全部目标仓库，可以显式复用 credential helper：

```bash
source .venv/bin/activate
export POLY_TALLY_DATASET_EPOCH=source-only-lineage-2026-10-21-v1
python -m poly_tally collect --git-credential --include-private-metrics --private-metrics-output .poly-tally/private-metrics.json --output .poly-tally/combined-stats.json --refresh
```

令牌只经过内存与 Git 子进程环境；不会写入配置、URL、SQLite 或公开文件。默认不读 credential helper；不带 `--public-only` 的采集在缺少凭证时明确失败，不再默默降级到开源仓库。

只想更新私有范围时追加 `--private-only`。`export` 可以用已有本地事实重新导出，无需联网；规则变更应运行 `collect` 以重新计算历史。

发布只上传脱敏快照到本项目的数据分支：

```bash
export GITHUB_REPOSITORY=SiliconYC/poly-tally
node scripts/state.mjs save-private .poly-tally/private-metrics.json --git-credential
```

发布入口会严格检查匿名标识、字段、日期、语言与数值，拒绝包含 Git 提交字段、文件清单、额外字段或失败仓库的新私有快照。`save-private` 会输出 `private-blob-sha=<实际远端 SHA>`（程序接口返回 `privateBlobSha`）。首次新 epoch 写入仍需先有完整同 epoch 公开检查点；可以先运行公开工作流，页面会明确保持私有待重算。这里只写本项目的 `tally-state`，不会对被统计仓库写入。

### 显式发布外部完成的私有快照

本地或授权 connector 完成全量计算并上传脱敏快照后，在 [Actions](https://github.com/SiliconYC/poly-tally/actions/workflows/pages.yml) 手动运行 Pages，填写 `external_private_blob_sha` 为 `tally-state/private-metrics.json` **实际字节的 Git blob SHA**（40 位小写十六进制）。这不是源仓库提交 SHA，也不是任意文件的 SHA-256。

- 本次手动选择只证明发布者明确采用这一个已经验证的外部采集结果；不会把旧快照自动当成本轮新扫描。
- restore 与 build 都重新校验实际文件的 Git blob SHA；必须完整、同新 epoch、同 lineage 与 rulesVersion。缺文件、错 SHA、旧批次、不完整或规则不一致均拒绝发布。
- 公开采集自身也必须完整，合并后的 `completeness.complete` 才能为 `true`。发布记录保留原始 `generatedAt` 与 `privateSnapshotCompleteness`，并记录 `privateAttemptStatus=external-verified` 和所选脱敏 blob SHA。
- 不填写时，未配置凭据或本轮失败仍为 `not-configured` / `stale`，不能借旧快照的成功证明宣布本轮完整。
- 若上传仅改变采集时刻而数据完全相同，持久化可能不创建新数据提交；必须使用命令报告的**实际远端 SHA**，不能假设本地新字节已经上传。此优化不会重写或伪造采集时间。

本地构建也可通过环境变量 `POLY_TALLY_EXTERNAL_PRIVATE_BLOB_SHA` 显式选择并验证同一个文件；仅设置 `POLY_TALLY_PRIVATE_STATUS=external-verified` 会被拒绝。未显式选择的同 epoch 旧快照最多供过期溯源，不构成本轮完整性证明。

## 持续云端自动更新

Codex 或本机 Git 的仓库授权与 GitHub Actions 的授权是两回事。Actions 默认的 `GITHUB_TOKEN` 不能因此读取其他私有仓库，需要额外的只读凭证。参见 [GitHub 的认证说明](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)。

当前没有把本机宽权限令牌复制到云端。下文 Secret 仅是未来选择持续自动采集时的可选方式，并非本次任务前置条件。未配置且未显式选择外部快照时，公开仓库继续定时更新；本次 `source-only-lineage-2026-10-21-v1` 全量重置禁止复用旧批次私有快照，页面显示“私有待重算”，私有更新时间为空。不能把新的公开扫描时间当作私有已更新。

### 可选：经另行授权后配置最小权限令牌

1. 打开 [Fine-grained personal access token 创建页](https://github.com/settings/personal-access-tokens/new)。
2. 名称填写 `poly-tally-read`，Resource owner 选择 `SiliconYC`，设置到期时间，例如 90 天。
3. Repository access 选择 `All repositories`，这样未来新仓库也能自动发现；若选择指定仓库，需要之后手动扩大范围。
4. Repository permissions 只打开 `Contents: Read-only`；`Metadata: Read-only` 通常自动附带。其余权限保持未授权，不需要写入权限、workflow 或管理权限。
5. 创建令牌后直接在 GitHub 保存为 Secret，无需发给聊天窗口。具体权限与限制见 [GitHub 官方 PAT 文档](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

### 保存 Secret 并运行

1. 打开 [本仓库的 Actions Secrets](https://github.com/SiliconYC/poly-tally/settings/secrets/actions)。
2. 点击 `New repository secret`，名称精确填写 `POLY_TALLY_READ_TOKEN`。
3. 值粘贴刚创建的只读令牌并保存。GitHub 的操作说明见 [Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。
4. 在 [采集和部署工作流](https://github.com/SiliconYC/poly-tally/actions/workflows/pages.yml) 点击 `Run workflow`，分支选择 `dev`。之后沿用每天北京时间 09:17、21:17 的调度。

### 风险与计算成本

该令牌本身允许下载授权范围内的私有源码。只读可以防止修改仓库，但不能阻止持有令牌的人读取源码。仓库访客无法直接读取 Secret；能够修改受信任 `dev` 工作流的人可能通过代码使用或泄漏它，因此只有可信维护者应拥有写权限。令牌到期或怀疑泄漏时应撤销并更换。

Pages 工作流不再启动临时私有全量采集。`private-local.yml` 只在仓库变量 `POLY_TALLY_PRIVATE_RUNNER=enabled` 时启用，要求专用且受保护的 `self-hosted, poly-tally-private` runner，以及只读源凭据；不运行不可信 PR。原始对象、解析事实及派生状态保存在 runner 的持久工具目录，不进入公开 Actions cache/artifact。未启用时使用下文的本地增量命令。

## 本地增量采集并发布

在仓库根目录运行：

```bash
node scripts/update-local.mjs
```

默认复用 `.poly-tally/local/`。命令自动发现公开及私有范围，核对默认分支，仅下载变化的仓库并计算新增历史；采集失败立即停止发布。成功后只上传脱敏私有快照，再用实际远端 blob SHA 显式触发 Pages。公开数据由 Pages 独立增量采集，避免旧本地检查点覆盖并行云端结果。

本机 Git credential helper 或环境变量提供凭证，令牌不写文件。`POLY_TALLY_LOCAL_STATE` 可指定长期状态根目录，`POLY_TALLY_PYTHON` 可指定 Python。源读取凭证 `POLY_TALLY_TOKEN` 与项目发布凭证 `GH_TOKEN` 可以独立配置。默认不会替用户安装定时任务；可选持久 runner 工作流也必须显式启用。

本地 `latest-report.json` 包含逐仓库诊断、阶段耗时及总耗时，不可原样公开。性能指标中 `parseSeconds` 属于 `computeSeconds` 子集，不能重复相加；元数据读取、导出等剩余时间体现在总耗时中。

## 恢复与规则变化

公开工作流只从 `tally-state` 恢复同一 `datasetEpoch` 的脱敏私有快照。该批次曾完整采集成功后，云端失败可以保留同批次上一版并标记过期，但本轮完整性仍为 false。批次首次重算未完成，则不恢复旧 epoch 私有快照，保持 `pending-rebuild`。`save-private` 首次私有新批次写入必须有已成功重算的同批次公开检查点；外部明确 SHA 选择可在公开重算前先恢复待验证文件，最终构建仍核验公开结果的当前完整性与全部契约。

发布会拒绝采集时间倒退、同仓库成功时间倒退，以及未经证实的私有范围缩小，防止旧本地状态或权限撤回覆盖更新、更完整的数据。正常的新扫描 LOC 下降不受限制。私有转公开可由本轮公开扫描证实并去重；GitHub 明确归档的普通仓库，仅导出哈希 `archivedRepositoryKeys` 作为排除证据，不导出其名称、历史或规模；明确配置的同源组成员例外，仍扫描并参与主导候选。用户明确要求的新批次允许重建范围；同批次的未经证实缩减仍会被拒绝。

规则版本不一致的旧私有历史不得混入当前总量；本次已撤下旧活动统计文件，Git 历史可恢复但不是新 epoch 成功输入。私有转公开时使用稳定匿名键去重，避免旧私有快照与新公开记录双重计入。

需要重新计算私有历史时，必须拥有本地 SQLite 与对象缓存，或仍能读取源仓库；只有日级公开快照无法反推出逐提交事实。备份方法沿用 [README](../README.md) 中的 SQLite 与对象目录备份。

本次重算重新遍历当前默认分支的完整第一父链历史，不沿用旧状态，也不是仅保留今天一个点。`--dataset-epoch`（或同名环境变量）把状态放入独立 `epochs/<批次>/`；旧状态可恢复但不混入新批次。完整公开重算及验收字段见 [README](../README.md#本次全量重算批次)。

## 本次已重置活动数据，不使用旧保留例外

按用户本次明确要求，`web/data/private-metrics.json` 和 `retained-private-baseline.json` 的旧活动统计已撤下；项目配置 JSON 并未删除。当前源码内置统计是空的 `pending-rebuild` 占位，`completeness.complete=false`；零值不是已验证的真实总量。

旧 retained 机制只保留历史审计说明，不允许进入新同源 epoch，也不能在页面显示为本次新统计。新规则全量计算必须使用独立派生状态，不加载旧检查点。2026-10-22 起，CLI 的独立原始对象与版本化解析事实可跨批次复用；它们不是旧统计成功的证明，仍需重新发现授权范围、核对默认分支并完整重算。

普通归档仓库排除；明确配置的同源组成员不受归档状态排除。当前组仅为 `vitro → vitro_zero_lab → vitro_union_lab`；`vitro_union_260204_obsoleted` 不在组且已归档，排除；`vitro_agent_foundry` 独立统计。
