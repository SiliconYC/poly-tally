# ◑ 导入
import time
from urllib.parse import quote, urlsplit

import requests


# ◕ 功能
class GitHub发现器_类:
    """
    只读发现账号可见仓库，保留 GitHub 稳定编号与原始元信息。

    更新日志：
    2026.10.21 - 建立分页发现、私有仓库补全与有限重试。
    """

    def __init__(self, arg_令牌: str | None = None, arg_仅公开: bool = False) -> None:
        self.会话 = requests.Session()
        self.会话.headers.update({
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "poly-tally/0.1",
        })
        self.已认证 = bool(arg_令牌)
        self.仅公开 = arg_仅公开
        if arg_令牌:
            self.会话.headers["Authorization"] = f"Bearer {arg_令牌}"

    def api_发现(self, arg_账号列表: list[str]) -> list[dict]:
        账号映射 = {账号.casefold(): 账号 for 账号 in arg_账号列表}
        仓库映射: dict[int, dict] = {}
        for 账号 in 账号映射.values():
            编码账号 = quote(账号, safe="")
            账号资料 = self._请求(f"https://api.github.com/users/{编码账号}").json()
            match 账号资料["type"]:
                case "Organization":
                    仓库类型 = "public" if self.仅公开 else "all"
                    地址 = f"https://api.github.com/orgs/{编码账号}/repos?type={仓库类型}&per_page=100"
                case "User":
                    地址 = f"https://api.github.com/users/{编码账号}/repos?type=owner&per_page=100"
                case _:
                    raise ValueError(f"GitHub 账号类型不受支持：{账号资料['type']}")
            for 仓库 in self._分页(地址):
                if not self.仅公开 or not 仓库["private"]:
                    仓库映射[仓库["id"]] = 仓库
        if self.已认证 and not self.仅公开 and 账号映射:
            # 个人公开列表不会返回私有仓库；认证列表补全当前令牌实际可见范围。
            地址 = "https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100"
            for 仓库 in self._分页(地址):
                if 仓库["owner"]["login"].casefold() in 账号映射:
                    仓库映射[仓库["id"]] = 仓库
        return list(仓库映射.values())

    def api_读取仓库(self, arg_全名: str) -> dict:
        return self._校验仓库(self._请求(self._仓库地址(arg_全名)).json())

    def api_读取默认分支(self, arg_仓库: dict) -> str | None:
        默认分支 = arg_仓库["default_branch"]
        if 默认分支 is None:
            if arg_仓库["size"] > 0:
                raise RuntimeError(f"GitHub 非空仓库缺失默认分支：{arg_仓库['full_name']}")
            if self._确认空仓库(arg_仓库):
                return None
            raise RuntimeError("默认分支缺失但未确认空仓库")
        地址 = f"{self._仓库地址(arg_仓库['full_name'])}/branches/{quote(默认分支, safe='')}"
        try:
            响应 = self._请求(地址)
        except requests.HTTPError as 异常:
            # Metadata (including size=0) is not proof of Contents permission.
            # Only a successful unfiltered branch-list read can confirm no refs.
            if arg_仓库["size"] == 0 and 异常.response is not None and 异常.response.status_code in (404, 409):
                if self._确认空仓库(arg_仓库):
                    return None
            raise
        return 响应.json()["commit"]["sha"]

    def _确认空仓库(self, arg_仓库: dict) -> bool:
        # List branches requires Contents:read for private repositories. A 404,
        # 409, malformed body or filtered/nonempty page never establishes empty.
        响应 = self._请求(f"{self._仓库地址(arg_仓库['full_name'])}/branches?per_page=1")
        return 响应.status_code == 200 and 响应.json() == [] and "next" not in 响应.links

    @staticmethod
    def _仓库地址(arg_全名: str) -> str:
        所有者, 仓库名 = arg_全名.split("/")
        if not 所有者 or not 仓库名:
            raise ValueError("GitHub 仓库全名必须包含账号与仓库名")
        return f"https://api.github.com/repos/{quote(所有者, safe='')}/{quote(仓库名, safe='')}"

    @staticmethod
    def _校验仓库(arg_仓库: dict) -> dict:
        if not isinstance(arg_仓库, dict):
            raise ValueError("GitHub 仓库响应必须是对象")
        for 字段 in ("id", "full_name", "clone_url", "default_branch", "private", "archived", "fork", "size"):
            arg_仓库[字段]
        arg_仓库["owner"]["login"]
        return arg_仓库

    def _分页(self, arg_地址: str) -> list[dict]:
        结果: list[dict] = []
        已读地址: set[str] = set()
        地址: str | None = arg_地址
        while 地址 is not None:
            if 地址 in 已读地址:
                raise ValueError("GitHub 分页出现循环链接")
            已读地址.add(地址)
            响应 = self._请求(地址)
            数据 = 响应.json()
            if not isinstance(数据, list):
                raise ValueError("GitHub 仓库列表响应必须是数组")
            结果.extend(self._校验仓库(仓库) for 仓库 in 数据)
            链接 = 响应.links
            地址 = 链接["next"]["url"] if "next" in 链接 else None
        return 结果

    def _请求(self, arg_地址: str) -> requests.Response:
        分解地址 = urlsplit(arg_地址)
        if 分解地址.scheme != "https" or 分解地址.netloc != "api.github.com":
            raise ValueError("GitHub API 分页链接必须保持在 api.github.com")
        for 次数 in range(4):
            try:
                响应 = self.会话.get(arg_地址, timeout=(10, 30))
            except (requests.ConnectionError, requests.Timeout):
                if 次数 == 3:
                    raise
                time.sleep(2 ** 次数)
                continue
            状态 = 响应.status_code
            限流 = 状态 == 429 or (
                状态 == 403 and (
                    响应.headers.get("X-RateLimit-Remaining") == "0"
                    or "Retry-After" in 响应.headers
                    or "rate limit" in 响应.text.lower()
                )
            )
            if (限流 or 500 <= 状态 <= 599) and 次数 < 3:
                等待 = self._等待秒数(响应, 次数, 限流)
                # 不提前越过服务端等待期限；长时间配额耗尽交由上层下一次采集处理。
                if 等待 <= 60:
                    time.sleep(等待)
                    continue
            if 状态 == 401:
                raise requests.HTTPError("GitHub 认证失败（HTTP 401），请检查令牌与权限", response=响应)
            响应.raise_for_status()
            return 响应
        raise RuntimeError("GitHub 请求重试状态异常")

    @staticmethod
    def _等待秒数(
        arg_响应: requests.Response,
        arg_次数: int,
        arg_限流: bool,
    ) -> float:
        if "Retry-After" in arg_响应.headers:
            return max(0.0, float(arg_响应.headers["Retry-After"]))
        if arg_响应.headers.get("X-RateLimit-Remaining") == "0" and "X-RateLimit-Reset" in arg_响应.headers:
            return max(0.0, float(arg_响应.headers["X-RateLimit-Reset"]) - time.time())
        return 60.0 * 2 ** arg_次数 if arg_限流 else float(2 ** arg_次数)
