# ◑ 导入
import base64
import os
from pathlib import Path
import subprocess

from poly_tally.gateway import gateway_config, git_environment, git_url


# ◕ 功能
class Git对象_类:
    """
    只在独立 bare 缓存中写 refs，从不 checkout 或修改被统计仓库。

    更新日志：
    2026.10.21 - 固定第一父链，网络凭证仅由进程环境传递。
    """

    def __init__(self, arg_路径: Path) -> None:
        self.路径 = arg_路径
        self.批进程: subprocess.Popen | None = None
        self.环境 = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        if gateway_config() is not None:
            self.环境 = git_environment()
        elif "POLY_TALLY_TOKEN" in os.environ:
            认证 = base64.b64encode(f"x-access-token:{os.environ['POLY_TALLY_TOKEN']}".encode()).decode()
            self.环境.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader", "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {认证}"})
        if not arg_路径.exists():
            arg_路径.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["git", "init", "--bare", str(arg_路径)], check=True, capture_output=True, env=self.环境)

    def api_命令(self, *arg_参数: str) -> bytes:
        运行 = subprocess.run(["git", "--git-dir", str(self.路径), *arg_参数], env=self.环境, capture_output=True, timeout=300)
        if 运行.returncode:
            # Git 的 stderr 可能包含用户 URL，错误只公开操作名和退出码。
            raise RuntimeError(f"Git {arg_参数[0]} 失败（退出码 {运行.returncode}），保留上次成功数据")
        return 运行.stdout

    def api_更新(self, arg_源: str, arg_分支: str) -> str:
        if gateway_config() is not None:
            # Inspect names only, never credential values. A cache must not add
            # URL rewrites, HTTP authorization, helpers, or included configs.
            guard = subprocess.run(["git", "--git-dir", str(self.路径), "config", "--local", "--name-only", "--get-regexp", r"^(url\.|http\.|credential\.|include\.|includeif\.)"], env=self.环境, capture_output=True, timeout=30)
            if guard.returncode not in (0, 1) or guard.stdout:
                raise RuntimeError("Gateway cache has unsupported network configuration; use a clean trusted cache")
        self.api_命令("check-ref-format", f"refs/heads/{arg_分支}")
        self.api_命令("fetch", "--no-tags", "--no-write-fetch-head", "--force", "--", git_url(arg_源), f"+refs/heads/{arg_分支}:refs/poly-tally/default")
        if self.api_命令("rev-parse", "--is-shallow-repository").strip() != b"false":
            raise RuntimeError("对象缓存为浅仓库，不能声称完整历史；请恢复完整对象缓存")
        return self.api_命令("rev-parse", "refs/poly-tally/default").decode().strip()

    def api_历史(self, arg_HEAD: str) -> list[dict[str, str]]:
        原始 = self.api_命令("log", "--first-parent", "--reverse", "--format=%H%x09%cI%x09%aI", arg_HEAD)
        return [{"sha": 项[0], "committedAt": 项[1], "authoredAt": 项[2]} for 行 in 原始.decode().splitlines() if (项 := 行.split("\t"))]

    def api_文件树(self, arg_SHA: str) -> dict[str, tuple[str, str]]:
        结果 = {}
        for 项 in self.api_命令("ls-tree", "-r", "-z", arg_SHA).split(b"\0"):
            if 项:
                元, 路径 = 项.split(b"\t", 1)
                模式, _, OID = 元.decode().split()
                结果[路径.decode("utf-8", errors="surrogateescape")] = (模式, OID)
        return 结果

    def api_变动(self, arg_前提交: str, arg_提交: str) -> list[tuple[str, str, str]]:
        项表 = self.api_命令("diff-tree", "--no-commit-id", "--no-renames", "-r", "--raw", "-z", arg_前提交, arg_提交).split(b"\0")
        结果 = []
        for 位置 in range(0, len(项表) - 1, 2):
            _, 新模式, _, 新OID, _ = 项表[位置].decode().split()
            结果.append((项表[位置 + 1].decode("utf-8", errors="surrogateescape"), 新模式, 新OID))
        return 结果

    def api_读取blob(self, arg_OID: str, arg_上限: int) -> bytes | None:
        if self.批进程 is None:
            self.批进程 = subprocess.Popen(["git", "--git-dir", str(self.路径), "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=self.环境)
        输入, 输出 = self.批进程.stdin, self.批进程.stdout
        if 输入 is None or 输出 is None:
            raise RuntimeError("Git blob 管道未初始化")
        输入.write(arg_OID.encode() + b"\n")
        输入.flush()
        头 = 输出.readline().split()
        if len(头) != 3 or 头[1] != b"blob":
            raise RuntimeError("Git 对象缺失或类型错误，不能构造完整历史")
        大小 = int(头[2])
        if 大小 <= arg_上限:
            内容 = 输出.read(大小)
        else:
            剩余 = 大小
            while 剩余:
                块 = 输出.read(min(剩余, 65536))
                if not 块:
                    raise RuntimeError("Git blob 读取中断")
                剩余 -= len(块)
            内容 = None
        if 输出.read(1) != b"\n":
            raise RuntimeError("Git blob 管道响应不完整")
        return 内容

    def api_关闭(self) -> None:
        if self.批进程 is not None:
            if self.批进程.stdin is not None:
                self.批进程.stdin.close()
            self.批进程.wait(timeout=10)
            if self.批进程.stdout is not None:
                self.批进程.stdout.close()


class 缓存对象_类(Git对象_类):
    """
    固定已采集 HEAD 的离线对象后端，不创建缺失缓存，也不更新远端引用。

    更新日志：
    2026.10.22 - 为规则重算提供禁止 fetch 和浅历史的生产入口。
    """

    def __init__(
        self,
        arg_路径: Path,
        arg_HEAD: str,
        arg_备用路径: Path | None = None,
    ) -> None:
        if not arg_路径.is_dir() and arg_备用路径 is not None and arg_备用路径.is_dir():
            arg_路径, arg_备用路径 = arg_备用路径, None
        if not arg_路径.is_dir():
            raise RuntimeError("原始 Git 对象目录缺失；请恢复对象备份，离线重算不会联网补齐")
        super().__init__(arg_路径)
        # 部分克隆的 Git 可能隐式 lazy fetch；缺失对象必须在本地明确失败。
        self.环境["GIT_NO_LAZY_FETCH"] = "1"
        # 本机 Apple Git 2.39 不识别 NO_LAZY_FETCH；运输层空白名单跨版本禁止所有协议。
        self.环境["GIT_ALLOW_PROTOCOL"] = ""
        self.固定HEAD = arg_HEAD
        self.备用路径 = arg_备用路径

    def api_更新(self, arg_源: str, arg_分支: str) -> str:
        try:
            if self.api_命令("rev-parse", "--is-shallow-repository").strip() != b"false":
                raise RuntimeError("对象缓存为浅仓库，不能离线重算完整历史")
            self.api_命令("cat-file", "-e", f"{self.固定HEAD}^{{commit}}")
        except RuntimeError:
            if self.备用路径 is None or self.备用路径 == self.路径 or not self.备用路径.is_dir():
                raise
            # 升级布局时失败 fetch 可能留下空 bare；完整旧缓存仍是可恢复来源。
            self.路径, self.备用路径 = self.备用路径, None
            return self.api_更新(arg_源, arg_分支)
        return self.固定HEAD
