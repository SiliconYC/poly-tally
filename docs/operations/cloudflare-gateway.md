# Cloudflare 免费代理：单文件部署与验收边界

## 所有者只需复制源码并 Deploy

1. 打开仓库根目录的 [完整 Worker 源码](../../poly-tally-gateway-worker.js)，进入 **Raw**，复制全部内容。
2. Cloudflare 控制台 → `poly-tally-gateway` → Edit code，替换完整源码并点击 **Deploy**。
3. 沿用已有 `GITHUB_READ_TOKEN`、`GITHUB_PUBLISH_TOKEN`、`GATEWAY_KEY` 三项 Secrets；不新增第四项、不需要本地文件、CLI、构建、域名或付费套餐，也不需要 `nodejs_compat`。

**本轮只准备代码，不代替所有者部署，不执行真实私库采集或统计发布。**
当前已连通的旧 Worker `/health` 返回 `poly-tally-gateway-ok`；这不能证明新版上线或 Secrets/私库权限正确。
新版保留该正文，增加 `X-Poly-Tally-Protocol: 2`，供部署后无凭据确认版本。
只有 health/未认证拒绝可做当前公网检查；正式采集、发布及定时须另行确认。

## 三项 Secret 的边界

| 名称 | 位置与权限 |
|---|---|
| `GITHUB_READ_TOKEN` | 仅 Cloudflare；fine-grained PAT，SiliconYC 资源所有者，Metadata read、Contents read。全部当前/未来自有仓库需 all repositories。 |
| `GITHUB_PUBLISH_TOKEN` | 仅 Cloudflare；独立 PAT，仅 `SiliconYC/poly-tally`，Metadata read、Contents write、Actions write。 |
| `GATEWAY_KEY` | 独立高强度代理口令，40–256 个可打印 ASCII 字符；Dot 仅持有它。不得填 GitHub PAT。 |

三项必须互不相同。收据 HMAC key 在请求内由发布 PAT 经**固定域分离 SHA-256**派生；不是 HKDF，也不需要额外 Secret。PAT 及派生 key 不写文件、源码、URL、日志或响应。
GitHub Contents 写权限**不能原生按分支限制**；只写 tally-state 是 Worker 的强制边界，不是 PAT 自身的能力限制。
Cloudflare 管理员能改程序取得 Secrets；本方案不是绝对 secret-proof。不要把真实凭据发到聊天或 shell history。

Dot 可用 `POLY_TALLY_GATEWAY_PASSWORD_FILE` 保存**代理口令文件路径**：文件在仓库外、当前用户所有、普通非符号链接文件 `0600`、父目录 `0700`。值只进进程内存。临时 `POLY_TALLY_GATEWAY_PASSWORD` 与文件入口不能并用。
`POLY_TALLY_GATEWAY_URL` 是 HTTPS origin，例如用户已有的 workers.dev 地址。gateway 模式禁止 `GH_TOKEN`、`GITHUB_TOKEN`、`POLY_TALLY_TOKEN` 存在，不回退旧 helper。
Linux Git 子进程禁用 helper/交互/AskPass，HOME/XDG 固定为不能包含文件的 `/dev/null`，清除 NETRC、CURL_HOME、Git TLS 环境覆盖，强制 TLS 验证；失败不得取用现有 `.netrc` 或其他凭据。

## 只读范围与原生增量

- 固定 `api.github.com` 的 SiliconYC 账号/自有仓库/默认分支必要接口；默认 `SiliconYC/*`，不是任意 owner 代理。实际返回 owner 必须匹配。
- 只投影采集所需 metadata 字段。列表每上游页 10 项，分页 Link 验证同资源并改写回 gateway；限流错误保留 Retry-After/必要 rate-limit 头，不反射原始错误正文。
- 只允许 `GET /git/SiliconYC/<repo>.git/info/refs?service=git-upload-pack` 和 `POST .../git-upload-pack`，不允许 receive-pack、额外 query、任意 host、路径歧义或重定向。保守拒绝字面 `%` 等特殊 branch ref；普通 main/dev 与单次编码的斜杠分支可用。
- 所有 Git pack 请求/响应直接流式转发，不整包读入 Worker。1MiB 快照限额**不适用于 Git pack**。
- Python 统计、SQLite、Git bare cache、第一父链、解析缓存和 HEAD 未变跳过规则不变。返回 clone_url 仍是 GitHub 原地址，由传输层映射，不改变 source 身份。
- 显式入口 `node scripts/update-local.mjs --gateway` 会采集并发布，**未经正式运行确认不要执行**。旧直接 PAT 模式仅供已有调用者显式兼容，不能用于本任务回退。

