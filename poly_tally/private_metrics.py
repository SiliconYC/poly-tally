# ◑ 导入
from datetime import (
    datetime,
    time,
    timezone,
)
import hashlib
import os

from poly_tally.metrics import 行统计_类
from poly_tally.rules import 规则_类
from poly_tally.store import 数据库_类


# ◕ 功能
class 私有规模导出_类:
    """
    把私有逐提交事实降为日级规模，公开授权展示的仓库名，不导出文件路径或提交元数据。

    更新日志：
    2026.10.21 - 用户授权公开私有 LOC；完整计算状态仍只保留在受保护环境。
    2026.10.21 - 依用户要求恢复真实仓库名，沿用稳定标识与原始采集时间。
    """

    公开说明 = "私有仓库：仅公开按日规模，不公开源码与提交详情。"

    def __init__(self, arg_数据库: 数据库_类, arg_规则: 规则_类) -> None:
        self.数据库 = arg_数据库
        self.规则 = arg_规则

    @staticmethod
    def api_匿名键(arg_ID: str) -> str:
        return hashlib.sha256(f"poly-tally/repository/{arg_ID}".encode()).hexdigest()[:16]

    def api_构建(self, arg_时间: datetime | None = None) -> dict:
        现在 = (arg_时间 or datetime.now(timezone.utc)).astimezone(timezone.utc)
        私有表 = [项 for 项 in self.数据库.api_仓库列表() if 项["private"]]
        归档键 = sorted(self.api_匿名键(项["id"]) for 项 in 私有表 if 项["status"] == "archived")
        仓库表 = [项 for 项 in 私有表 if 项["status"] != "archived"]
        成功时间 = [datetime.fromisoformat(项["lastSuccessAt"]).astimezone(timezone.utc) for 项 in 仓库表 if 项["lastSuccessAt"] is not None]
        if arg_时间 is None and 成功时间:
            # 导出不是采集；仅重新发布不能把旧的私有事实伪装成今天刚扫描。
            现在 = min(现在, max(成功时间))
        结果 = []
        for 仓库 in 仓库表:
            匿名键 = self.api_匿名键(仓库["id"])
            日表 = {}
            for 快照 in 仓库["history"]:
                # Git 的未来时间戳不能让当前规模落在图表可见范围之外。
                日期 = min(datetime.fromisoformat(快照["timestamp"]).astimezone(timezone.utc).date(), 现在.date())
                指标 = {键: 快照["metrics"][键] for 键 in 行统计_类.api_空指标()}
                语言表 = {语言: {键: 值[键] for 键 in 行统计_类.api_空指标()} for 语言, 值 in 快照["languages"].items()}
                展示时间 = min(datetime.combine(日期, time.max, tzinfo=timezone.utc), 现在)
                日表[日期] = {"timestamp": 展示时间.isoformat().replace("+00:00", "Z"), "metrics": 指标, "languages": 语言表}
            历史 = []
            for 日期 in sorted(日表):
                项 = 日表[日期]
                if not 历史 or 项["metrics"] != 历史[-1]["metrics"] or 项["languages"] != 历史[-1]["languages"]:
                    历史.append(项)
            结果.append({"id": f"private-{匿名键}", "sourceKey": 匿名键, "name": 仓库["name"], "url": None, "branch": None, "head": None, "visibility": "private", "snapshotKind": "daily", "status": 仓库["status"], "lastSuccessAt": 仓库["lastSuccessAt"], "rulesVersion": 仓库["rulesVersion"], "historyComplete": 仓库["historyComplete"], "notice": self.公开说明, "history": 历史, "skippedFiles": 仓库["skippedFiles"]})
        来源 = "github-actions" if os.environ.get("GITHUB_ACTIONS") == "true" else "local"
        return {**({"datasetEpoch": self.数据库.数据批次} if getattr(self.数据库, "数据批次", None) else {}), "schemaVersion": 1, "archivedRepositoryKeys": 归档键, "generatedAt": 现在.isoformat().replace("+00:00", "Z"), "rulesVersion": self.规则.版本, "source": 来源, "collection": {"repositories": len(结果), "failed": sum(项["status"] in {"stale", "inaccessible"} for 项 in 结果)}, "repositories": 结果}
