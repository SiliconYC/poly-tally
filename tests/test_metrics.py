# ◑ 导入
import unittest

from pygments.lexers import get_lexer_by_name

from poly_tally.metrics import 行统计_类
from poly_tally.rules import 规则_类


# ◕ 功能
class 行统计测试_类(unittest.TestCase):
    """
    验证固定词法器兼容性及物理行计数边界。

    更新日志：
    2026.10.21 - 覆盖语言映射、编码、换行和注释混合场景。
    """

    def test_全部配置语言均有可实例化词法器(self) -> None:
        for 语言, 词法名 in 规则_类.词法名.items():
            with self.subTest(语言=语言, 词法名=词法名):
                词法器 = get_lexer_by_name(词法名)
                self.assertTrue(list(词法器.get_tokens("sample\n")))

    def test_Svelte嵌入脚本和样式注释正常分类(self) -> None:
        内容 = b"<script>\n// note\nlet x = 1;\n</script>\n<style>\n/* note */\n.a { color: red; }\n</style>\n<div>Hello</div>\n"
        self.assertEqual(行统计_类.api_解析(内容, "Svelte"), {"code": 7, "comment": 2, "blank": 0, "documentation": 0, "files": 1})

    def test_空文件不产生虚构行(self) -> None:
        for 语言 in ("Python", "JavaScript", "Markdown"):
            with self.subTest(语言=语言):
                self.assertEqual(行统计_类.api_解析(b"", 语言), {"code": 0, "comment": 0, "blank": 0, "documentation": 0, "files": 1})

    def test_CRLF和有无末尾换行保持物理行计数(self) -> None:
        for 内容 in (b"# note\r\nx = 1\r\n\r\n", b"# note\r\nx = 1\r\n "):
            with self.subTest(内容=内容):
                self.assertEqual(行统计_类.api_解析(内容, "Python"), {"code": 1, "comment": 1, "blank": 1, "documentation": 0, "files": 1})
        self.assertEqual(行统计_类.api_解析(b"\n\n", "Python"), {"code": 0, "comment": 0, "blank": 2, "documentation": 0, "files": 1})

    def test_字符串注释标记和多行混合注释按代码优先(self) -> None:
        内容 = b'const url = "https://example.invalid/a/*b*/"; // tail\n/* start\n * block\n */ const value = 1; /* tail */\n\n// end\n'
        self.assertEqual(行统计_类.api_解析(内容, "JavaScript"), {"code": 2, "comment": 3, "blank": 1, "documentation": 0, "files": 1})

    def test_UTF8签名不会把首行注释变成代码(self) -> None:
        self.assertEqual(行统计_类.api_解析(b"\xef\xbb\xbf# note\nx = 1\n", "Python"), {"code": 1, "comment": 1, "blank": 0, "documentation": 0, "files": 1})

    def test_文档非空行与空白分开统计(self) -> None:
        self.assertEqual(行统计_类.api_解析(b"# Heading\r\n\r\nBody", "Markdown"), {"code": 0, "comment": 0, "blank": 1, "documentation": 2, "files": 1})

    def test_非法编码二进制与LFS指针明确排除(self) -> None:
        for 内容 in (b"\xffinvalid", b"x = 1\x00\n", b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 42\n"):
            with self.subTest(内容=内容):
                self.assertIsNone(行统计_类.api_解析(内容, "Python"))
