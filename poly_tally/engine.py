# ◑ 导入
from datetime import datetime, timezone
from pathlib import Path

from poly_tally.git import Git对象_类
from poly_tally.metrics import 行统计_类
from poly_tally.rules import 规则_类
from poly_tally.store import 数据库_类


# ◕ 功能
class 历史引擎_类:
    """
    从当前默认分支第一父链重建快照，共同前缀之外的旧历史不再生效。

    更新日志：
    2026.10.21 - 增量树差异与独立全量回填共用同一统计契约。
    """

    def __init__(self, arg_数据目录: Path, arg_规则: 规则_类) -> None:
        self.目录 = arg_数据目录
        self.规则 = arg_规则
        self.数据库 = 数据库_类(arg_数据目录)
        self.计数 = {"parsedBlobs": 0, "cacheHits": 0, "objectReads": 0, "recomputedCommits": 0, "skippedBlobs": 0}

    def api_仓库列表(self) -> list[dict]:
        return self.数据库.api_仓库列表()

    def api_同步(
        self,
        arg_元数据: dict,
        arg_源路径: str,
        arg_HEAD: str | None = None,
        arg_离线: bool = False,
        arg_对象=None,
    ) -> dict:
        仓库ID = str(arg_元数据["id"])
        旧状态 = self.数据库.api_读取仓库(仓库ID)
        if arg_对象 is not None and arg_离线:
            raise ValueError("外部对象后端不能作为旧 Git 冷缓存使用")
        对象 = arg_对象 if arg_对象 is not None else Git对象_类(self.目录 / "objects" / f"{仓库ID}.git")
        try:
            if arg_离线:
                if 旧状态 is None or 旧状态["head"] is None:
                    raise RuntimeError("冷数据没有已采集 HEAD")
                HEAD = 旧状态["head"]
                对象.api_命令("cat-file", "-e", f"{HEAD}^{{commit}}")
            else:
                HEAD = 对象.api_更新(arg_源路径, arg_元数据["default_branch"])
            if arg_HEAD is not None and HEAD != arg_HEAD:
                raise RuntimeError("默认分支在元数据读取与 fetch 之间变化，本轮保留旧结果，下轮重试")
            状态 = self._构建状态(arg_元数据, HEAD, 旧状态)
            if arg_离线:
                状态["status"] = "cold"
                状态["lastSuccessAt"] = 旧状态["lastSuccessAt"]
                状态["notice"] = "已用保留的 Git 对象按当前规则重算冷数据；不计入当前活动总量"
            if 旧状态 and 旧状态["head"] == HEAD and 旧状态["branch"] == 状态["branch"] and 旧状态["rulesVersion"] == self.规则.版本:
                状态["history"] = 旧状态["history"]
                状态["inventory"] = 旧状态["inventory"]
                状态["skippedFiles"] = 旧状态["skippedFiles"]
                self.数据库.api_保存仓库(状态)
                return 状态
            链 = 对象.api_历史(HEAD)
            旧历史 = 旧状态["history"] if 旧状态 and 旧状态["branch"] == 状态["branch"] and 旧状态["rulesVersion"] == self.规则.版本 else []
            前缀 = 0
            while 前缀 < min(len(链), len(旧历史)) and 链[前缀]["sha"] == 旧历史[前缀]["sha"]:
                前缀 += 1
            历史 = 旧历史[:前缀]
            if 前缀 == len(链):
                # HEAD 回退只撤销后缀，重新建 inventory 以便下次增量从正确树起步。
                清单 = self._全树清单(对象, 链[-1]["sha"])
            elif 旧状态 and 前缀 == len(旧历史) and 前缀 > 0:
                清单 = 旧状态["inventory"].copy()
            elif 前缀 > 0:
                清单 = self._全树清单(对象, 链[前缀 - 1]["sha"])
            else:
                清单 = {}
            语言表 = self._语言汇总(清单)
            for 序号 in range(前缀, len(链)):
                提交 = 链[序号]
                if 序号 == 0:
                    清单 = self._全树清单(对象, 提交["sha"])
                    语言表 = self._语言汇总(清单)
                else:
                    for 路径, 模式, OID in 对象.api_变动(链[序号 - 1]["sha"], 提交["sha"]):
                        if 路径 in 清单:
                            旧项 = 清单.pop(路径)
                            self._调整语言(语言表, 旧项, -1)
                        if 模式 in {"100644", "100755"}:
                            新项 = self._解析文件(对象, 路径, OID)
                            if 新项 is not None:
                                清单[路径] = 新项
                                self._调整语言(语言表, 新项, 1)
                原时间 = datetime.fromisoformat(提交["committedAt"]).astimezone(timezone.utc)
                展示时间 = max(原时间, datetime.fromisoformat(历史[-1]["timestamp"])) if 历史 else 原时间
                快照 = {**提交, "timestamp": 展示时间.isoformat().replace("+00:00", "Z"), "metrics": 行统计_类.api_汇总(语言表), "languages": {语言: 项.copy() for 语言, 项 in sorted(语言表.items()) if 项["files"] > 0}}
                历史.append(快照)
                self.计数["recomputedCommits"] += 1
            状态["history"] = 历史
            状态["inventory"] = 清单
            状态["skippedFiles"] = sum(项["metrics"] is None for 项 in 清单.values())
            self.数据库.api_保存仓库(状态)
            return 状态
        finally:
            对象.api_关闭()

    def _构建状态(
        self,
        arg_元数据: dict,
        arg_HEAD: str,
        arg_旧状态: dict | None,
    ) -> dict:
        return {"id": str(arg_元数据["id"]), "name": arg_元数据["full_name"], "url": f"https://github.com/{arg_元数据['full_name']}", "branch": arg_元数据["default_branch"], "head": arg_HEAD, "private": arg_元数据["private"], "status": "archived" if arg_元数据["archived"] else "active", "lastSuccessAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "rulesVersion": self.规则.版本, "historyComplete": True, "notice": "", "history": [], "inventory": {}, "skippedFiles": 0}

    def _全树清单(self, arg_对象: Git对象_类, arg_SHA: str) -> dict:
        清单 = {}
        for 路径, (模式, OID) in arg_对象.api_文件树(arg_SHA).items():
            if 模式 in {"100644", "100755"}:
                项 = self._解析文件(arg_对象, 路径, OID)
                if 项 is not None:
                    清单[路径] = 项
        return 清单

    def _解析文件(
        self,
        arg_对象: Git对象_类,
        arg_路径: str,
        arg_OID: str,
    ) -> dict | None:
        语言 = self.规则.api_语言(arg_路径)
        if 语言 is None:
            return None
        # 大小上限影响文件资格，必须进入事实缓存键；路径规则在缓存外判断。
        解析版本 = f"{self.规则.统计器版本};max={self.规则.配置['max_blob_bytes']}"
        命中, 指标 = self.数据库.api_读取解析(arg_OID, 语言, 解析版本)
        if 命中:
            self.计数["cacheHits"] += 1
        else:
            内容 = arg_对象.api_读取blob(arg_OID, self.规则.配置["max_blob_bytes"])
            self.计数["objectReads"] += 1
            指标 = 行统计_类.api_解析(内容, 语言) if 内容 is not None else None
            self.计数["parsedBlobs"] += 1
            self.数据库.api_保存解析(arg_OID, 语言, 解析版本, 指标)
        if 指标 is None:
            self.计数["skippedBlobs"] += 1
        return {"oid": arg_OID, "language": 语言, "metrics": 指标}

    @staticmethod
    def _调整语言(
        arg_语言表: dict,
        arg_文件: dict,
        arg_方向: int,
    ) -> None:
        if arg_文件["metrics"] is None:
            return
        语言 = arg_文件["language"]
        if 语言 not in arg_语言表:
            arg_语言表[语言] = 行统计_类.api_空指标()
        for 键, 值 in arg_文件["metrics"].items():
            arg_语言表[语言][键] += arg_方向 * 值

    def _语言汇总(self, arg_清单: dict) -> dict:
        结果 = {}
        for 项 in arg_清单.values():
            self._调整语言(结果, 项, 1)
        return 结果

    def api_关闭(self) -> None:
        self.数据库.api_关闭()

    def api_重算冷数据(self, arg_ID: str) -> dict:
        状态 = self.数据库.api_读取仓库(arg_ID)
        if 状态 is None or 状态["status"] != "cold":
            raise ValueError("只能离线重算已确认的冷数据")
        if not (self.目录 / "objects" / f"{arg_ID}.git").exists():
            raise RuntimeError("冷数据原始对象不可用；保留原规则历史，不能伪称重算成功")
        元数据 = {"id": arg_ID, "full_name": 状态["name"], "default_branch": 状态["branch"], "private": 状态["private"], "archived": False}
        return self.api_同步(元数据, "", arg_离线=True)
