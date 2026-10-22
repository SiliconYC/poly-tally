# ◑ 导入
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from poly_tally.__main__ import 主入口
from poly_tally.collector import 采集器_类
from poly_tally.git import Git对象_类, 缓存对象_类


# ◕ 功能
class 离线重算测试_类(unittest.TestCase):
    """
    用真实 Git 引入和删除第三方目录，验证离线纠偏与失败时的数据边界。

    更新日志：
    2026.10.22 - 规则收紧和放宽均只重放缓存，不复制历史汇总或刷新授权时间。
    """

    def setUp(self) -> None:
        临时 = tempfile.TemporaryDirectory()
        self.addCleanup(临时.cleanup)
        self.根 = Path(临时.name)
        self.源 = self.根 / "source"
        self.源.mkdir()
        self._git("init", "-b", "dev")
        self._git("config", "user.email", "fixture@example.invalid")
        self._git("config", "user.name", "Fixture")
        self._提交({"src/own.cpp": "int own = 1;\n"})
        self._提交({"src/Eigen/src/Matrix.h": "int a;\nint b;\n"})
        self._提交({"src/Eigen/src/Matrix.h": None})
        self.配置 = {"owners": ["fixture"], "repositories": {"include": ["fixture/*"], "exclude": []}, "lineageGroups": [], "rules": {"include": ["**"], "exclude": [], "languages": {}, "max_blob_bytes": 2000000, "include_forks": False}}
        self.来源 = self._采集器("old", self.配置)
        元数据 = {"id": "1", "full_name": "fixture/one", "default_branch": "dev", "private": True, "archived": False}
        self.旧状态 = self.来源.引擎.api_同步(元数据, str(self.源))
        self.新配置 = copy.deepcopy(self.配置)
        self.新配置["rules"]["exclude"] = ["**/[Ee][Ii][Gg][Ee][Nn]/**"]
        self.源.rename(self.根 / "unavailable")

    def _git(self, *arg_参数: str) -> None:
        subprocess.run(["git", "-C", str(self.源), *arg_参数], check=True, capture_output=True)

    def _提交(self, arg_文件: dict[str, str | None]) -> None:
        for 路径, 内容 in arg_文件.items():
            目标 = self.源 / 路径
            if 内容 is None:
                目标.unlink()
            else:
                目标.parent.mkdir(parents=True, exist_ok=True)
                目标.write_text(内容)
        self._git("add", ".")
        self._git("commit", "-qm", "fixture")

    def _采集器(self, arg_批次: str, arg_配置: dict) -> 采集器_类:
        采集器 = 采集器_类(arg_配置, self.根 / arg_批次, None, False, arg_数据批次=arg_批次, arg_缓存目录=self.根 / "cache/private")
        self.addCleanup(采集器.api_关闭)
        return 采集器

    def test_历史纠偏不复制旧指标且放宽规则仍无需下载(self) -> None:
        self.assertEqual([项["metrics"]["code"] for 项 in self.旧状态["history"]], [1, 3, 1])
        错误状态 = copy.deepcopy(self.旧状态)
        错误状态["history"][0]["metrics"]["code"] = 999999
        self.来源.引擎.数据库.api_保存仓库(错误状态)
        目标 = self._采集器("new", self.新配置)
        with patch("socket.socket.connect", side_effect=AssertionError("禁止联网")):
            结果 = 目标.api_离线重算(self.根 / "old")
        状态 = 目标.引擎.api_仓库列表()[0]
        self.assertEqual([项["metrics"]["code"] for 项 in 状态["history"]], [1, 1, 1])
        self.assertEqual(状态["lastSuccessAt"], self.旧状态["lastSuccessAt"])
        self.assertEqual(状态["status"], "active")
        self.assertEqual(结果["fetchedRepositories"], 0)
        self.assertEqual(结果["parsedBlobs"], 0)
        self.assertEqual(结果["objectReads"], 0)
        self.assertEqual(结果["recomputedCommits"], 3)
        self.assertTrue(结果["offline"])
        self.assertFalse(结果["completeness"]["discoveryComplete"])
        self.assertFalse(结果["completeness"]["complete"])
        self.assertEqual(self.来源.引擎.api_仓库列表()[0], 错误状态)
        放宽 = self._采集器("relaxed", self.配置)
        放宽.api_离线重算(self.根 / "new")
        self.assertEqual([项["metrics"]["code"] for 项 in 放宽.引擎.api_仓库列表()[0]["history"]], [1, 3, 1])
        self.assertEqual(放宽.引擎.计数["parsedBlobs"], 0)
        with patch.object(Git对象_类, "api_更新", side_effect=AssertionError("不应 fetch")):
            元数据 = {"id": "1", "full_name": "fixture/one", "default_branch": "dev", "private": True, "archived": False}
            目标.引擎.api_同步(元数据, "", self.旧状态["head"])

    def test_缺失对象不联网补齐且不替换目标已有结果(self) -> None:
        第二仓 = {**self.旧状态, "id": "2", "name": "fixture/two"}
        self.来源.引擎.数据库.api_保存仓库(第二仓)
        目标 = self._采集器("new", self.新配置)
        目标.引擎.数据库.api_保存仓库(self.旧状态)
        with self.assertRaisesRegex((ValueError, RuntimeError), "对象"):
            目标.api_离线重算(self.根 / "old")
        self.assertEqual(目标.引擎.api_仓库列表(), [self.旧状态])
        self.assertEqual(目标.引擎.数据库.api_最近运行(), [])
        self.assertFalse((self.根 / "cache/private/objects/2.git").exists())

    def test_浅对象库拒绝伪造完整历史(self) -> None:
        对象目录 = self.根 / "cache/private/objects/1.git"
        (对象目录 / "shallow").write_text(self.旧状态["head"] + "\n")
        目标 = self._采集器("new", self.新配置)
        with self.assertRaisesRegex(RuntimeError, "浅"):
            目标.api_离线重算(self.根 / "old")
        self.assertEqual(目标.引擎.api_仓库列表(), [])

    def test_相同来源和目标被拒绝(self) -> None:
        with self.assertRaisesRegex(ValueError, "来源.*目标"):
            self.来源.api_离线重算(self.根 / "old")

    def test_排除仓库仍保留可重算HEAD且以后能离线重新纳入(self) -> None:
        配置 = copy.deepcopy(self.新配置)
        配置["repositories"]["exclude"] = ["fixture/one"]
        排除 = self._采集器("excluded", 配置)
        排除.api_离线重算(self.根 / "old")
        状态 = 排除.引擎.api_仓库列表()[0]
        self.assertEqual(状态["status"], "excluded")
        self.assertEqual(状态["head"], self.旧状态["head"])
        self.assertEqual([项["metrics"]["code"] for 项 in 状态["history"]], [1, 1, 1])
        恢复 = self._采集器("resumed", self.新配置)
        恢复.api_离线重算(self.根 / "excluded")
        self.assertEqual(恢复.引擎.api_仓库列表()[0]["status"], "active")
        self.assertEqual([项["metrics"]["code"] for 项 in 恢复.引擎.api_仓库列表()[0]["history"]], [1, 1, 1])

    def test_空共享缓存不会遮住完整旧对象库(self) -> None:
        共享路径 = self.根 / "cache/private/objects/1.git"
        旧路径 = self.根 / "old/objects/1.git"
        旧路径.parent.mkdir()
        共享路径.rename(旧路径)
        subprocess.run(["git", "init", "--bare", str(共享路径)], check=True, capture_output=True)
        目标 = self._采集器("new", self.新配置)
        目标.api_离线重算(self.根 / "old")
        self.assertEqual([项["metrics"]["code"] for 项 in 目标.引擎.api_仓库列表()[0]["history"]], [1, 1, 1])
        self.assertEqual(目标.引擎.计数["fetchedRepositories"], 0)

    def test_部分克隆缺失blob不能隐式启动远端获取(self) -> None:
        源 = self.根 / "unavailable"
        subprocess.run(["git", "-C", str(源), "config", "uploadpack.allowFilter", "true"], check=True)
        部分库 = self.根 / "partial.git"
        subprocess.run(["git", "clone", "--bare", "--filter=blob:none", "--no-local", 源.as_uri(), str(部分库)], check=True, capture_output=True)
        OID = subprocess.check_output(["git", "-C", str(源), "rev-parse", "HEAD:src/own.cpp"]).decode().strip()
        标记 = self.根 / "network-attempted"
        助手 = self.根 / "upload-pack"
        助手.write_text(f'#!/bin/sh\ntouch "{标记}"\nexit 1\n')
        助手.chmod(0o700)
        subprocess.run(["git", "--git-dir", str(部分库), "config", "remote.origin.uploadpack", str(助手)], check=True)
        对象 = 缓存对象_类(部分库, self.旧状态["head"])
        try:
            with self.assertRaises(RuntimeError):
                对象.api_读取blob(OID, 2000000)
            self.assertFalse(标记.exists(), "离线后端不应启动任何 Git 运输助手")
        finally:
            对象.api_关闭()

    def test_范围外归档记录保持归档且不要求HEAD(self) -> None:
        归档 = {**self.旧状态, "id": "2", "name": "outside/archived", "head": None, "status": "archived", "history": [], "inventory": {}}
        self.来源.引擎.数据库.api_保存仓库(归档)
        目标 = self._采集器("new", self.新配置)
        目标.api_离线重算(self.根 / "old")
        状态 = {项["id"]: 项 for 项 in 目标.引擎.api_仓库列表()}
        self.assertEqual(状态["2"]["status"], "archived")
        self.assertIsNone(状态["2"]["head"])
        self.assertEqual(状态["2"]["history"], [])

    def test_已知空仓库在排除和重新纳入后仍可离线重放(self) -> None:
        空仓库 = {**self.旧状态, "head": None, "status": "empty", "history": [], "inventory": {}}
        self.来源.引擎.数据库.api_保存仓库(空仓库)
        配置 = copy.deepcopy(self.新配置)
        配置["repositories"]["exclude"] = ["fixture/one"]
        排除 = self._采集器("excluded", 配置)
        排除.api_离线重算(self.根 / "old")
        目标 = self._采集器("new", self.新配置)
        目标.api_离线重算(self.根 / "excluded")
        self.assertEqual(目标.引擎.api_仓库列表()[0]["status"], "empty")

    def test_CLI重算不读取凭证且私有输出脱敏(self) -> None:
        配置文件 = self.根 / "config.json"
        配置文件.write_text(json.dumps({**self.新配置, "datasetEpoch": "new"}))
        输出 = self.根 / "output.json"
        参数 = ["poly_tally", "rebuild", "--from-state", str(self.根 / "old"), "--state", str(self.根 / "cli"), "--cache", str(self.根 / "cache"), "--config", str(配置文件), "--output", str(输出), "--include-private-metrics", "--report", str(self.根 / "report.json")]
        with patch.object(sys, "argv", 参数), patch("poly_tally.__main__.凭证_类.api_读取", side_effect=AssertionError("禁止读取凭证")), patch("socket.socket.connect", side_effect=AssertionError("禁止联网")):
            self.assertEqual(主入口(), 0)
        文本 = 输出.read_text()
        self.assertNotIn("src/own.cpp", 文本)
        self.assertNotIn(self.旧状态["head"], 文本)
        数据 = json.loads(文本)
        self.assertEqual(数据["repositories"][0]["history"][-1]["metrics"]["code"], 1)
        self.assertEqual(数据["publication"]["privateStatus"], "stale")
        self.assertTrue(json.loads((self.根 / "report.json").read_text())["collection"]["offline"])
