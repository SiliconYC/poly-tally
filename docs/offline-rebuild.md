# 离线历史重算

## Eigen 纠偏

`config.json` 的 `rules.exclude` 新增 `**/[Ee][Ii][Gg][Ee][Nn]/**`，排除任意层级、任意大小写的 `Eigen` 目录。规则优先于源码与测试保留规则，所有仓库和所有历史提交使用同一口径。`src/eigen_solver.cpp`、`EigenSolver/` 等自有文件与目录仍保留。

本次切换到 `source-only-no-eigen-2026-10-22-v1` 批次，防止旧指标混入新统计。同源组的主导仓库也根据纠偏后的逐提交规模重新计算。移除第三方库不再造成今天的虚假下降，最初引入时的第三方代码也不再构成历史增长。

2026-10-22 使用本机完整缓存的实际结果：

| 项目 | 结果 |
| --- | ---: |
| 仓库记录 / 重放提交 | 34 / 2,592 |
| 离线重算耗时 | 47.864 秒 |
| Git fetch / blob 读取 / 文件解析 | 0 / 0 / 0 |
| 解析事实缓存命中 | 82,929 |
| `vitro_union_lab` 首个受影响日期 | 2026-09-17 |
| 受影响历史快照 | 50 |
| 该仓库缓存 HEAD 代码量：纠偏前 → 后 | 678,496 → 558,128 |
| 排除第三方代码量 | 120,368 行 |

另外 33 条仓库记录的逐提交历史完全一致；来源批次保持不变。上述数字针对缓存中已采集 HEAD，不代表离线期间源站没有新增提交。PR 的删除行数包含注释、空白与其他文件，不能直接当成统计口径下应扣除的代码行数。

## 使用已保存数据重算

在仓库根目录运行：

```bash
.venv/bin/python -m poly_tally rebuild \
  --from-state .poly-tally/local/epochs/source-only-lineage-2026-10-21-v1 \
  --state .poly-tally/local \
  --cache .poly-tally/local/cache \
  --include-private-metrics \
  --private-metrics-output .poly-tally/local/rebuilt-private-metrics.json \
  --output .poly-tally/local/rebuilt-combined-stats.json \
  --checkpoint .poly-tally/local/rebuilt-checkpoint.json \
  --report .poly-tally/local/rebuild-eigen-report.json
```

`--from-state` 指向含有 `stats.sqlite` 的**来源批次目录**；`--state` 指向**状态根目录**，CLI 会附加 `epochs/<datasetEpoch>`。`--cache` 指向**缓存根目录**，CLI 会附加 `private`；指定 `--public-only` 时附加 `public`。未指定 `--cache` 时使用 `<state>/cache/<范围>`。来源与目标必须是不同目录，旧批次保持不变。

命令不读取凭证，不发现仓库、不调用 GitHub API、不执行 `git fetch`，也不更新源引用。它读取来源记录中的身份、可见性、分支、已知 HEAD 与原采集时间，以缓存对象从零重放目标历史；旧 `history`、`inventory` 和完整性证明不会作为新结果导入。路径规则变更仍复用按内容、语言、解析器版本与大小上限索引的事实。放宽规则也可读取原始对象，不要求重新下载曾被排除的文件。

所有仓库成功后，目标仓库表和运行记录才在一个事务内替换。缺失对象、浅仓库、非空记录缺失 HEAD 或来源历史不完整都会明确失败，不联网补齐、不把缺失内容当成零，也不替换目标已有统计。计算途中写入的内容寻址解析事实仍可复用。

`--public-only` 只重算来源中的公开记录；`--private-only` 只重算私有范围及显式同源组成员。普通归档记录不恢复为活动仓库，冷数据保持冷状态。当前配置仍排除的仓库保持 `excluded`，但其已知 HEAD 与新口径历史继续保留，以便未来放宽范围后离线重新纳入。离线重算不能核实现在的仓库可见性、发现新增仓库或读取尚未采集的新提交。

## 离线结果与正常发布

离线运行记录包含 `offline=true`、`completeness.discoveryComplete=false` 和 `completeness.complete=false`。`lastSuccessAt` 保持来源时间，不能将重算时刻冒充源站采集时刻。私有导出仍只含仓库名称和日级规模；源码、文件路径、逐提交身份与完整 SQLite 留在本地。离线输出不能冒充 fresh，但完整重放、无失败且未缩减已有私有范围的快照，可通过 `save-rebuilt-private` 保存并以未刷新状态展示。新鲜核对尚未完成，不能成为删除私有仓库展示的理由。

完成重算后，正常更新：

```bash
node scripts/update-local.mjs
```

更新会重新核对授权范围、元数据与当前默认分支 HEAD。重算结果与当前 HEAD 一致时，不执行 Git fetch、不解析文件、不重新计算提交；只更新观测状态。源仓库出现新提交时按正常增量流程补齐变化。

## 以后修改统计口径

1. 修改全局规则，并选用新的 `datasetEpoch`；同步 `.github/workflows/pages.yml` 的批次值。
2. 保留旧批次 `stats.sqlite` 与完整 `cache/`，使用上面的 `rebuild` 命令，令 `--from-state` 指向刚才的旧批次。
3. 检查输出与性能报告，再按正常更新流程核对源站并发布。

仅修改路径排除规则时，已有合格文件的解析缓存通常全部命中。改变语言分类、解析器版本或大小限制可能需要本地重新解析，仍不需要联网获取已保留的对象。

只有页面聚合 JSON 或公开检查点时，通常不足以精确恢复历史文件路径与指标。公开检查点仅保留最新文件清单，不保留每个历史树的全部路径；必须同时保有 Git 对象，才能可靠重算所有提交。Actions cache 是加速缓存，可能过期；长期离线能力依赖对状态数据库和对象/解析缓存的备份。新发现仓库、未采集提交或丢失对象仍需要恢复备份或显式在线采集。
