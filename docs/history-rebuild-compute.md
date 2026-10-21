# 历史重建计算优化：下界、实测与等价性

本次只改变计算策略，不改变源码口径、历史顺序、同源规则或发布契约。
**本地重算加速不等于首次网络抓取加速。** 冷统计基准均从空 SQLite 开始，
没有导入旧历史、旧指标或旧 blob 解析缓存。真实输入仅来自本次已完成的原始对象捕获；
synthetic 数据不是用户仓库，不可用于推算所有项目的倍数。传输、pack 与可选剪枝分析见
[历史传输成本](history-rebuild-performance.md)。

## 原瓶颈与修正

核心 `engine.py` 本来已经是首棵树 + 相邻提交文件 delta + 语言汇总调整，不是每提交
重新解析所有源码。`blob SHA + language + parser/Pygments version + max size` 事实缓存
原来就存在；SQLite 原来就按仓库保存事务，而非每个 blob 单独 fsync。不能把既有机制
包装成“新优化”。

真正的退化在 connector adapter：

1. `validate()` 对每个提交展开全文件树，并重跑每条路径的规则，约 `Σ Fᵢ` 次。
   原始 tree JSON/哈希已经按 SHA 缓存，重复的是完整路径展开和资格判断。
2. `api_变动()` 复制前后两棵完整文件清单，对全路径并集排序找变化，稳定子树也反复处理。
3. 规则对每条文件路径逐个运行 Python `fnmatch` 循环，生产规则多时常数很大。

现在：

- 原始 tree 校验继续按 SHA 去重，资格验证按 **`(tree SHA, 完整路径前缀)`** 记忆化。
  同树从 `vendor/` 移入 `src/` 必须重新判定；上下文在全部子孙验证成功后才标记完成，
  中途失败不能污染下一次重试。
- Merkle diff 遇相等子树 SHA 直接跳过，只比较变化子树的直属条目。新增/删除子树仍
  枚举受影响叶子；目录↔文件、执行位、symlink、gitlink 均保留原差分契约。
- 每个规则组用标准库 `fnmatch.translate` 编译一次，展开所有前导 `**/` 的省略形式，
  保留递归匹配的大小写、字符组、跨斜杠 `*`、Unicode 和空模式语义。硬排除、普通
  exclude、产物过滤/源码保护、include 的优先级不变。

不持久化“已验证”标志，不跳过原始 SHA 校验，不改 parser/rules 版本，不改 capture
进程，不增加凭据，不发布远端。规则实例构造后不可原地改配置，变更应新建实例。

## 理论下界

仅写 `O(C + T + B)` 不充分：树条目和源码字节不能忽略。

- `C`：第一父链提交数；`E`：所有唯一 tree 的直属条目总数。
- `S`：需校验的合格唯一 blob 原始字节总数。
- `Sᴸ`：按 `(blob, language, parser version, max size)` 去重后的解析字节数；
  同 blob 在两种语言下必须分别解析，可能大于 `S`。
- `V`：所有唯一 `(tree SHA, 路径前缀)` 上下文的直属条目总数。
- `G`：相邻提交变化 tree 对需比较的直属条目数之和；`Δ`：变化叶子总数。
- `F_head`：最终文件数；`Lᵢ`：每提交实际语言种类数。

当前“全部树均验证”的强契约下，原始校验下界 `Ω(C + E + S)`。主要工作接近
`O(C + E + S + V + G + Δ + Sᴸ + ΣLᵢ + F_head)`，另含变化叶子的稳定排序与 JSON/DB
编解码。极端扁平仓库中，每次修改均生成包含大量直属文件的新根树，`E` 本身可能达到
`C×F`，不能承诺所有历史都降到 `C + F`。

逐提交快照至少输出 `C` 条历史；最新 inventory 至少输出 `F_head` 条。若时间主要用于
首次解析很多不同的大源码，树遍历免费也不能消除解析下界。网络冷启动还受请求数、
授权 API 延迟/并发、依赖深度和字节量限制，本计算基准不能给出网络冷下载速度。

