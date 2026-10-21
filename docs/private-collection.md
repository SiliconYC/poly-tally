# 私有仓库采集与公开规模

## 已生效的边界

私有仓库与公开仓库使用相同规则、当前默认分支和第一父历史计算。发布阶段只保留匿名仓库标识、按日规模、语言汇总、状态及采集时间。

公开的 `private-metrics.json` 不含真实私有仓库名、链接、分支、HEAD、SHA、作者、提交消息、原始 author/committer 时间、文件路径或源码。每天取最后一个有效树的规模；历史日期显示 UTC 日末，当天显示采集时间。相邻日期完全相同的规模可省略。页面中的私有规模点不是提交数量。

完整逐提交事实、SQLite 和 Git 对象仍在本地 `.poly-tally/`，不要提交该目录。仅公开 LOC 趋势不会使原私有仓库变为公开。

## 本地更新，无需创建新 Key

如果本机 Git 已经能够访问全部目标仓库，可以显式复用 credential helper：

```bash
source .venv/bin/activate
python -m poly_tally collect --git-credential --include-private-metrics --private-metrics-output .poly-tally/private-metrics.json --output .poly-tally/combined-stats.json --refresh
```

令牌只经过内存与 Git 子进程环境；不会写入配置、URL、SQLite 或公开文件。默认不读 credential helper；不带 `--public-only` 的采集在缺少凭证时明确失败，不再默默降级到开源仓库。

只想更新私有范围时追加 `--private-only`。`export` 可以用已有本地事实重新导出，无需联网；规则变更应运行 `collect` 以重新计算历史。

发布只上传脱敏快照到本项目的数据分支：

```bash
export GITHUB_REPOSITORY=SiliconYC/poly-tally
node scripts/state.mjs save-private .poly-tally/private-metrics.json --git-credential
```

发布入口会严格检查匿名标识、字段、日期、语言与数值，拒绝包含 Git 提交字段、文件清单、额外字段或失败仓库的新私有快照。随后在 [Actions](https://github.com/SiliconYC/poly-tally/actions/workflows/pages.yml) 手动运行 Pages 工作流，即可重新部署。这里只写本项目的 `tally-state`，不会对被统计仓库写入。

## 持续云端自动更新

Codex 或本机 Git 的仓库授权与 GitHub Actions 的授权是两回事。Actions 默认的 `GITHUB_TOKEN` 不能因此读取其他私有仓库，需要额外的只读凭证。参见 [GitHub 的认证说明](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)。

当前没有把本机宽权限令牌复制到云端。若尚未配置下文 Secret，公开仓库继续定时更新，私有部分保留最近收到的脱敏快照。页面分别显示私有更新时间，不把新的公开扫描时间当作私有已更新。

### 创建最小权限令牌

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

私有计算作业只运行于定时、手动或 `dev` 推送，不向 PR 分发 Secret。私有对象与 SQLite 不进入公开仓库的 Actions cache 或 artifact，作业结束时清理临时状态；只有经过字段白名单检查的日级规模可以上传。未配置安全的私有持久化服务前，云端私有作业每轮完整回填，因此会比本地增量慢；本地保留对象缓存，可增量处理。

## 恢复与规则变化

公开工作流从 `tally-state` 恢复最新脱敏私有快照，无 Secret 时仍可展示。云端采集失败不替换上一版私有快照，页面保留其独立采集时间。

发布会拒绝采集时间倒退、同仓库成功时间倒退，以及未经证实的私有范围缩小，防止旧本地状态或权限撤回覆盖更新、更完整的数据。正常的新扫描 LOC 下降不受限制。私有转公开可由本轮公开扫描证实并去重。

规则版本不一致的私有历史保留但不混入当前总量，需要下一次有授权的成功采集才能重算。私有转公开时使用稳定匿名键去重，避免旧私有快照与新公开记录双重计入。

需要重新计算私有历史时，必须拥有本地 SQLite 与对象缓存，或仍能读取源仓库；只有日级公开快照无法反推出逐提交事实。备份方法沿用 [README](../README.md) 中的 SQLite 与对象目录备份。
