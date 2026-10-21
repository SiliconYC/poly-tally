# 统一收录与屏蔽规则

统计对象是源码与文档。2026-10-21 起按用户新要求：**JSON、JSONC、YAML（含 YML）、XML 整类不再收录**，无论内容看似配置、静态注册表、测试 fixture 还是机器数据。不读这些 blob，不计任何行，也不计文件数。

## 配置与优先级

[config.json](../config.json) 的可审查规则为：

```json
{
  "exclude_extensions": [".json", ".jsonc", ".yaml", ".yml", ".xml"],
  "exclude_languages": ["JSON", "YAML", "XML"]
}
```

这些是 `rules` 内的字段，不是文件删除命令。项目自己的 `config.json`、依赖清单、工作流 YAML 和源仓库文件均继续存在，只是不进入规模统计。

1. **硬排除扩展名与语言类别最先执行**，大小写不敏感。JSONC 的默认类别为 JSON，YML 为 YAML；XML 类别也覆盖 SVG。自定义后缀映射为 JSON/YAML/XML 同样排除。
2. 默认类别与显式映射类别都参与硬排除，不能通过把 `.json`/`.svg` 重映射成 Python/Markdown 救回数据文件。
3. 再执行常规 `exclude`、有歧义的 `artifact_exclude`、`source_preserve` 及 `include`。`source_preserve=["**"]` 或显式 `include` 均不能覆盖硬排除。因此 `src/registry.JSON`、`tests/fixture.jsonc`、`package.json` 和 `.github/workflows/ci.YML` 都不纳入。
4. 只对剩余候选读取内容、计数。源码 Python/TypeScript/C++、HTML/CSS 和 Markdown 等原有文档规则不受本次数据类别排除影响。

没有内容识别例外，也不根据文件大小、字段名或“手写/生成”判断是否把四类数据救回。JSON 格式的配置、静态注册、关卡、词典及测试数据一律执行同一规则。

## 其他原有屏蔽仍保留

`.gitignore` 不能改变历史 Git 树中的已跟踪文件，因此统计规则独立于各源仓库 `.gitignore`。所有公开、私有仓库使用同一口径：

- 依赖、构建、缓存、工具状态、临时文件、压缩输出、lock 文件：按 `rules.exclude` 排除。
- 日志/结果目录和报告名称等歧义规则：由 `artifact_exclude` 过滤，源码和手写文档上下文可由 `source_preserve` 保护，但不能覆盖上述硬排除。
- 仍被纳入的代码/文档：继续排除明确生成器头、React 分发头、Sphinx 导航特征及重复运行日志。普通源码字符串、日志教程等不因此误删。
- Git LFS 指针、symlink、submodule、二进制、非 UTF-8 与超限 blob 不纳入；不下载 LFS、不递归 submodule。

低层词法器保留通用解析能力，但**任何采集后端必须先调用 `规则_类.api_语言(path)`，再读 blob**。不能直接调用词法器绕过配置；新 connector 入口也必须共用此边界。旧 JSON 内容识别模块不能恢复已被路径/类别硬排除的文件。

## 重新计算与数据清零

新批次为 `source-only-lineage-2026-10-21-v1`。规则摘要包含新增配置，旧规则 hash 不再相同。全量重算必须从新状态读取当前默认分支历史，不混入任何旧 epoch 检查点、对象/解析缓存或 retained 私有规模。

当前活动 `web/data/stats.json` 已重置为**尚未采集的空基线**：`repositories=[]`、`completeness.complete=false`、`privateStatus=pending-rebuild`。空基线的零不是已验证的真实规模；旧活动 private/retained 统计文件撤下，Git 历史仍可恢复。没有删除任何源仓库文件或项目配置。

完整性、同源组严格主导、隐私及新鲜 metadata 范围核验见 [同源组与严格重算](lineage.md)。现有授权 connector 或本地授权都可计算，不要求新建 Key；只有实际完成、通过验证的新结果才能替换 pending 基线。

## 回归证据

测试覆盖大小写、YAML 别名、SVG/XML 等价类别、自定义语言映射、包含规则与源码保护不能救回、普通源码/Markdown 不受影响。真实 Git 测试在全树和增量中确认：仅数据文件变化不改变代码/注释/文档/文件数，不增加 blob 读取次数；独立全量结果与增量相同。
