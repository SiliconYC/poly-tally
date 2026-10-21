# ◑ 导入
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile

from poly_tally.metrics import 行统计_类
from poly_tally.private_metrics import 私有规模导出_类
from poly_tally.rules import 规则_类
from poly_tally.store import 数据库_类


# ◕ 功能
class 公开导出_类:
    """
    仅发布白名单字段，不复制 inventory、源码、令牌或私有仓库记录。

    更新日志：
    2026.10.21 - 静态数据原子替换，无统计变化时默认不改文件。
    """

    字段 = ("id", "name", "url", "branch", "head", "status", "lastSuccessAt", "rulesVersion", "historyComplete", "notice", "history", "skippedFiles")

    def __init__(
        self,
        arg_数据库: 数据库_类,
        arg_规则: 规则_类,
        arg_包含私有指标: bool = False,
    ) -> None:
        self.数据库 = arg_数据库
        self.规则 = arg_规则
        self.包含私有指标 = arg_包含私有指标

    def api_构建(self) -> dict:
        仓库表 = [{键: 仓库[键] for 键 in self.字段} for 仓库 in self.数据库.api_仓库列表() if not 仓库["private"] and 仓库["status"] != "archived"]
        私有数据 = 私有规模导出_类(self.数据库, self.规则).api_构建() if self.包含私有指标 else None
        if 私有数据 is not None:
            仓库表.extend(私有数据["repositories"])
        活跃 = [仓库 for 仓库 in 仓库表 if 仓库["status"] == "active" and 仓库["rulesVersion"] == self.规则.版本 and 仓库["history"]]
        指标 = 行统计_类.api_空指标()
        for 仓库 in 活跃:
            for 键 in 指标:
                指标[键] += 仓库["history"][-1]["metrics"][键]
        # 运行摘要在采集时另存 publicRun，不能泄漏私有仓库数量和错误上下文。
        运行 = [项["publicRun"] for 项 in self.数据库.api_最近运行() if "publicRun" in 项]
        私有数 = sum("visibility" in 项 and 项["visibility"] == "private" for 项 in 活跃)
        快照数 = sum(len(仓库["history"]) for 仓库 in 活跃)
        发布信息 = {"privateRepositories": len(私有数据["repositories"]) if 私有数据 else 0, "privateUpdatedAt": 私有数据["generatedAt"] if 私有数据 else None, "privateSource": 私有数据["source"] if 私有数据 else None, "privateStatus": "stale" if 私有数据 and any(项["rulesVersion"] != self.规则.版本 or 项["status"] in {"stale", "inaccessible"} for 项 in 私有数据["repositories"]) else "available" if 私有数据 else "not-configured"}
        return {**({"datasetEpoch": self.数据库.数据批次} if getattr(self.数据库, "数据批次", None) else {}), "schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "rules": {"version": self.规则.版本, "description": "按当前默认分支第一父链与统一规则重建；代码存量，不代表个人贡献。混合行归代码；文档独立。"}, "collector": {"version": self.规则.统计器版本}, "summary": {**指标, "repositories": len(活跃), "commits": 快照数, "snapshots": 快照数, "privateRepositories": 私有数, "publicRepositories": len(活跃) - 私有数}, "repositories": 仓库表, "runs": 运行, "publication": 发布信息}

    @staticmethod
    def api_指纹(arg_数据: dict) -> str:
        副本 = json.loads(json.dumps(arg_数据))
        for 键 in ("generatedAt", "runs", "collection"):
            副本.pop(键, None)
        for 仓库 in 副本["repositories"]:
            仓库.pop("lastSuccessAt", None)
        return hashlib.sha256(json.dumps(副本, sort_keys=True).encode()).hexdigest()

    def api_写入(self, arg_目标: Path, arg_强制刷新: bool = False) -> bool:
        数据 = self.api_构建()
        if arg_目标.exists() and not arg_强制刷新:
            旧数据 = json.loads(arg_目标.read_text())
            if self.api_指纹(旧数据) == self.api_指纹(数据):
                return False
        self.api_原子写入(arg_目标, 数据)
        return True

    @staticmethod
    def api_原子写入(arg_目标: Path, arg_数据: dict) -> None:
        arg_目标.parent.mkdir(parents=True, exist_ok=True)
        临时路径: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=arg_目标.parent, suffix=".tmp", delete=False) as 文件:
                临时路径 = Path(文件.name)
                json.dump(arg_数据, 文件, ensure_ascii=False, separators=(",", ":"))
                文件.flush()
                os.fsync(文件.fileno())
            os.replace(临时路径, arg_目标)
        finally:
            if 临时路径 is not None:
                临时路径.unlink(missing_ok=True)
