# 同源仓库组与严格重算

## 本次 source-only 重置

全局排除 JSON/JSONC/YAML/YML/XML 及等价语言类别，源码/测试目录不例外，具体见 [收录边界](content-policy.md)。当前活动统计已清为空 pending 基线，旧私有/retained 活动文件撤下；Git 历史不删除。下面同源算法在新口径代码行上重新完整回放。

## 配置与范围

`config.json` 的 `lineageGroups` 是唯一分组来源，不按名称相似、fork、创建时间自动推断：

```json
{
  "datasetEpoch": "source-only-lineage-2026-10-21-v1",
  "lineageGroups": [
    {"id": "vitro", "members": ["SiliconYC/vitro", "SiliconYC/vitro_zero_lab", "SiliconYC/vitro_union_lab"]}
  ]
}
```

成员顺序不是主导顺序。`id` 是稳定统计项身份，成员全名不区分大小写匹配；同一成员不能出现在多个组。组成员无论归档、fork 或普通排除规则均扫描，私有读取仍须已有授权。普通已归档仓库排除。因此 `vitro_union_260204_obsoleted` 不统计；`vitro_agent_foundry` 独立统计，绝不是继承链成员。

## 唯一主导的确定性回放

从每个成员**当前默认分支的完整第一父链**重新得到逐提交规模，再回放整组，最后才进行私有日级降采样与 UI 时间裁剪。

