# ◑ 导入
import argparse
import hashlib
import json
from pathlib import Path
import resource
import sqlite3
import tempfile
import time

from poly_tally.engine import 历史引擎_类
from poly_tally.export import 公开导出_类
from poly_tally.git import Git对象_类
from poly_tally.lock import 运行锁_类
from poly_tally.rules import 规则_类


# ◕ 功能
class 固定对象_类(Git对象_类):
    """
    只用已经采集的固定 HEAD 重放，禁止访问源站或改变 refs。

    更新日志：
    2026.10.22 - 用真实原生对象验证空统计重算与已有逐提交事实一致。
    """

    def __init__(self, arg_路径: Path, arg_HEAD: str) -> None:
        if not arg_路径.is_dir():
            raise ValueError("原始 Git 对象目录不存在")
        super().__init__(arg_路径)
        self.固定HEAD = arg_HEAD

    def api_更新(self, arg_源: str, arg_分支: str) -> str:
        self.api_命令("cat-file", "-e", f"{self.固定HEAD}^{{commit}}")
        return self.固定HEAD


class 原生重算基准_类:
    """
    从空派生状态重放完整固定输入，公开报告不含私有提交标识与文件路径。

    更新日志：
    2026.10.22 - 单独测量保留对象和解析事实后的历史重建成本。
    """

    @staticmethod
    def api_指纹(arg_仓库表: list[dict]) -> str:
        规范 = [{键: 值 for 键, 值 in 项.items() if 键 != "lastSuccessAt"} for 项 in arg_仓库表]
        return hashlib.sha256(json.dumps(规范, sort_keys=True, ensure_ascii=True).encode()).hexdigest()

    @staticmethod
    def api_运行(
        arg_状态目录: Path,
        arg_缓存目录: Path,
        arg_配置: dict,
    ) -> dict:
        开始 = time.perf_counter()
        with 运行锁_类(arg_缓存目录 / "run.lock"), 运行锁_类(arg_状态目录 / "run.lock"):
            with sqlite3.connect(f"file:{arg_状态目录.resolve() / 'stats.sqlite'}?mode=ro", uri=True) as 数据库:
                仓库表 = [json.loads(行[0]) for 行 in 数据库.execute("SELECT state FROM repositories ORDER BY id")]
            with tempfile.TemporaryDirectory(prefix="poly-tally-replay-") as 临时目录:
                引擎 = 历史引擎_类(Path(临时目录), 规则_类(arg_配置["rules"]), arg_缓存目录)
                try:
                    for 仓库 in 仓库表:
                        if 仓库["head"] is None:
                            引擎.数据库.api_保存仓库(仓库)
                            continue
                        if 仓库["status"] != "active" or not 仓库["historyComplete"]:
                            raise ValueError("基准只接受完整的活动仓库事实")
                        元数据 = {"id": 仓库["id"], "full_name": 仓库["name"], "default_branch": 仓库["branch"], "private": 仓库["private"], "archived": False}
                        对象 = 固定对象_类(arg_缓存目录 / "objects" / f"{仓库['id']}.git", 仓库["head"])
                        引擎.api_同步(元数据, "", 仓库["head"], arg_对象=对象)
                    重建表 = 引擎.api_仓库列表()
                    一致 = 原生重算基准_类.api_指纹(仓库表) == 原生重算基准_类.api_指纹(重建表)
                    if not 一致:
                        raise ValueError("逐提交历史或文件清单重算不一致")
                    return {"scenario": "fixed-input-raw-and-parser-present-stats-empty", "equivalent": 一致, "outputSha256": 原生重算基准_类.api_指纹(重建表), "repositories": len(仓库表), "commits": sum(len(项["history"]) for 项 in 仓库表), "durationSeconds": round(time.perf_counter() - 开始, 6), "peakRssPlatformUnits": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "counters": 引擎.计数, "phases": 引擎.阶段耗时, "networkRequests": 0}
                finally:
                    引擎.api_关闭()


# ◍ 运行
if __name__ == "__main__":
    参数器 = argparse.ArgumentParser(description="使用已采集原生对象离线验证完整历史重算")
    参数器.add_argument("--state", type=Path, required=True, help="包含 stats.sqlite 的批次目录")
    参数器.add_argument("--cache", type=Path, required=True, help="包含 objects 和 parser.sqlite 的范围目录")
    参数器.add_argument("--config", type=Path, default=Path("config.json"))
    参数器.add_argument("--output", type=Path, required=True)
    参数 = 参数器.parse_args()
    报告 = 原生重算基准_类.api_运行(参数.state, 参数.cache, json.loads(参数.config.read_text()))
    公开导出_类.api_原子写入(参数.output, 报告)
    print("[完成] " + json.dumps(报告, ensure_ascii=False))
