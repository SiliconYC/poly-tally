# ◑ 导入
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import requests

from poly_tally.collector import 采集器_类
from poly_tally.export import 公开导出_类
from poly_tally.lock import 运行锁_类
from poly_tally.metrics import 行统计_类
from poly_tally.rules import 规则_类
from poly_tally.store import 数据库_类


# ◕ 功能
class Test采集_类(unittest.TestCase):
    """
    验证恢复边界和公开数据白名单，禁止把故障当作删除。

    更新日志：
    2026.10.21 - 建立隐私、冷数据、范围变化与并发验证。
    """

    def setUp(self) -> None:
        self.临时 = tempfile.TemporaryDirectory()
        self.addCleanup(self.临时.cleanup)
        self.根 = Path(self.临时.name)
        self.配置 = {"owners": ["fixture"], "repositories": {"include": ["fixture/*"], "exclude": []}, "rules": {"include": ["**"], "exclude": [], "languages": {}, "max_blob_bytes": 2000000, "include_forks": False}}
        self.规则 = 规则_类(self.配置["rules"])
        self.库 = 数据库_类(self.根 / "state")
        self.addCleanup(self.库.api_关闭)
        self.状态 = {"id": "1", "name": "fixture/one", "url": "https://github.com/fixture/one", "branch": "main", "head": "a" * 40, "private": False, "status": "active", "lastSuccessAt": "2024-01-01T00:00:00Z", "rulesVersion": self.规则.版本, "historyComplete": True, "notice": "", "inventory": {"secret-file.py": {"oid": "private-oid"}}, "skippedFiles": 0, "history": [{"sha": "a" * 40, "timestamp": "2024-01-01T00:00:00Z", "committedAt": "2024-01-01T00:00:00Z", "authoredAt": "2024-01-01T00:00:00Z", "metrics": {**行统计_类.api_空指标(), "code": 3, "files": 1}, "languages": {"Python": {**行统计_类.api_空指标(), "code": 3, "files": 1}}}]}
        self.库.api_保存仓库(self.状态)

    def test_私有记录与内部路径不进入公开数据(self) -> None:
        私有 = copy.deepcopy(self.状态)
        私有.update({"id": "2", "name": "private/name", "private": True})
        self.库.api_保存仓库(私有)
        数据 = 公开导出_类(self.库, self.规则).api_构建()
        文本 = json.dumps(数据)
        self.assertNotIn("private/name", 文本)
        self.assertNotIn("secret-file", 文本)
        self.assertNotIn("private-oid", 文本)
        self.assertEqual(数据["summary"]["code"], 3)

    def test_三仓库历史回填不用发现日期(self) -> None:
        for 序号, 日期 in [(2, "2024-02-01"), (3, "2024-03-01")]:
            状态 = copy.deepcopy(self.状态)
            状态["id"] = str(序号)
            状态["name"] = f"fixture/{序号}"
            状态["history"][0]["timestamp"] = 日期 + "T00:00:00Z"
            self.库.api_保存仓库(状态)
        数据 = 公开导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["summary"]["code"], 9)
        self.assertTrue(all(仓库["history"][0]["timestamp"].startswith("2024-") for 仓库 in 数据["repositories"]))

    def test_无统计变化不重写公开文件(self) -> None:
        导出 = 公开导出_类(self.库, self.规则)
        目标 = self.根 / "stats.json"
        self.assertTrue(导出.api_写入(目标))
        原始 = 目标.read_bytes()
        self.状态["lastSuccessAt"] = "2025-01-01T00:00:00Z"
        self.库.api_保存仓库(self.状态)
        self.assertFalse(导出.api_写入(目标))
        self.assertEqual(目标.read_bytes(), 原始)

    def test_冷数据跨重启保留且旧规则不混入总量(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        采集器.api_归档("1")
        self.assertEqual(采集器.引擎.api_仓库列表()[0]["status"], "cold")
        数据 = 公开导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["summary"]["code"], 0)
        self.assertEqual(len(数据["repositories"][0]["history"]), 1)
        改规则 = copy.deepcopy(self.配置["rules"])
        改规则["exclude"] = ["*.py"]
        数据 = 公开导出_类(self.库, 规则_类(改规则)).api_构建()
        self.assertNotEqual(数据["repositories"][0]["rulesVersion"], 数据["rules"]["version"])

    def test_发现失败保留历史并报告失败(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", side_effect=requests.ConnectionError("offline")):
            运行 = 采集器.api_采集()
        状态 = 采集器.引擎.api_仓库列表()[0]
        self.assertGreater(运行["failed"], 0)
        self.assertEqual(状态["history"], self.状态["history"])
        self.assertEqual(状态["status"], "inaccessible")

    def test_列表缺失403保留不是删除(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", return_value=[]), patch.object(采集器.发现器, "api_读取仓库", side_effect=requests.HTTPError("403")):
            采集器.api_采集()
        状态 = 采集器.引擎.api_仓库列表()[0]
        self.assertEqual(状态["status"], "inaccessible")
        self.assertEqual(状态["history"], self.状态["history"])

    def test_锁阻止重复运行且退出释放(self) -> None:
        路径 = self.根 / "run.lock"
        with 运行锁_类(路径):
            with self.assertRaises(RuntimeError):
                with 运行锁_类(路径):
                    self.fail("不能重复进入")
        with 运行锁_类(路径):
            self.assertTrue(路径.exists())

    def test_检查点恢复永久冷数据(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        采集器.api_归档("1")
        检查点 = self.根 / "checkpoint.json"
        采集器.api_保存检查点(检查点)
        恢复 = 采集器_类(self.配置, self.根 / "restored", None, True)
        self.addCleanup(恢复.api_关闭)
        恢复.api_恢复检查点(检查点)
        self.assertEqual(恢复.引擎.api_仓库列表()[0]["status"], "cold")
        self.assertEqual(恢复.引擎.api_仓库列表()[0]["history"], self.状态["history"])

    def test_权威检查点覆盖旧缓存而默认恢复保留缓存(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        冷状态 = copy.deepcopy(self.状态)
        冷状态.update({"status": "cold", "notice": "durable archive"})
        检查点 = self.根 / "authoritative.json"
        检查点.write_text(json.dumps({"schemaVersion": 1, "generatedAt": "2024-01-02T00:00:00Z", "repositories": [冷状态]}))
        采集器.api_恢复检查点(检查点)
        self.assertEqual(self.库.api_读取仓库("1")["status"], "active")
        采集器.api_恢复检查点(检查点, arg_覆盖=True)
        self.assertEqual(self.库.api_读取仓库("1"), 冷状态)

    def test_后续私有记录或损坏记录不能部分写入(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        检查点 = self.根 / "bad.json"
        新状态 = copy.deepcopy(self.状态)
        新状态.update({"id": "2", "name": "fixture/two"})
        for 坏记录 in ({**self.状态, "private": True}, {**self.状态, "id": 3}, {键: 值 for 键, 值 in self.状态.items() if 键 != "history"}):
            with self.subTest(坏记录=坏记录):
                检查点.write_text(json.dumps({"schemaVersion": 1, "generatedAt": "2024-01-02T00:00:00Z", "repositories": [新状态, 坏记录]}))
                with self.assertRaises(ValueError):
                    采集器.api_恢复检查点(检查点)
                self.assertEqual(self.库.api_仓库列表(), [self.状态])

    def test_检查点数据库写入失败整体回滚(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        冷状态 = {**self.状态, "status": "cold"}
        新状态 = {**self.状态, "id": "2", "name": "fixture/two"}
        检查点 = self.根 / "rollback.json"
        检查点.write_text(json.dumps({"schemaVersion": 1, "generatedAt": "2024-01-02T00:00:00Z", "repositories": [冷状态, 新状态]}))
        with 采集器.引擎.数据库.连接:
            采集器.引擎.数据库.连接.execute("CREATE TRIGGER reject_new BEFORE INSERT ON repositories WHEN NEW.id='2' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fixture failure"):
            采集器.api_恢复检查点(检查点, arg_覆盖=True)
        self.assertEqual(self.库.api_仓库列表(), [self.状态])

    def test_冷数据转私有仍保留本地但停止公开(self) -> None:
        self.状态["status"] = "cold"
        self.库.api_保存仓库(self.状态)
        元数据 = {"id": 1, "full_name": "fixture/renamed-private", "default_branch": "main", "private": True, "archived": False, "fork": False, "clone_url": "https://github.com/fixture/renamed-private.git", "size": 1}
        采集器 = 采集器_类(self.配置, self.根 / "state", None, False)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", return_value=[元数据]):
            采集器.api_采集()
        状态 = 采集器.引擎.api_仓库列表()[0]
        self.assertEqual(状态["status"], "cold")
        self.assertTrue(状态["private"])
        self.assertEqual(状态["history"], self.状态["history"])
        self.assertEqual(公开导出_类(self.库, self.规则).api_构建()["repositories"], [])

    def test_公开列表缺失冷数据仍更新可读的可见性(self) -> None:
        self.状态["status"] = "cold"
        self.库.api_保存仓库(self.状态)
        元数据 = {"id": 1, "full_name": "fixture/renamed-private", "private": True}
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", return_value=[]), patch.object(采集器.发现器, "api_读取仓库", return_value=元数据):
            采集器.api_采集()
        self.assertEqual(公开导出_类(self.库, self.规则).api_构建()["repositories"], [])

    def test_公开检查点可移除已转私有记录以继续发布(self) -> None:
        self.状态["private"] = True
        self.库.api_保存仓库(self.状态)
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        检查点 = self.根 / "filtered.json"
        self.assertTrue(采集器.api_保存检查点(检查点, True))
        self.assertEqual(json.loads(检查点.read_text())["repositories"], [])
        self.assertEqual(len(self.库.api_仓库列表()), 1)

    def test_权威恢复不能从旧公开缓存复活已撤销的记录(self) -> None:
        私有 = copy.deepcopy(self.状态)
        私有.update({"id": "2", "private": True})
        self.库.api_保存仓库(私有)
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        检查点 = self.根 / "withdrawn.json"
        检查点.write_text(json.dumps({"schemaVersion": 1, "generatedAt": "2026-10-21T00:00:00Z", "repositories": []}))
        采集器.api_恢复检查点(检查点, True)
        self.assertEqual([项["id"] for 项 in self.库.api_仓库列表()], ["2"])
        self.assertEqual(公开导出_类(self.库, self.规则).api_构建()["repositories"], [])

    def test_旧公开检查点不能覆盖已知私有状态(self) -> None:
        检查点 = self.根 / "older-public.json"
        检查点.write_text(json.dumps({"schemaVersion": 1, "generatedAt": "2024-01-01T00:00:00Z", "repositories": [self.状态]}))
        self.状态["private"] = True
        self.库.api_保存仓库(self.状态)
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        采集器.api_恢复检查点(检查点, True)
        with patch.object(采集器.发现器, "api_发现", return_value=[]), patch.object(采集器.发现器, "api_读取仓库", side_effect=requests.HTTPError("404")):
            采集器.api_采集()
        self.assertTrue(self.库.api_仓库列表()[0]["private"])
        self.assertEqual(公开导出_类(self.库, self.规则).api_构建()["repositories"], [])

    def test_GitHub归档仓库不读取默认分支且清空统计历史(self) -> None:
        元数据 = {"id": 1, "full_name": "fixture/one", "default_branch": "main", "private": False, "archived": True, "fork": False, "clone_url": "https://github.com/fixture/one.git", "size": 1}
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", return_value=[元数据]), patch.object(采集器.发现器, "api_读取默认分支") as 分支:
            运行 = 采集器.api_采集()
        分支.assert_not_called()
        self.assertEqual(运行["repositories"], 0)
        self.assertEqual(self.库.api_读取仓库("1")["history"], [])
        数据 = 公开导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["repositories"], [])
        self.assertEqual(数据["summary"]["code"], 0)

    def test_私有已归档仓库不读取源码且只导出哈希排除证据(self) -> None:
        from poly_tally.private_metrics import 私有规模导出_类
        self.状态["private"] = True
        self.库.api_保存仓库(self.状态)
        元数据 = {"id": 1, "full_name": "fixture/one", "default_branch": "main", "private": True, "archived": True, "fork": False, "size": 1}
        采集器 = 采集器_类(self.配置, self.根 / "state", None, False, arg_仅私有=True)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", return_value=[元数据]), patch.object(采集器.发现器, "api_读取默认分支") as 分支:
            运行 = 采集器.api_采集()
        分支.assert_not_called()
        self.assertEqual(运行["repositories"], 0)
        数据 = 私有规模导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["repositories"], [])
        self.assertEqual(数据["archivedRepositoryKeys"], [私有规模导出_类.api_匿名键("1")])
        self.assertNotIn("fixture/one", json.dumps(数据))

    def test_私有转公开后归档仍按归档排除而非可见性过滤(self) -> None:
        from poly_tally.private_metrics import 私有规模导出_类
        self.状态["private"] = True
        self.库.api_保存仓库(self.状态)
        元数据 = {"id": 1, "full_name": "fixture/one", "default_branch": "main", "private": False, "archived": True, "fork": False, "size": 1}
        采集器 = 采集器_类(self.配置, self.根 / "state", None, False, arg_仅私有=True)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", return_value=[元数据]), patch.object(采集器.发现器, "api_读取默认分支") as 分支:
            采集器.api_采集()
        分支.assert_not_called()
        self.assertEqual(self.库.api_读取仓库("1")["status"], "archived")
        数据 = 私有规模导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["repositories"], [])
        self.assertEqual(数据["archivedRepositoryKeys"], [私有规模导出_类.api_匿名键("1")])

    def test_旧归档记录不进入任何公开统计(self) -> None:
        self.状态["status"] = "archived"
        self.库.api_保存仓库(self.状态)
        数据 = 公开导出_类(self.库, self.规则).api_构建()
        self.assertEqual(数据["repositories"], [])
        self.assertEqual(数据["summary"]["code"], 0)

    def test_列表缺失但直读确认已归档时不保留计数(self) -> None:
        元数据 = {"id": 1, "full_name": "fixture/one", "default_branch": "main", "private": False, "archived": True, "fork": False, "size": 1}
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True)
        self.addCleanup(采集器.api_关闭)
        with patch.object(采集器.发现器, "api_发现", return_value=[]), patch.object(采集器.发现器, "api_读取仓库", return_value=元数据):
            运行 = 采集器.api_采集()
        self.assertEqual(运行["failed"], 0)
        self.assertEqual(self.库.api_读取仓库("1")["status"], "archived")
        self.assertEqual(公开导出_类(self.库, self.规则).api_构建()["repositories"], [])

    def test_检查点只刷新运行证据不制造无数据变化写入(self) -> None:
        采集器 = 采集器_类(self.配置, self.根 / "state", None, True, arg_数据批次="fixture-v2")
        self.addCleanup(采集器.api_关闭)
        路径 = self.根 / "epoch-checkpoint.json"
        self.库.api_记录运行({"publicRun": {"failed": 0, "finishedAt": "2026-10-21T00:00:00Z", "recomputedCommits": 1}})
        self.assertTrue(采集器.api_保存检查点(路径))
        self.库.api_记录运行({"publicRun": {"failed": 0, "finishedAt": "2026-10-22T00:00:00Z", "recomputedCommits": 0}})
        self.assertFalse(采集器.api_保存检查点(路径))