## 受限发布协议

旧 `/api/.../git/blobs|trees|commits|refs` 通用写接口全部拒绝。客户端不能选择原始 blob、路径、tree、parent、force、commit message 或 workflow。

1. 本机对原 exporter 输出执行原 `projectPublicStats` / `validateSnapshotPair`。
2. `/publish/start` 由 Worker 固定读 tally-state ref/tree。首次迁移必须存在 `private-metrics.json` 和 `rebuilt-private-metrics.json` 两份基线，缺任何一份就停止，不能把删除当成空状态。
3. 首迁移每次 `/publish/baseline` 仅由 Worker 按已签名 tree SHA 读取一份固定 blob；客户端只能带进度收据，不能供基线内容、URL、SHA 或 scope。以流计数，超过 1MiB 立即取消；核对原始字节长度和 Git blob SHA，再运行**原完整 validator**，才签紧凑摘要。每份是独立请求，但一份内部的 await 不会重置 CPU。
4. 新快照每个 chunk 不超过 16KiB / 8 个历史点；验证原 schema、日精度、时间顺序、完整性、scope、lineage、summary 等。每种可见性最多 64 个展示仓库；签名状态最多 128KiB、控制 body 最多 256KiB，超限拒绝。
5. Worker 自己规范化序列化并增量 hash，不签客户端未解释原文。seal 绑定同一 public/private pair、精确 SHA256/长度、policy、base。
6. upload 只接收这些已授权精确字节；**单个最终 blob 请求体 ≤1MiB，包含 JSON 转义**，有界缓冲并先验 hash 再上传。它不是通用流式大文件发布；超限无付费/跳校验回退。
7. 只生成三个固定文件：`public-stats.json`、`private-metrics.json`、`gateway-receipt.json`。base_tree 保留 checkpoint、rebuilt 和其他既有文件。当前 ref 检查 + `force:false` 保证不能强推覆盖并发更新。
8. 仅触发 `publish-snapshot.yml` / `dev`，输入为刚提交且仍当前的 commit/public/private 三个不可变 SHA。**不触发重新采集的旧 pages.yml。**

后续 start 校验小的 HMAC receipt 和两份实际 blob SHA，避免每次重跑大旧 JSON。
旧 root JSON 格式保持不变，现有 restore / snapshot-only Pages 继续兼容；receipt 是附加文件。
真正成功的新扫描时间可以发布为新快照；不把旧数据改日期假装新采集，也不为省提交让扫描新鲜度永久停留。

**schema/完整性/一致性验证不等于重新计算源码真实性。** Worker 不分析源码、不计算真实代码行数。持代理口令者仍可能提交满足 schema 的虚假数值；本方案保护凭据隔离、资源权限、机密字段和发布一致性，不宣称消除一切伪造风险。

## 失败、响应丢失、轮换与恢复

