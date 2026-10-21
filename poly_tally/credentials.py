# ◑ 导入
import os
import subprocess


# ◕ 功能
class 凭证_类:
    """
    令牌仅在内存使用，Git credential helper 需由调用者显式选择。

    更新日志：
    2026.10.21 - 复用已有本地授权，不创建或搬运长期云端 Secret。
    """

    @staticmethod
    def api_读取(arg_使用Git凭证: bool) -> str | None:
        if "POLY_TALLY_TOKEN" in os.environ and os.environ["POLY_TALLY_TOKEN"]:
            return os.environ["POLY_TALLY_TOKEN"]
        if not arg_使用Git凭证:
            return None
        结果 = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n", text=True, capture_output=True, timeout=30, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if 结果.returncode:
            raise RuntimeError("Git credential helper 无可用凭证，请设置只读 POLY_TALLY_TOKEN")
        字段表 = dict(行.split("=", 1) for 行 in 结果.stdout.splitlines() if "=" in 行)
        if "password" not in 字段表 or not 字段表["password"]:
            raise RuntimeError("Git credential helper 未返回 GitHub 凭证")
        return 字段表["password"]
