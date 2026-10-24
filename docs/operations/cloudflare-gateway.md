# Cloudflare FREE 密钥代理（待生产验收）

`poly-tally-gateway` 只保管凭据、限制请求和校验脱敏发布，不计算源码统计。
Python、原生 Git、SQLite、第一父链、HEAD 未变跳过、解析缓存与历史规则不变。

## 授权边界

- 读取仅 `api.github.com` 的必要发现/仓库/默认分支接口，以及
  `github.com/SiliconYC/<repo>.git` 的 `GET info/refs?service=git-upload-pack`、
  `POST git-upload-pack`。其他方法、receive-pack、任意 URL/owner/path/query、越界分页、所有重定向均拒绝。
- 默认字面资源范围 `SiliconYC/*`：这是用户授权的全部当前及未来自有仓库，不是任意 GitHub 通配代理。
  REST 返回的实际 owner 必须是 SiliconYC；客户端不获得 PAT。
  可选具体仓库列表会让新仓库发现明确失败，**不能**把这种模式称为全自动发现。
- 所有公开/私有 Git pack 都直接流式转发，不 `arrayBuffer()` / `text()` / `json()`；请求连接期间 I/O 等待不等于 CPU 用时。
- 写入固定公开仓库 `SiliconYC/poly-tally`、固定 `tally-state` 分支，固定三个文件：
  `public-stats.json`、`private-metrics.json`、`gateway-receipt.json`。
  旧 checkpoint、rebuilt snapshot 和其他树项保留。不能由客户端指定 blob 原文、路径、tree、ref、commit message 或任意 workflow。
- 唯一 dispatch 是 `publish-snapshot.yml` 的 `dev`，输入为刚提交且仍当前的三个不可变 SHA。
  它只重验脱敏快照、标准公开 Pages 构建和部署，不重新采集私有源码。
- GitHub PAT **不能**原生限制 Contents 写权限到某个分支。这一限制由 Worker 强制执行；写 PAT 本身仍有 poly-tally 仓库级 Contents 写能力。
- Cloudflare 管理员能修改 Worker 来读取绑定的 Secrets；这是隔离 Dot 的长期 GitHub 凭据边界，**不是绝对 secret-proof**。部署后撤销临时管理授权、退出管理会话。

## 四枚互不相同的 Secrets（仅所有者安全输入）

| Secret | 只能保存在 | 最小用途 |
|---|---|---|
| `READ_PAT` | Cloudflare Secrets | Fine-grained PAT，resource owner SiliconYC，Metadata read、Contents read；全部当前/未来仓库需选择 all repositories |
| `WRITE_PAT` | Cloudflare Secrets | 独立 fine-grained PAT，仅 poly-tally，Metadata read、Contents write、Actions write |
| `GATEWAY_PASSWORD` | Cloudflare Secret；所有者指定的本地代理口令文件 | 至少 40 个随机 ASCII 字符；建议 32 随机字节的安全编码；Dot 仅持有这一独立代理能力 |
| `GATEWAY_RECEIPT_KEY` | Cloudflare Secrets | 独立高强度 HMAC key，不给 Dot，不与任何 PAT/代理口令复用 |

所有者在官方 Dashboard 的 Secrets 输入框配置；不要把 PAT、管理 token 或代理口令发到聊天、URL、源码、日志、shell history 或命令参数。
本实现/测试只生成临时假值，不建立真实凭据。
Worker 拒绝四个值中的任何复用；客户端拒绝明显 GitHub token 前缀误填为代理口令。

代理口令持久入口是 `POLY_TALLY_GATEWAY_PASSWORD_FILE`，只保存**文件路径**在环境设置中。
该文件必须在仓库外、属于运行用户、普通非符号链接文件、权限 `0600`；父目录权限 `0700`。
所有者用安全输入流程创建并确认，不要求用户在 shell 中 `export` 真口令。
支持临时 `POLY_TALLY_GATEWAY_PASSWORD` 注入，但不能和文件入口并存。
一旦启用 gateway，`GH_TOKEN`、`GITHUB_TOKEN`、`POLY_TALLY_TOKEN` 任何键存在都会停止；不查旧 PAT 文件，不调用 credential helper。
Linux Git 子进程固定禁用 AskPass/helper/交互认证，以不可作为目录的 `/dev/null` 隔离 HOME/XDG，清除 NETRC 与继承的 Git TLS 变量，并强制证书验证；认证失败不得回退现有 `.netrc`、客户端证书或其他密码来源。

## 发布协议与 FREE 上限

