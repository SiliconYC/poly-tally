# ◑ 导入
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from poly_tally.__main__ import 主入口
from poly_tally.collector import 采集器_类
from poly_tally.credentials import 凭证_类


# ◕ 功能
class Test私有入口_类(unittest.TestCase):
    """
    私有采集不得因缺少凭证静默降级为公开范围。

    更新日志：
    2026.10.21 - 建立无凭证失败和仅私有范围验证。
    """

    def test_未授权Githelper时不读取其令牌(self) -> None:
        with patch.dict("os.environ", {}, clear=True), patch("subprocess.run") as 执行:
            self.assertIsNone(凭证_类.api_读取(False))
            执行.assert_not_called()

    def test_显式选择Githelper时使用内存凭证(self) -> None:
        from subprocess import CompletedProcess
        with patch.dict("os.environ", {}, clear=True), patch("subprocess.run", return_value=CompletedProcess([], 0, "protocol=https\nhost=github.com\npassword=sensitive-token\n", "")):
            self.assertEqual(凭证_类.api_读取(True), "sensitive-token")

    def test_没有私有凭证时必须明确报错(self) -> None:
        with tempfile.TemporaryDirectory() as 目录, patch.dict("os.environ", {}, clear=True), patch("sys.argv", ["poly_tally", "collect", "--private-only", "--state", str(Path(目录) / "state")]):
            with self.assertRaisesRegex(ValueError, "凭证"):
                主入口()

    def test_仅私有模式不扫描公开仓库(self) -> None:
        配置 = {"owners": ["fixture"], "repositories": {"include": ["fixture/*"], "exclude": []}, "rules": {"include": ["**"], "exclude": [], "languages": {}, "max_blob_bytes": 2000000, "include_forks": False}}
        公共 = {"id": 1, "full_name": "fixture/public", "default_branch": None, "private": False, "archived": False, "fork": False, "clone_url": "https://github.com/fixture/public.git", "size": 0}
        私有 = {**公共, "id": 2, "full_name": "fixture/private", "private": True}
        with tempfile.TemporaryDirectory() as 目录:
            采集器 = 采集器_类(配置, Path(目录), "fixture-token", False, True)
            self.addCleanup(采集器.api_关闭)
            with patch.object(采集器.发现器, "api_发现", return_value=[公共, 私有]), patch.object(采集器.发现器, "api_读取默认分支", return_value=None) as 默认分支:
                采集器.api_采集()
            self.assertEqual([项["id"] for 项 in 采集器.引擎.api_仓库列表()], ["2"])
            self.assertEqual(默认分支.call_count, 1)

    def test_新批次隔离旧状态且拒绝旧检查点(self) -> None:
        import json
        from poly_tally.store import 数据库_类
        from poly_tally.github import GitHub发现器_类
        with tempfile.TemporaryDirectory() as 目录:
            根 = Path(目录)
            旧库 = 数据库_类(根 / "state")
            旧库.api_保存仓库({"id": "old-baggage"})
            旧库.api_关闭()
            参数 = ["poly_tally", "collect", "--public-only", "--dataset-epoch", "reset-test-v2", "--state", str(根 / "state"), "--output", str(根 / "stats.json"), "--checkpoint", str(根 / "checkpoint.json")]
            with patch("sys.argv", 参数), patch.object(GitHub发现器_类, "api_发现", return_value=[]):
                self.assertEqual(主入口(), 0)
            数据 = json.loads((根 / "stats.json").read_text())
            self.assertEqual(数据["datasetEpoch"], "reset-test-v2")
            self.assertEqual(数据["repositories"], [])
            检查点 = json.loads((根 / "checkpoint.json").read_text())
            self.assertEqual(检查点["datasetEpoch"], "reset-test-v2")
            self.assertEqual(检查点["collection"]["failed"], 0)
            检查点.pop("datasetEpoch")
            (根 / "old.json").write_text(json.dumps(检查点))
            with patch("sys.argv", 参数 + ["--import-checkpoint", str(根 / "old.json")]):
                with self.assertRaisesRegex(ValueError, "批次"):
                    主入口()
            旧库 = 数据库_类(根 / "state")
            self.addCleanup(旧库.api_关闭)
            self.assertEqual(旧库.api_仓库列表(), [{"id": "old-baggage"}])