1. 最早出现提交的成员先主导。同一最早时刻以稳定仓库 ID 的字符串顺序打破平局。
2. 每个成员独立保存截至当时的历史最大 **code**。某成员成为或不再成为主导，都不清零该高点。
3. 挑战者只有代码行**严格超过当前主导成员截至当时的历史最大代码行**才切换。相等不切换。主导缩减并不追随当前最大者。
4. 同一 UTC 时刻统一批处理：成员内部按第一父链顺序确定该刻最终存量，同时保留所有中间提交峰值；先更新原主导高点，再评估挑战者。本批次多个突破者先选本批次代码峰值最高者，峰值平局按稳定仓库 ID 字符串顺序。切换后显示获胜成员该刻最终存量，即使它在同刻先增后减。每刻只发出一个可见快照。
5. 每点 `metrics` 的代码、注释、文档、空行、文件数，以及 `languages` 全部复制**同一个主导成员**，不能逐项挑最大，不能组内相加。
6. 零值是有效事实，严格比较仍成立。经确认的空仓库没有候选快照；`size=0`、无默认分支名或分支 HTTP 404/409 都不足以证成空（404 可能是权限错误）。必须另取得未过滤分支列表的 HTTP 200 空数组且无下一页，才确认当前没有分支；此接口对私有仓库要求 Contents:read。参见 [GitHub 404 权限说明](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource) 与 [分支列表权限](https://docs.github.com/en/rest/branches/branches#list-branches)。全组为空则统计项为 `empty`，无主导，按稳定 ID 选择展示名称。缺仓库、缺指标、不可访问、旧规则或不完整历史不是零；整个组暂不输出，完整性证明失败。
7. 代表名称独立于主导：取当前默认第一父链中实际 `committedAt` 最新的成员；完整 UTC 时刻比较，平局按稳定 ID。不是 `pushed_at`、归档时间、扫描时间，也不是降采样后的日期。对外只另发 `lastCommitDate` 日期供列表排序；私有实际提交时刻不发布。

默认分支切换、rewritten history 会先让单仓库历史重新建立，再从头回放组，不复用旧的 winner/高点。成员集合/规则改变必须使用新 epoch；调整 JSON 中的排列顺序不会改变版本。最近 30 天等 UI 筛选只裁已算好的组历史，不重置阈值。

## 公私混合与隐私

公开导出始终抑制配置组的原始成员，避免不完整公开子集与私有组叠加。私有作业读取**全部配置成员（包含公开成员及归档成员）**，在保护边界内先按逐提交事实完成组回放，再降为日末规模。组含任一私有成员，整个合成项均走私有脱敏白名单。

私有合成项继续使用 `private-<hash>` 身份，底层键来自 `lineage:<配置id>`；`lineage` 仅含配置 ID/版本、已授权成员名及匿名源键、当前主导成员名和代表成员名。历史只包含 `timestamp/metrics/languages`，没有源码、路径、commit SHA、message、author、精确提交时间。JS 合并按成员匿名键去除所有原成员，不会将同组公私分别相加。

## 新 epoch 的完整性门槛

当前新 epoch 为 `source-only-lineage-2026-10-21-v1`，配置和 Actions 一致。派生统计首次计算不能初始化于旧 SQLite/检查点；检查点必须 epoch 与 lineageVersion 同时匹配，SQLite restore 也必须契约一致。CLI 独立缓存中的原始 Git 对象及版本化解析事实可以复用，但不能充当已完成统计；每次仍核对当前授权范围与默认分支。新 epoch 绝不接受旧 `retained-private-baseline` 作为成功输入。

`completeness` 记录发现成功、预期源数、成功源数、缺成员数、失败数。`complete=true` 必须全部检查通过，组成员全部齐备、同规则、完整历史。没有运行证据的空输出不是成功。`validate --complete`、adopt、站点 build 和 durable state save 都拒绝未证明完整的私有输出；公开与私有作业证明分别保留，合并后的整体 complete 必须公开本轮完整，私有本轮完整或经过显式外部快照校验。若本次私有作业失败、取消、下载/采用失败或未配置权限，只可保留同 epoch 的上次完整规模；其成功证明移到 `publication.privateSnapshotCompleteness` 供溯源，本次 `privateCompleteness=null`、整体 `complete=false`，不能把旧成功证明当本次成功。合并证明中的计数是扫描任务数，跨作业重复扫描公开成员会重复计任务，不是统计项数。

自动发现只能证明**当前凭据可见范围**，不能凭 API 列表自证账号所有私有仓库都可见。此次整体重算可另用新鲜授权 metadata 盘点（不是旧指标/检查点）检测缩小的凭据范围：

```bash
python -m poly_tally collect --private-only --include-private-metrics \
  --state "$(mktemp -d)" --expected-inventory /secure/fresh-owner-inventory.json \
  --output /secure/rebuilt-stats.json --private-metrics-output /secure/private-metrics.json
node scripts/metrics.mjs validate /secure/private-metrics.json --complete
```

盘点结构为 `{source,verifiedAt,repositories:[{id,name,visibility,archived,...}]}`。新发现仓库仍自动纳入，不要求逐个配置。盘点只对本次调用生效，不进入发布 payload；清单中预期活跃源不可见/未成功扫描会使完整性失败。范围变化后应重新获取 metadata，而不是删除缺项或把旧统计改名成新 epoch。

未完成实际读取/计算时，UI 可独立更新，但新数据必须保留 `pending-rebuild`/`stale`。已授权 connector 或本地 Git 可作为采集入口，不要求新 Key。外部脱敏快照必须在手动工作流显式选定 `external_private_blob_sha`，精确字节、epoch、rules、lineage 和完整性全部通过才标 `external-verified`，仍保留真实原采集时间；详见 [私有采集](private-collection.md#显式发布外部完成的私有快照)。不创建或保存 token，不删除提示冒充 fresh。

## 前端共享 API

- `periodChanges(repositories,{period:'day'|'week'|'month',since,until,metric,language,limit})`：UTC 日/周/月净变化，周一开周，支持代码/注释/文档/文件及其他现有指标，保留负数；缺期初事实的项不将首次存量当新增。
- `monthlyChanges` 为兼容封装。
- `repositoryShares(repositories,{metric,language})`：输入合成仓库，每项唯一主导的最新存量，占比不重复计组成员。
- `repositoryUpdatedAt`：实际提交/公开日期，不用 `lastSuccessAt`。

## 验证

`python -m pytest -q` 与 `node --test scripts/*.test.mjs web/*.test.mjs` 覆盖阈值、同刻、中间峰、平局、回切、零值、缺失、默认分支重算、成员变化、公私去重、归档例外、epoch、隐私白名单及日周月净变化。另以真实本地 Git 混合组复核：归档私有祖先同日代码 100→10，公开后继次日 90 不切换，后来 101 才切换，日级导出为 10→101，并通过 JS `--complete` 验证。
