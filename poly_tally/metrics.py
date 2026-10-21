# ◑ 导入
from pygments.lexers import get_lexer_by_name
from pygments.token import Comment, String

from poly_tally.rules import 规则_类


# ◕ 功能
class 行统计_类:
    """
    按物理行计数，混合行优先归代码，文档不混入代码行。

    更新日志：
    2026.10.21 - 使用固定版本词法器避免字符串内注释符误判。
    """

    @staticmethod
    def api_空指标() -> dict[str, int]:
        return {"code": 0, "comment": 0, "blank": 0, "documentation": 0, "files": 0}

    @staticmethod
    def api_解析(arg_内容: bytes, arg_语言: str) -> dict[str, int] | None:
        if b"\x00" in arg_内容 or arg_内容.startswith(b"version https://git-lfs.github.com/spec/v1"):
            return None
        try:
            文本 = arg_内容.decode("utf-8-sig")
        except UnicodeDecodeError:
            return None
        # 不引入隐式编码猜测；非 UTF-8 内容明确排除并计入 skippedBlobs。
        文本 = 文本.replace("\r\n", "\n").replace("\r", "\n")
        行表 = 文本.split("\n")
        if 行表[-1] == "":
            行表.pop()
        结果 = 行统计_类.api_空指标()
        结果["files"] = 1
        if arg_语言 in 规则_类.文档语言:
            结果["blank"] = sum(not 行.strip() for 行 in 行表)
            结果["documentation"] = len(行表) - 结果["blank"]
            return 结果
        词法器 = get_lexer_by_name(规则_类.词法名[arg_语言], stripnl=False, ensurenl=False)
        行类型 = [set() for _ in 行表]
        行号 = 0
        for _, 类型, 值 in 词法器.get_tokens_unprocessed(文本):
            类别 = "comment" if 类型 in Comment or 类型 in String.Doc else "code"
            for 序号, 片段 in enumerate(值.split("\n")):
                if 序号:
                    行号 += 1
                if 片段.strip() and 行号 < len(行表):
                    行类型[行号].add(类别)
        for 行, 类型 in zip(行表, 行类型):
            类别 = "blank" if not 行.strip() else "code" if "code" in 类型 else "comment"
            结果[类别] += 1
        return 结果

    @staticmethod
    def api_汇总(arg_语言表: dict[str, dict[str, int]]) -> dict[str, int]:
        return {键: sum(项[键] for 项 in arg_语言表.values()) for 键 in 行统计_类.api_空指标()}
