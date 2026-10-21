# 未归档私有快照保留审计

这是恢复私有仓库展示的过渡基线，**不是私有仓库全量重算**。公开重算批次仍是 `active-default-branches-2026-10-21-v2`，不修改、回滚或混入旧公开数据。

## 已核验事实

- 2026-10-21 10:41:29 UTC，通过已授权 GitHub 连接器 `list_repositories(owner=SiliconYC, page_size=100)` 读取 32 个仓库；offset 100 返回空页，完成范围核验。
- 其中 21 个 private：16 个 `archived=false`，5 个 `archived=true`。依据 GitHub 数字 ID 的 `sha256("poly-tally/repository/" + id)[:16]` 与既有脱敏快照逐一匹配，21 个全部对应；不按名称猜测。
- 原始脱敏快照来自 `tally-state/private-metrics.json`，状态提交 `98235eeb66a4a1efcb883cb6ed8b704b4a9d6485`；连接器返回 blob `d2a53ba74cd68bcd190e42cbdec31e7c082e209c` 与本地文件 `git hash-object` 完全相同。
- 原始字节 SHA-256：`c52058f9c916f51daf774ef4d0dedc6937ddd7bff30c6a3017ec0567a8fb5fce`。
- 原始采集时间：`2026-10-21T05:18:28.364564Z`；原始规则：`02d117290f38a1c2`；原始 epoch 未设置，显式记录为 `null`。

## 变换与约束

`web/data/retained-private-baseline.json` 仅保留核验为未归档的 16 条旧记录，调整 collection 数量，并附加 5 个归档身份哈希；历史、每仓库成功时间及规则保持原样。核验范围只含哈希，不含私有源码、文件路径、提交标识或提交详情。原快照已经授权公开的仓库名和日级规模维持既有白名单。

独立 manifest 包含原来源提交/文件哈希、目标批次、来源批次、范围核验时间及保留内容摘要。`retainedSnapshotSha256` 依据 `JSON.stringify(metrics)` 的 UTF-8 计算，构建严格检查全部字段、完整性、每条活动身份与归档身份互斥。

只有显式传入 `retainedBaseline` 才允许旧私有快照跨 epoch 展示，且不重写源 epoch、时间或规则。发布数据标记 `privateStatus=retained`、`privateDatasetEpoch=null`、旧 `privateUpdatedAt` 和 `privateRulesVersion`，私有记录标记 `dataFreshness=retained-private`。默认汇总包含它们，不依赖“包含过期快照”复选框；主界面和列表显示待重算状态。

## 退出条件

同批次的完整新私有快照优先。构建检查时间不能倒退，16 个旧身份只有新记录、已确认 archived 哈希或当前公开记录才能替换/移除，防止权限范围缩小伪装成完成。新快照成功后不再注入 retained 标记，界面恢复正常采集状态。此例外绑定当前 v2，再次换批次不会自动沿用。

保留范围只说明上述核验时刻的 GitHub 状态；没有重新读取私有源码或改变凭据/权限。后续具备已有授权凭据的采集仍先排除 archived，再处理 public/private；包含“原私有转公开后归档”的回归测试。
