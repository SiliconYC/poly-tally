# ◑ 导入
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from poly_tally.export import 公开导出_类
from poly_tally.metrics import 行统计_类
from poly_tally.private_metrics import 私有规模导出_类
from poly_tally.rules import 规则_类
from poly_tally.store import 数据库_类


# ◕ 功能
class Test私有发布_类(unittest.TestCase):
    """
    用敏感哨兵证明私有公开数据只包含规模而不是提交或源码。

    更新日志：
    2026.10.21 - 覆盖日级聚合、显式授权及混合总量。
    """

    def setUp(self) -> None:
        self.临时 = tempfile.TemporaryDirectory()
        self.addCleanup(self.临时.cleanup)
        self.目录 = Path(self.临时.name)
        self.库 = 数据库_类(self.目录)
        self.addCleanup(self.库.api_关闭)
        self.规则 = 规则_类({"include": ["**"], "exclude": [], "languages": {}, "max_blob_bytes": 2000000, "include_forks": False})
        self.现在 = datetime(2026, 10, 21, 8, 0, tzinfo=timezone.utc)
        self.私有 = {"id": "123456789", "name": "sensitive-owner/sensitive-project", "url": "https://github.com/sensitive-owner/sensitive-project", "branch": "sensitive-branch", "head": "sensitive-sha", "private": True, "status": "active", "lastSuccessAt": "2026-10-21T08:00:00Z", "rulesVersion": self.规则.版本, "historyComplete": True, "notice": "sensitive-diagnostic", "inventory": {"sensitive-file.py": {"oid": "sensitive-oid"}}, "skippedFiles": 0, "history": []}
        for 时间, 代码 in [("2026-10-19T10:13:14Z", 10), ("2026-10-19T16:17:18Z", 15), ("2026-10-20T12:13:14Z", 15), ("2026-10-21T06:17:18Z", 21)]:
            指标 = {**行统计_类.api_空指标(), "code": 代码, "files": 1}
            self.私有["history"].append({"sha": "sensitive-sha", "timestamp": 时间, "committedAt": "sensitive-committer", "authoredAt": "sensitive-author", "metrics": 指标, "languages": {"Python": 指标}})
        self.库.api_保存仓库(self.私有)

    def test_私有日级最新快照且不公开提交细节(self) -> None:
        数据 = 私有规模导出_类(self.库, self.规则).api_构建(self.现在)
        文本 = json.dumps(数据, ensure_ascii=False)
        self.assertNotIn("sensitive", 文本)
        self.assertNotIn("123456789", 文本)
        self.assertNotIn("committedAt", 文本)
        self.assertNotIn("authoredAt", 文本)
        self.assertNotIn('"sha"', 文本)
        self.assertNotIn("2026-10-19T16:17:18", 文本)
        仓库 = 数据["repositories"][0]
        self.assertEqual(仓库["visibility"], "private")
        self.assertIsNone(仓库["head"])
        self.assertIsNone(仓库["branch"])
        self.assertIsNone(仓库["url"])
        self.assertEqual([项["metrics"]["code"] for 项 in 仓库["history"]], [15, 21])
        self.assertEqual(仓库["history"][0]["timestamp"], "2026-10-19T23:59:59.999999Z")
        self.assertEqual(仓库["history"][-1]["timestamp"], "2026-10-21T08:00:00Z")

    def test_默认不公开私有而显式授权后计入总量(self) -> None:
        self.assertEqual(公开导出_类(self.库, self.规则).api_构建()["summary"]["code"], 0)
        数据 = 公开导出_类(self.库, self.规则, True).api_构建()
        self.assertEqual(数据["summary"]["code"], 21)
        self.assertEqual(数据["summary"]["privateRepositories"], 1)
        self.assertNotIn("sensitive", json.dumps(数据))

    def test_与公开仓库同口径汇总(self) -> None:
        公开 = copy.deepcopy(self.私有)
        公开.update({"id": "2", "name": "fixture/public", "private": False})
        self.库.api_保存仓库(公开)
        数据 = 公开导出_类(self.库, self.规则, True).api_构建()
        self.assertEqual(数据["summary"]["code"], 42)
        self.assertEqual(数据["summary"]["publicRepositories"], 1)
        self.assertEqual(数据["summary"]["privateRepositories"], 1)

    def test_旧规则与不可访问不混入活动总量(self) -> None:
        self.私有["rulesVersion"] = "old"
        self.库.api_保存仓库(self.私有)
        数据 = 公开导出_类(self.库, self.规则, True).api_构建()
        self.assertEqual(数据["summary"]["code"], 0)
        self.assertEqual(数据["repositories"][0]["rulesVersion"], "old")
        self.assertEqual(数据["publication"]["privateStatus"], "stale")

    def test_匿名标识稳定且只导出私有(self) -> None:
        导出器 = 私有规模导出_类(self.库, self.规则)
        原ID = 导出器.api_构建(self.现在)["repositories"][0]["id"]
        self.私有["name"] = "another-sensitive-name"
        self.私有["status"] = "cold"
        self.库.api_保存仓库(self.私有)
        仓库 = 导出器.api_构建(self.现在)["repositories"][0]
        self.assertEqual(仓库["id"], 原ID)
        self.assertEqual(仓库["status"], "cold")
        self.私有["private"] = False
        self.库.api_保存仓库(self.私有)
        self.assertEqual(导出器.api_构建(self.现在)["repositories"], [])

    def test_未来异常提交时间不会丢掉当前图表末值(self) -> None:
        self.私有["history"][-1]["timestamp"] = "2099-01-01T00:00:00Z"
        self.库.api_保存仓库(self.私有)
        数据 = 私有规模导出_类(self.库, self.规则).api_构建(self.现在)
        self.assertEqual(数据["repositories"][0]["history"][-1]["timestamp"], "2026-10-21T08:00:00Z")

    def test_仅重新导出不能伪装刷新私有采集时间(self) -> None:
        self.私有["lastSuccessAt"] = "2024-02-01T10:00:00Z"
        self.库.api_保存仓库(self.私有)
        数据 = 私有规模导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["generatedAt"], "2024-02-01T10:00:00Z")
        再导出 = 私有规模导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["generatedAt"], 再导出["generatedAt"])