## 可复现测量

`scripts/benchmark-rebuild.py` 在独立解释器、固定内容寻址 fixture 上测三种场景：

1. `local-cold-stage`：本地原始 JSON 复制到空目录，再从空 SQLite 验证+重算。
   **不是网络冷缓存，操作系统 page cache 没有清空。**
2. `raw-present-stats-empty`：原始对象已存在，全部统计和 parser cache 为空。
3. `incremental`：先算到倒数第二提交，在新解释器加入一个提交；原始对象全部重新验证。
   报告分开列重验和增量 replay，前缀准备不计时。

输出 validation/replay/total、路径检查次数、实际 JSON 读取次数、解析/重算计数、峰值
RSS 和整个状态 canonical SHA256（仅排除墙钟 `lastSuccessAt`）。各场景状态摘要必须
相同，测量前后及场景间的源码 fingerprint 也必须相同。计时不含 fixture 生成、解释器
启动、导出和发布。`--profile-dir` 引入额外开销，只用于定位，不与普通计时混为一谈。

```bash
mkdir -p /tmp/poly-rebuild-baseline
git archive 3b8151f | tar -x -C /tmp/poly-rebuild-baseline
python scripts/benchmark-rebuild.py --fixture /tmp/poly-rebuild-fixed500 \
  --code-root /tmp/poly-rebuild-baseline --label baseline --output /tmp/baseline.json
python scripts/benchmark-rebuild.py --fixture /tmp/poly-rebuild-fixed500 \
  --code-root . --label optimized --repeats 3 --output /tmp/optimized.json
```

### 高重复 synthetic：实测超过 100×，但不推广为通用保证

默认 fixture：500 提交、2,000 稳定文件 + 1 个每提交变化文件；稳定文件分组目录，
100 个稳定 blob 被复用。唯一对象 500 commits、1,005 trees、600 blobs；合格源码
21,260 字节，raw JSON 约 5.31 MB。它特意隔离高重复历史瓶颈，不代表大源码解析。

旧版三场景各测一次，初期有其他短时测量并行，明确标为 **exploratory baseline**。
优化版在无本组并行测量窗口各测三次，下表取中位数；共享主机后台负载与 OS cache
仍未受控，不能把小数点后的波动解读成普适性能。

| 场景 | 旧版秒 | 优化中位秒 | 比值 |
| --- | ---: | ---: | ---: |
| 本地 raw 复制 + 空统计重算（非网络冷下载） | 124.702 | 0.841 | 148.3× |
| 原始对象已有，统计及解析缓存全空 | 120.798 | 0.822 | **146.9×** |
| 新增一个提交，包含全部原始对象重验 | 128.055 | 0.579 | 221.1× |

空统计优化耗时范围 0.787–0.858 秒：验证中位 0.466 秒、replay 0.313 秒；基线验证
119.558 秒、replay 1.240 秒。稳定的算法工作量证据是验证路径检查
**1,000,500 → 2,500（400.2× 少）**。tree JSON 仍各读 1,005 次，完整运行 blob JSON
仍各读 1,200 次（验证和解析分别读取），不伪称 I/O 也减少 400×。

完整重算解析 600 个 blob 上下文、生成 500 个快照；增量只解析 1 blob、重算 1 commit。
**增量 replay 本来就快**：基线 0.0327 秒、优化中位 0.0335 秒。221.1× 来自输入重验，
不是声称原增量聚合慢了两百倍。空统计峰值 RSS 46,364 → 45,544 KiB。
三条基线与九条优化测量的完整状态摘要相同。原始聚合数据：
[baseline-exploratory.json](benchmarks/baseline-exploratory.json)、
[optimized.json](benchmarks/optimized.json)。

### 本次完整真实仓库：实测 2.83×，不是 100×