1. 本机先运行既有 `projectPublicStats`、`validateSnapshotPair`，只投影允许的公开/私有脱敏字段。
2. Worker `start` 固定读取当前 tally-state 元数据，建立绑定 base commit 的签名会话。
3. 每次 `chunk` 的新内容不超过 **16 KiB、8 个历史点**；分别验证字段、数值、时间顺序、日末精度、空仓/active 历史、source/lineage 去重和完整性。
   延续状态只在 HMAC 验签后恢复；全批次完成时再次运行原有 pair/replacement 校验。
4. Worker 自己重新序列化已验证对象并增量 hash。不能签客户端原始 JSON；重复 JSON 键隐藏的文本不会进入授权字节。
   精确锁定 `@noble/hashes`，状态序列化有标准向量/随机切块对照测试；升级必须重新审计。
5. `seal` 把两个完整 blob 请求字节的 SHA256/长度绑定到**同一 pair**。最终 upload 仅接受这些精确字节，原生 WebCrypto hash 通过后才发送 GitHub，不能先上传后验签。
6. **小快照明确上限：每个最终 GitHub blob 请求体 1 MiB（包括 JSON 转义），不是通用大文件上传。**
   此路径有界缓冲；超过立即拒绝，没有增大内存/付费/跳校验回退。未来超限需要另行实现经过审计的固定脱敏块 + balanced Git-tree manifest。
7. 最多每种可见性 64 个展示仓库；签名状态最多 128 KiB，控制请求最多 256 KiB。
   控制收据在请求体中；只有小的 upload seal 放 header，不把大状态放 URL/header。
8. GitHub `force:false` 和当前 base SHA 检查保护并发；snapshot-only dispatch 前再查 current。
   已写入但 dispatch 失败的本地批次保留 `gateway-dispatch-receipt.json`（0600）。一小时能力有效期内可执行：
   `node scripts/gateway-publish.mjs retry /absolute/batch/gateway-dispatch-receipt.json`。
   超时或 superseded 明确失败；可对保留的同一脱敏批次重新校验发布，不必重新扫描源码。

2026-10-24 审计时：公开 stats 208,531B、私有 metrics 376,154B、rebuilt 362,430B、checkpoint 437,262B。
这证明当前文件规模适合预检，**不证明 FREE 的 10ms CPU 已达标**。
同一次请求的多个 `await`/流块不会重置 CPU；整轮约数分钟扫描不等于一个请求消耗数分钟 CPU。

## 旧基线迁移与回滚

不能在每次 FREE 请求中对大旧 JSON 重跑全量解析，也不能信客户端声称的旧 scope。
`node scripts/prepare-gateway-bootstrap.mjs` 在部署准备时于本机匿名读取**已经公开的脱敏** tally-state blobs，验证 Git blob SHA，执行完整旧 validator，生成 `workers/gateway/.local/bootstrap-baseline.json`。
该文件包含运行数据，只能保留在 **gitignored 的本地部署目录**；不得提交 dev、放入 PR、测试 fixture 或上传到其他位置。代码仓库只交付生成器与完全虚构的测试数据。
生产入口显式导入这个本地文件；没有经过生成/审查的文件时构建会失败，不使用空基线/合成数据回退。构建和部署包同样不得提交源码仓库。
没有 PAT/helper，也不读取源码。初始 Worker 只有在当前 private/rebuilt **全部 blob SHA 精确相符**时才接受这个紧凑基线；缺失、漂移、epoch/policy 变化均停止。

后续提交把 HMAC 认证的紧凑基线原子保存在固定 `gateway-receipt.json`；内容只有既有脱敏字段、最后点和绑定 SHA，无私有 HEAD、提交细节、文件路径或源码。
下次验证这个小收据并比对所有当前基线 SHA，保留 generatedAt/lastSuccessAt 防回退和私有 scope 不缩小规则，包括 rebuilt 基线。
真实新扫描时间可发布为新快照；不伪造日期，也不为避免数据提交而无限保持旧扫描时间。

旧 `state.mjs restore` 和 snapshot-only publisher 仍读取原格式的 root JSON；不需要 manifest 重组。
旧发布器若绕过 gateway 更新 private/rebuilt，将使签名基线失配并关闭新写入。恢复时需要明确维护操作：重新完整验证 bootstrap，受审重新部署，并由所有者授权仅移除已失效的 gateway receipt；其他数据和分支不得删除。
`GATEWAY_RECEIPT_KEY` 轮换同样需要这个明确迁移步骤，不能自动忽略坏签名或扩展信任。
回滚代码不损坏旧 root JSON；附加 receipt 是可忽略的脱敏元数据，不能用于放宽验证。