- commit 前本地保存 `gateway-dispatch-receipt.json` 的 pending 能力，`0600`；成功后替换为 dispatch 收据。
- 若 PATCH 已成功但响应丢失，`retry` 先请求只读 `/publish/status`：核对当前 commit 单父 base、tree 两份 SHA、签名 receipt 的 batch/pair/base/两 SHA，并再次确认 current，才能恢复 dispatch 能力。**不重发不确定 commit、不重采源码、不强推。**
- 若结果无法确认或能力已过一小时有效期，明确停止；保留同一脱敏本地批次，可以重新校验发布，不能冒充新扫描。
- dispatch 成功但响应丢失时，显式重试可能重复启动**同一 immutable snapshot 的 Pages 构建**；不承诺全链路 exactly-once，不会为此新采集或写统计数据。
- PAT 轮换会使旧签名失效，普通 start 必须拒绝。显式维护 `/publish/recover` 只接受 `expectedCurrentCommit` 并重新读取/完整验证两份固定当前基线；不接受客户端基线。缺文件、并发变化均拒绝。
- 仍可验签的旧 receipt（含旧 policy）继续作为时间/scope 下界；显式恢复也不能借机缩 scope。无法验旧 key 时，是**明确以当前 GitHub 两份完整已验证快照重新建立信任**，不能声称证明了与旧 key 的历史连续性。
- 外部旧发布器绕过 gateway 更新会使正常 start 关闭；需要上述明确维护。恢复比正常新发布更保守，不会凭客户端声称“已转公开”而删除私有 scope，遇此情形保留旧数据并另审维护，不自动绕过。
- Dot 的维护入口为 `node scripts/gateway-publish.mjs retry /absolute/batch/gateway-dispatch-receipt.json`；显式恢复为 `... recover CURRENT_COMMIT public.json private.json`。这些不是用户部署所需步骤，当前不执行。

## 免费 CPU：仍是生产启用硬 gate

Cloudflare Free 的 10ms CPU/request 不能由本地测试替代。HTTP 连接存续时无固定 wall-time 上限，也不代表九分钟扫描是一次九分钟 CPU，更不代表已测过真实九分钟扫描。

合成本地预检出现明确风险：约344KiB首次基线请求 CPU 中位约8ms、峰值约20ms；接近1MiB时中位约15ms、峰值约29ms（包含本地 mock 开销）。**1MiB 是安全/内存上限，不是 Free 性能承诺。**
首次迁移/密钥轮换、最大 state 的 chunk/seal/upload/commit 必须在真实 Free 上测 CPU/1102/余量，验收前不启动正式采集发布。若真实超预算则 failclosed、保留旧状态，再专门改进基线分块；不购买套餐、不跳校验。

每次 start 最多 4 个上游请求、baseline 2、status 5、commit 5、dispatch 2；均小于 Free 的 50 次 subrequests/request，但日请求额度、网络超时与较大真实 pack 仍须实测。

## 工程验证（由 Dot 执行，不要求用户安装）

```sh
npm ci
npm --prefix workers/gateway ci
npm --prefix workers/gateway run build
npm --prefix workers/gateway run check
npm --prefix workers/gateway test
node workers/gateway/test/workerd-smoke.mjs
node workers/gateway/test/cpu-preflight.mjs
.venv/bin/python -m pytest -q
node --test scripts/*.test.mjs web/*.test.mjs
npm test
npm run typecheck
```

根单文件由同一源模块、既有原 validator 和公开 policy 确定性构建；仅去除 Node CLI 入口、替换同步 SHA256 适配。无运行 baseline、无私有数据、无外部 imports；源码改变后 check 必须要求重建。Wrangler dev 与 workerd 都指向该根单文件，不走另一套 Node 兼容包。

本地已用假凭据、合成 Git repository 验证冷取/暖取/增量、3MiB pack 和完整发布流程；这不是线上私库或 Cloudflare Free CPU 证据。
缓存只核验当前存在的实际路径/SQLite/Git 状态；跨天或换环境后重新 stat，不承诺 scratch 永久保留。
旧每日三次定时仍暂停；按本轮最新要求，正式定时须再次确认，不在代码准备阶段创建或恢复。

开发早期红测曾意外到达旧 `git credential fill` 路径，helper 失败且无返回凭据，未取得/打印 PAT。后续测试均隔离 HOME/system/global Git；新增假 HTTPS401 spy 回归确认不会回退 AskPass/helper/.netrc。不能声称开发从未尝试过旧 helper。

### 控制台日志与管理权限

在 Dashboard 保持 Worker Invocation/request 日志关闭；源码的 `observability: false` 仅作用于对应 Wrangler 配置，不能替代核对既有控制台设置。完成部署后退出管理会话，并撤销为本任务授予的临时管理授权。持有 Worker 管理权限者仍能修改代码读取 Secrets，本方案不承诺对管理员绝对保密。