冻结一个本次已完成单仓：94 提交、740 唯一 tree、601 已存 blob JSON，raw JSON
10,146,625 字节。私有副本/身份/源码不提交；各运行均空 SQLite/空解析缓存。
最终窗口无本组其他 benchmark 并行；基线一次，优化三次。

| 阶段 | 基线秒 | 优化中位秒 | 比值 |
| --- | ---: | ---: | ---: |
| 原始输入验证 | 7.809 | 0.531 | 14.71× |
| 解析、replay 与仓库保存 | 3.351 | 3.416 | 0.98× |
| 总计 | 11.160 | 3.949 | **2.83×** |

优化总耗时 3.868–3.964 秒，峰值 RSS 26,352 → 24,504 KiB。整个状态摘要完全相同，
双方均处理 601 个解析上下文（包括明确跳过项），没有用旧统计替代解析。
[聚合测量 JSON](benchmarks/real-rebuild.json) 不含私有源码、路径或 Git 提交身份。

单独 cProfile（不用于上述比值）证实优化后主要工作是 Pygments 首次源码词法解析，
树差分已非瓶颈。所以不能拿 synthetic 的 146.9× 冒充所有真实项目的收益。

## 正确性防线

- 12 提交 × 201 文件的验证路径检查从 2,412 降到 212；CI 检查工作量而非易抖动墙钟。
- Merkle 差分对照完整清单 oracle，再与真实 Git 引擎逐提交相等；含目录↔文件替换、
  执行位、Unicode/tab 路径、改名引发语言变化。独立审查另跑 150 组随机树差分逐值一致。
- 继续覆盖默认分支切换、HEAD 回退/分叉、第一父合并、非单调时间、源码硬排除、
  跨仓库共享树、私有同源折叠及脱敏。缺失/损坏 excluded 子树仍失败，不悄悄弱化契约。
- 失败验证重复调用仍失败，补齐真实缺失对象才成功。
- matcher 对照旧递归 fnmatchcase：特殊模式矩阵、固定 seed 4,000 路径 × 4 组生产规则。
- CLI 小 fixture 自动证明三种缓存场景输出相同，增量只 parse 1/recompute 1。

## 长期 Native Git 路线与下一步边界

长期 Git 后端不是每个 blob 启一个进程：`Git对象_类.api_读取blob()` 首次读取时启动
一个持久 **`git cat-file --batch`** 管道，此后复用；超限 blob 分块排空管道。它也已经
用 Git 的 `diff-tree` 做相邻树差分，享受 Git 自身的 Merkle 优化，所以 connector 的
全树退化不应套到 native Git 上。普通路径目前确实每对提交启动一次 `diff-tree`；
后续可有界研究 `diff-tree --stdin` 批处理省进程启动，但须保持 merge/第一父/回退输出
等价，并先 profile，不承诺源码解析主导场景能再快百倍。编译规则优化两条路径都受益。

未来可单独测“清聚合、保留经版本证明的解析事实”，但这是暖解析缓存场景，不能冒充
本轮从零重建；任何 parser/Pygments/language/size 语义变化都须失效。

原始对象应保存在**受保护、可持久、可备份**的私有介质，和统计/公开导出分层；当前
临时云目录不是永久存储保证。不得把私有源码 pack 推到 public poly-tally 仓库、公开
artifact 或日志。本轮没有执行迁移/上传，也不把旧批次数据复活。只缓存当时合格 blob
时，未来规则放宽可能需要重新获取缺失内容；源已不可得则应明确不完整。

目录剪枝是另一个契约：仅普通 exclude 的 `Q + '/**'`，若目录完整路径 `D` 匹配 `Q`，
则任意后代 `D + '/' + s` 必匹配整个模式，且不能被 include/source_preserve 救回。
这是严格前缀证明而非哨兵采样；其他形状不剪。若未来启用，应记录父 tree 校验、被省略
子树 SHA 引用和规则证明，同时明确未验证被省略原始字节；本轮强校验契约未改变。
