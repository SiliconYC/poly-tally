# ◑ 导入
from datetime import datetime, timezone
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from typing import TYPE_CHECKING

from poly_tally.engine import 历史引擎_类
from poly_tally.git import 缓存对象_类
from poly_tally.lock import 运行锁_类

if TYPE_CHECKING:
    from poly_tally.collector import 采集器_类


# ◕ 功能
class 离线重算器_类:
    """
    从本地已知仓库身份和 HEAD 重放新口径，全部成功才切换目标派生统计。

    更新日志：
    2026.10.22 - 复用原始对象与解析事实，保留采集时间且不宣称新鲜授权。
    """

    def __init__(self, arg_采集器: "采集器_类") -> None:
        self.采集器 = arg_采集器
        self.目标 = arg_采集器.引擎

    def api_运行(self, arg_来源目录: Path) -> dict:
        if arg_来源目录.resolve() == self.目标.目录.resolve():
            raise ValueError("离线重算的来源与目标必须使用不同状态目录或批次")
        来源文件 = arg_来源目录.resolve() / "stats.sqlite"
        if not 来源文件.is_file():
            raise ValueError("来源 stats.sqlite 不存在；离线重算需要已保存的仓库身份与 HEAD")
        开始 = time.perf_counter()
        with 运行锁_类(arg_来源目录 / "run.lock"):
            with closing(sqlite3.connect(f"{来源文件.as_uri()}?mode=ro", uri=True)) as 来源库:
                来源表 = [json.loads(行[0]) for 行 in 来源库.execute("SELECT state FROM repositories ORDER BY id")]
            if not 来源表:
                raise ValueError("来源没有已采集仓库，不能把空缓存作为重算结果")
            缓存目录 = self.目标.对象目录.parent
            with tempfile.TemporaryDirectory(prefix="rebuild-", dir=self.目标.目录) as 暂存目录:
                暂存 = 历史引擎_类(Path(暂存目录), self.采集器.规则, 缓存目录)
                try:
                    公开计数 = {键: 0 for 键 in 暂存.计数}
                    for 来源 in 来源表:
                        if self.采集器.仅公开 and 来源["private"]:
                            continue
                        是成员 = 来源["name"].casefold() in self.采集器.成员名称
                        if self.采集器.仅私有 and not 来源["private"] and not 是成员:
                            continue
                        基线 = 暂存.计数.copy()
                        重建 = self._重放仓库(暂存, 来源, 是成员, arg_来源目录)
                        暂存.数据库.api_保存仓库(重建)
                        if not 来源["private"]:
                            for 键 in 公开计数:
                                公开计数[键] += 暂存.计数[键] - 基线[键]
                    重建表 = 暂存.api_仓库列表()
                    if not 重建表:
                        raise ValueError("来源没有符合当前公开/私有范围的仓库")
                    完整性 = {"complete": False, "discoveryComplete": False, "expectedRepositories": len(重建表), "scannedRepositories": len(重建表), "missingMembers": len(self.采集器.成员名称 - {项["name"].casefold() for 项 in 重建表}), "failed": 0}
                    公共完整性 = {**完整性, "expectedRepositories": sum(not 项["private"] for 项 in 重建表), "scannedRepositories": sum(not 项["private"] for 项 in 重建表), "missingMembers": 0}
                    公共运行 = {"finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "durationSeconds": round(time.perf_counter() - 开始, 3), "repositories": 公共完整性["scannedRepositories"], "failed": 0, "offline": True, **公开计数, "completeness": 公共完整性}
                    运行 = {**公共运行, "repositories": len(重建表), **暂存.计数, "completeness": 完整性, "publicRun": 公共运行, "phases": 暂存.阶段耗时}
                    # 旧汇总与运行完整性不能进入新批次；只发布本次全部成功的重放结果。
                    with self.目标.数据库.连接:
                        self.目标.数据库.连接.execute("DELETE FROM repositories")
                        self.目标.数据库.连接.executemany("INSERT INTO repositories VALUES(?,?)", [(项["id"], json.dumps(项, ensure_ascii=False)) for 项 in 重建表])
                        self.目标.数据库.连接.execute("DELETE FROM runs")
                        self.目标.数据库.连接.execute("INSERT INTO runs(data) VALUES(?)", (json.dumps(运行),))
                    self.目标.计数.update(暂存.计数)
                    self.目标.阶段耗时.update(暂存.阶段耗时)
                    return 运行
                finally:
                    暂存.api_关闭()

    def _重放仓库(
        self,
        arg_暂存: 历史引擎_类,
        arg_来源: dict,
        arg_是成员: bool,
        arg_来源目录: Path,
    ) -> dict:
        元数据 = {"id": arg_来源["id"], "full_name": arg_来源["name"], "default_branch": arg_来源["branch"], "private": arg_来源["private"], "archived": False}
        # 只复制身份、观察时间与运维状态，旧 history/inventory 不参与任何计算。
        状态 = self.采集器._空状态(元数据)
        状态.update({"status": arg_来源["status"], "lastSuccessAt": arg_来源["lastSuccessAt"]})
        if 状态["status"] == "archived":
            return 状态
        if not arg_是成员 and not self.采集器._名称在范围(arg_来源["name"]):
            状态["status"] = "excluded"
        elif 状态["status"] == "excluded":
            状态["status"] = "active"
        if not arg_来源["historyComplete"]:
            raise ValueError("来源历史不完整，不能离线重算完整历史")
        if arg_来源["head"] is None:
            if arg_来源["status"] != "empty" and not (arg_来源["status"] == "excluded" and not arg_来源["history"] and not arg_来源["inventory"]):
                raise ValueError("非空仓库缺少已采集 HEAD，不能离线重算")
            if 状态["status"] == "active":
                状态["status"] = "empty"
            return 状态
        对象路径 = arg_暂存.对象目录 / f"{arg_来源['id']}.git"
        对象 = 缓存对象_类(对象路径, arg_来源["head"], arg_来源目录 / "objects" / f"{arg_来源['id']}.git")
        重建 = arg_暂存.api_同步(元数据, "", arg_来源["head"], arg_对象=对象)
        重建.update({"status": 状态["status"], "lastSuccessAt": 状态["lastSuccessAt"], "notice": "已按当前规则离线重算已采集 HEAD；尚未重新核对源站授权与默认分支"})
        return 重建