## 本地与部署准备

```sh
# 只在 dot 云端隔离环境安装常规依赖
npm ci
python -m venv .venv
.venv/bin/pip install --require-hashes -r requirements.lock
npm --prefix workers/gateway ci
npm --prefix workers/gateway test
node --test scripts/prepare-gateway-bootstrap.test.mjs
node workers/gateway/test/workerd-smoke.mjs  # 独立构建纯合成fixture；真实Git/workerd，不读生产baseline

# 只在已授权的部署准备中生成/审查本地运行基线，不能提交其内容
node scripts/prepare-gateway-bootstrap.mjs
node scripts/check-gateway-policy.mjs
npm --prefix workers/gateway run build  # 绑定本地精确SHA的生产包；dry-run only，不部署
```

`test/worker-fixture.mjs` 只用于本地合成测试，不能部署。生产 `src/index.mjs` 不接受测试基线覆盖。
克隆源码后的单元与 workerd 测试不需要运行数据；生产构建必须先执行上述显式生成步骤，缺失或 policy 不符即停止。

Dashboard 免费 Worker 名称 `poly-tally-gateway`，使用 workers.dev 域名，无需购买域名/付费服务；部署 bundle `workers/gateway/dist/index.js`，配置 `nodejs_compat` 和匹配 compatibility date，关闭请求/Invocation日志采集，不增加持久日志或 Secrets 输出。
如果所有者自己已部署并配置，只需提供 Worker 地址及安全本地代理口令入口。
若以后明确授权代部署，优先由所有者先建立空的 `poly-tally-gateway`，再创建仅针对该 **Individual Worker 的 Editor** 临时 API Token；它可部署现有 Worker 和管理该 Worker 的 Secrets。
若要求 dot 创建一个尚不存在的 Worker，才需一次 **Workers product-level Admin**，会覆盖账号内 Workers，风险更宽；应另行明确授权并完成后立即撤销。旧 `Workers Scripts Edit` 等价 product Editor，不保证能新建 Worker。
管理 token 仅经安全流程注入部署程序内存，不持久保存、不读取已有 Secrets。[Cloudflare 官方角色与权限](https://developers.cloudflare.com/workers/authorization/workers/)
当前代码准备不代表已经登录、获管理授权、配置 Secrets 或部署。

正式运行入口必须显式：`node scripts/update-local.mjs --gateway`。
无 URL/代理口令就停止，绝不回退旧 helper。旧无 gateway 模式仅为已有用户显式旧用法兼容。
`GET /health` 无认证只返回服务名和协议版本，适合无秘密连通性检查。
网络环境可能要求平台可信 egress；`requests.trust_env=False` 与隔离 Git 设置不能被 mock 测试解释为生产网络已连通。

## 必须由真实部署补齐的验收（当前未完成）

- 免费计划 CPU：真实规模及声明上限下分别测 start、最大签名 state 的 chunk、seal、upload、commit/dispatch；无 1102、足够 10ms 余量。
  本地 Node wall time/workerd 功能测试不是 Cloudflare CPU 指标。
- Owner-only 真实 Secrets 输入、独立权限确认、READ_PAT 私库 metadata + Git upload-pack、WRITE_PAT 单仓边界；不展示任何 Secret。
- 两次真实完整采集：第一轮冷/恢复缓存，第二轮同一已确认仍存在的 Git/SQLite cache；记录真实 HEAD 未变跳过、网络/解析/历史重算计数、完整性及前后页面选择 SHA/扫描时间。
- `stat`/路径/inode/大小/SQLite记录证明缓存当前存在；跨天、换执行环境后必须再次核验，不能承诺云端 scratch 永久保留。
- 较大实际 Git pack 的流式/断连行为、timeout 与失败保留旧数据；不能人为等待九分钟冒充一次冷扫描。
- 标准公开 Pages workflow 成功并部署所选快照，撤销临时管理授权。旧每日三次定时仍暂停，长期恢复另议；本次任务已授权部署后安排两次定时验收，无需再次请求普通执行确认。当前未部署故尚未安排。

## 测试隔离记录

开发红测曾意外执行一次旧入口的 `git credential fill` 路径；该测试只传假代理设置，helper 失败且无返回凭据，没有取得/打印 PAT。
修复后显式 gateway 入口先校验配置；代理测试隔离 HOME/system/global Git 配置并断言 helper 不可调用。
不能把这段开发过程描述成“从未尝试调用 helper”。所有现行测试只使用明确假值。
