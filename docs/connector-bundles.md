# 授权连接器对象包：离线完整重算

这是另一条**Git 对象传输路径**，不是认证桥接器。它复用现有历史引擎、解析器、
纯源码规则、同源仓库合并与隐私导出器；不创建或导出令牌，不修改远端，也不会使用
网络或 Git credential helper。

## 对象包契约：schema 1

将对象包放在源码仓库之外，根目录权限必须为 `0700`。不得提交原始 API 响应、
私有文件路径、提交元信息或源代码 blob。

```text
manifest.json
fetch-log.jsonl                       # 本地抓取审计记录，不含认证秘密
objects/commits/<sha>.json             # GitHub Git Database commit 响应
objects/trees/<sha>.json               # GitHub 非递归 tree 响应
objects/blobs/<sha>.json               # 下述无损 base64 响应
```

所有对象按原始 SHA 全局去重。`manifest.json` 示例：

```json
{
  "schemaVersion": 1,
  "source": "github-connector",
  "captureScope": "private-only",
  "capturedAt": "2026-10-21T12:00:00Z",
  "discoveryComplete": true,
  "repositories": [{
    "metadata": {
      "id": 1,
      "full_name": "fixture/source",
      "default_branch": "main",
      "private": true,
      "archived": false,
      "fork": false
    },
    "head": "0123456789012345678901234567890123456789",
    "verifiedHead": "0123456789012345678901234567890123456789",
    "verifiedDefaultBranch": "main",
    "verifiedAt": "2026-10-21T12:30:00Z"
  }]
}
```

`captureScope` 为 `all`、`public-only` 或 `private-only`，必须与导入参数一致；
省略时为 `all`。示例 SHA 仅说明格式，并非真实对象。`head` 在抓取前固定；
抓取后重新读取默认分支名和 HEAD，分别写入 `verifiedDefaultBranch`、`verifiedHead`。
前后不一致必须拒绝，不能混合快照。私有范围的完整证明不代表公开或全部仓库已完成。

可选 `verifiedAt` 记录该仓库最终引用核对的时间；省略时采用 `capturedAt`。
导入后的 `lastSuccessAt` 保留这个源观察时间，不能因隔日重算而伪装成当天读源。
导入完成时间另存为运行记录的 `finishedAt`。

每个第一父提交都必须存在，直到明确带 `parents: []` 的根提交。无需下载第二父提交。
提交对象必须具有匹配的 `sha`、`tree.sha`、`parents`，以及包含时区的
`author.date`、`committer.date`。

每个 tree 必须具有匹配的 `sha`、明确的 `truncated: false`，且只列直属条目：
`path`、`mode`、`type`、`sha`，以及合格 blob 的 API `size`。所有子树都必须下载，
包括被路径规则排除的目录。按 Git 的排序和模式编码还原 tree 字节后，其 SHA 必须
匹配。符号链接和 gitlink 不跟随、不计数。

必须对**每个历史完整路径**调用 `rules.api_语言(full_path)`，不能因为某个 tree SHA
已在另一路径下载过，就跳过当前路径的资格判断。仅规则接受、普通文件模式且大小不超过
`max_blob_bytes` 的 blob 需要下载源码。路径已排除的文件无需 blob 字节；合格但超限
的文件须有可信 API 大小，仍明确记为跳过。缺少合格文件内容或大小信息属于失败，不能
冒充正常排除。

读取 blob 时，使用现有授权连接器的文件读取入口，指定**精确提交 SHA**、完整路径及
`encoding: "base64"`。保存其 `sha`、`encoding`、`content`；可选 `size` 必须与 tree
一致。导入器检查原始解码字节、大小和 Git blob SHA。连接器 `fetch_blob` 返回的解码
文本不能代替原始字节。如果工具无法无损返回某个合格大文件，采集就是未完成，不能临时
缩小上限掩盖失败；也不能通过 UTF-8 转换再编码来猜测原始源码。

真正的空仓库须设置 `head: null`、`verifiedHead: null`、`emptyRepository: true`，并提供
`emptyEvidence` 和 `verifiedEmptyEvidence`。两份证据都必须记录 GitHub API 明确返回的
`status: 409`，以及包含 `Git Repository is empty` 的消息。仓库 size 为零、分支缺失、
403、普通 404 或遗漏 parents 均不是空仓证据。

### 如实说明校验边界

- **Blob SHA**：根据原始字节重新计算验证。
- **Tree SHA**：根据完整条目还原 Git tree 字节并重新计算验证。
- **Commit SHA**：属于 **API 报告的身份**，另校验第一父链连续性。API JSON 无法还原
  全部原始提交头、签名和原始时区格式，因此不声称验证了原始 commit 字节的 SHA，
  也不伪造替代提交。API 日期代表的时间点保持不变。
- **发现清单、引用观察及超限大小**：是捕获到的可信 GitHub API 事实，不是独立签名证明；
  应保留本地抓取记录。

## 校验与重算

抓取仍在进行时，可校验一个已完成的仓库：

```bash
python scripts/import-connector-bundle.py /private/capture \
  --config config.json --validate-only --repository-id 1
```

这只校验，不初始化数据库，也不发布文件。使用本次新鲜授权发现清单完整重算私有范围：

```bash
python scripts/import-connector-bundle.py /private/capture \
  --config config.json --state /private/new-state \
  --private-only --expected-inventory /private/fresh-inventory.json \
  --include-private-metrics --private-metrics-output /private/sanitized.json
node scripts/metrics.mjs validate /private/sanitized.json --complete
```

epoch 默认取 `config.datasetEpoch`，也可显式传入 `--dataset-epoch`。状态写入
`state/epochs/<epoch>`，目标必须不存在或为空。入口不接受旧检查点或旧统计；它先验证
全部必需对象，在受保护的暂存目录从零重算，再检查同源完整性，最后原子安装新状态。
失败不留下部分导入的统计，也不复用已占用的 epoch。

新鲜发现清单沿用正常采集器的契约：`source`、`verifiedAt`，以及 `repositories` 中的
字符串 `id`、`name`、`visibility`、`archived`。预期 ID 和本轮实际范围必须一致。
普通归档仓库先登记排除证据，再进行可见性范围过滤，确保“私有→公开→归档”的仓库
仍提供匿名归档键，而不是遗失范围缩小证据。

公开采集可独立产生自己的完整证明；只能将上述已脱敏私有结果通过正常校验发布路径
合并，不能把私有完整证明当成全部仓库完整证明。

本地数据库保留原始源身份与统计事实，但不复制源码字节。输出仅为既有白名单公开统计，
以及显式请求的私有日级规模。`connectorBundleAudit` 在本地记录规范化 manifest 的哈希、
规则和如实的校验说明，不是原始源码导出。
