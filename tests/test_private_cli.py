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
