# ◑ 导入
import json
import unittest
from unittest.mock import patch

import requests

from poly_tally.github import GitHub发现器_类


# ◕ 功能
class GitHub发现器测试_类(unittest.TestCase):
    """
    在 HTTP 传输边界验证发现、分页与失败传播。

    更新日志：
    2026.10.21 - 建立 GitHub 发现器契约测试。
    """

    @staticmethod
    def _响应(
        arg_数据: dict | list,
        arg_状态: int = 200,
        arg_头: dict | None = None,
    ) -> requests.Response:
        响应 = requests.Response()
        响应.status_code = arg_状态
        响应._content = json.dumps(arg_数据).encode()
        响应.headers.update(arg_头 or {})
        响应.url = "https://api.github.com/test"
        return 响应

    @staticmethod
    def _仓库(
        arg_编号: int,
        arg_全名: str,
        arg_私有: bool = False,
    ) -> dict:
        return {
            "id": arg_编号,
            "full_name": arg_全名,
            "clone_url": f"https://github.com/{arg_全名}.git",
            "default_branch": "main",
            "private": arg_私有,
            "archived": False,
            "fork": False,
            "size": 5,
            "owner": {"login": arg_全名.split("/")[0]},
        }

    def test_分页个人组织与私有仓库按稳定编号合并(self) -> None:
        旧仓库 = self._仓库(1, "Alice/old")
        新仓库 = self._仓库(1, "Alice/new")
        with patch("requests.Session.send", side_effect=[
            self._响应({"type": "User"}),
            self._响应([旧仓库], arg_头={"Link": '<https://api.github.com/users/Alice/repos?type=owner&per_page=100&page=2>; rel="next"'}),
            self._响应([self._仓库(2, "Alice/two")]),
            self._响应({"type": "Organization"}),
            self._响应([self._仓库(3, "Team/three")]),
            self._响应([新仓库, self._仓库(4, "Team/private", True)], arg_头={"Link": '<https://api.github.com/user/repos?page=2>; rel="next"'}),
            self._响应([self._仓库(5, "Outside/ignored")]),
        ]) as 发送:
            结果 = GitHub发现器_类("test-secret").api_发现(["Alice", "Team", "alice"])
        self.assertEqual([仓库["id"] for 仓库 in 结果], [1, 2, 3, 4])
        self.assertEqual(结果[0]["full_name"], "Alice/new")
        self.assertTrue(结果[3]["private"])
        地址 = [调用.args[0].url for 调用 in 发送.call_args_list]
        self.assertIn("type=owner", 地址[1])
        self.assertIn("page=2", 地址[2])
        self.assertIn("/orgs/Team/repos?", 地址[4])
        self.assertIn("type=all", 地址[4])
        self.assertIn("affiliation=owner%2Ccollaborator%2Corganization_member", 地址[5])
        self.assertEqual(发送.call_args_list[0].args[0].headers["Authorization"], "Bearer test-secret")

    def test_匿名发现不调用认证接口(self) -> None:
        with patch("requests.Session.send", side_effect=[self._响应({"type": "User"}), self._响应([])]) as 发送:
            self.assertEqual(GitHub发现器_类().api_发现(["Alice"]), [])
        self.assertEqual(发送.call_count, 2)
        self.assertNotIn("Authorization", 发送.call_args_list[0].args[0].headers)

    def test_后续分页失败不可返回部分发现结果(self) -> None:
        with patch("requests.Session.send", side_effect=[
            self._响应({"type": "User"}),
            self._响应([self._仓库(1, "Alice/one")], arg_头={"Link": '<https://api.github.com/users/Alice/repos?page=2>; rel="next"'}),
            self._响应({"message": "Not Found"}, 404),
        ]):
            with self.assertRaises(requests.HTTPError):
                GitHub发现器_类().api_发现(["Alice"])

    def test_读取元信息与编码默认分支(self) -> None:
        仓库 = self._仓库(1, "Alice/one")
        仓库["default_branch"] = "release/next"
        with patch("requests.Session.send", side_effect=[self._响应(仓库), self._响应({"commit": {"sha": "a" * 40}})]) as 发送:
            发现器 = GitHub发现器_类()
            self.assertEqual(发现器.api_读取仓库("Alice/one")["id"], 1)
            self.assertEqual(发现器.api_读取默认分支(仓库), "a" * 40)
        self.assertTrue(发送.call_args_list[1].args[0].url.endswith("/branches/release%2Fnext"))

    def test_空仓库与不可访问错误必须区分(self) -> None:
        for 大小, 状态, 期望空 in [(0, 404, False), (0, 409, False), (5, 404, False), (5, 409, False), (0, 403, False)]:
            with self.subTest(大小=大小, 状态=状态):
                仓库 = self._仓库(1, "Alice/one")
                仓库["size"] = 大小
                with patch("requests.Session.send", return_value=self._响应({"message": "unavailable"}, 状态)):
                    if 期望空:
                        self.assertIsNone(GitHub发现器_类().api_读取默认分支(仓库))
                    else:
                        with self.assertRaises(requests.HTTPError):
                            GitHub发现器_类().api_读取默认分支(仓库)

    def test_无默认分支仍需可读分支列表确认空(self) -> None:
        仓库 = self._仓库(1, "Alice/one")
        仓库["default_branch"] = None
        仓库["size"] = 0
        with patch("requests.Session.send", return_value=self._响应([])) as 发送:
            self.assertIsNone(GitHub发现器_类().api_读取默认分支(仓库))
        self.assertEqual(发送.call_count, 1)
        self.assertTrue(发送.call_args.args[0].url.endswith("/branches?per_page=1"))

    def test_空仓库需要分支列表HTTP200空数组的肯定证据(self) -> None:
        仓库 = self._仓库(1, "Alice/one", True)
        仓库["size"] = 0
        for 状态 in (404, 409):
            with self.subTest(状态=状态), patch("requests.Session.send", side_effect=[self._响应({"message": "Not Found"}, 状态), self._响应([])]) as 发送:
                self.assertIsNone(GitHub发现器_类("fixture").api_读取默认分支(仓库))
                self.assertEqual(发送.call_count, 2)
                self.assertTrue(发送.call_args.args[0].url.endswith("/branches?per_page=1"))
        for 数据 in ([{"name": "other"}], {"message": "Not Found"}):
            with self.subTest(数据=数据), patch("requests.Session.send", side_effect=[self._响应({}, 404), self._响应(数据)]):
                with self.assertRaises(requests.HTTPError):
                    GitHub发现器_类("fixture").api_读取默认分支(仓库)

    def test_默认分支缺失也不能掩盖Contents权限错误(self) -> None:
        仓库 = self._仓库(1, "Alice/one", True)
        仓库.update({"size": 0, "default_branch": None})
        with patch("requests.Session.send", return_value=self._响应({"message": "Not Found"}, 404)):
            with self.assertRaises(requests.HTTPError):
                GitHub发现器_类("fixture").api_读取默认分支(仓库)

    def test_网络错误与服务错误可有限重试(self) -> None:
        仓库 = self._仓库(1, "Alice/one")
        with patch("poly_tally.github.time.sleep"), patch("requests.Session.send", side_effect=[requests.Timeout("timeout"), self._响应({}, 502), self._响应({}, 503), self._响应(仓库)]):
            self.assertEqual(GitHub发现器_类().api_读取仓库("Alice/one")["id"], 1)
        with patch("poly_tally.github.time.sleep"), patch("requests.Session.send", return_value=self._响应({}, 503)) as 发送:
            with self.assertRaises(requests.HTTPError):
                GitHub发现器_类().api_读取仓库("Alice/one")
        self.assertEqual(发送.call_count, 4)

    def test_限流可重试而认证失败直接抛出(self) -> None:
        for 状态, 头 in [(429, {"Retry-After": "0"}), (403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "0"})]:
            with self.subTest(状态=状态), patch("poly_tally.github.time.sleep"), patch("requests.Session.send", side_effect=[self._响应({}, 状态, 头), self._响应(self._仓库(1, "Alice/one"))]):
                self.assertEqual(GitHub发现器_类().api_读取仓库("Alice/one")["id"], 1)
        with patch("requests.Session.send", return_value=self._响应({"message": "Bad credentials"}, 401)) as 发送:
            with self.assertRaises(requests.HTTPError) as 异常:
                GitHub发现器_类("test-secret").api_读取仓库("Alice/one")
        self.assertEqual(发送.call_count, 1)
        self.assertNotIn("test-secret", str(异常.exception))

    def test_长时间限流立即上抛避免违反服务器等待时间(self) -> None:
        with patch("poly_tally.github.time.sleep", side_effect=AssertionError("不应长时间阻塞")), patch("requests.Session.send", return_value=self._响应({}, 429, {"Retry-After": "3600"})) as 发送:
            with self.assertRaises(requests.HTTPError):
                GitHub发现器_类().api_读取仓库("Alice/one")
        self.assertEqual(发送.call_count, 1)

    def test_仅公开模式兼容集成令牌并过滤私有元信息(self) -> None:
        with patch("requests.Session.send", side_effect=[
            self._响应({"type": "Organization"}),
            self._响应([self._仓库(1, "Team/public"), self._仓库(2, "Team/private", True)]),
        ]) as 发送:
            结果 = GitHub发现器_类("integration-token", arg_仅公开=True).api_发现(["Team"])
        self.assertEqual([仓库["full_name"] for 仓库 in 结果], ["Team/public"])
        self.assertEqual(发送.call_count, 2)
        self.assertIn("type=public", 发送.call_args_list[1].args[0].url)

    def test_非空仓库缺失默认分支不可当作空仓库(self) -> None:
        仓库 = self._仓库(1, "Alice/one")
        仓库["default_branch"] = None
        with self.assertRaisesRegex(RuntimeError, "默认分支"):
            GitHub发现器_类().api_读取默认分支(仓库)
