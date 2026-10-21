# ◑ 导入
import fnmatch
import hashlib
import json
from pathlib import PurePosixPath
import re

import pygments


# ◕ 功能
class 规则_类:
    """
    全仓库共用的路径、语言和统计器版本契约。

    更新日志：
    2026.10.21 - 建立统一口径，Entrepi 与其他 Markdown 同归文档。
    """

    统计器版本 = f"poly-tally/4;pygments/{pygments.__version__}"
    默认语言 = {
        ".py": "Python", ".pyi": "Python", ".pyx": "Cython", ".pxd": "Cython", ".pxi": "Cython",
        ".js": "JavaScript", ".jsx": "JavaScript",
        ".mjs": "JavaScript", ".cjs": "JavaScript", ".ts": "TypeScript", ".tsx": "TSX",
        ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cc": "C++", ".cu": "CUDA",
        ".cs": "C#", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".go": "Go",
        ".rs": "Rust", ".rb": "Ruby", ".php": "PHP", ".vue": "Vue", ".svelte": "Svelte",
        ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS", ".less": "Less",
        ".sh": "Bash", ".bash": "Bash", ".zsh": "Bash", ".ps1": "PowerShell", ".bat": "Batchfile",
        ".sql": "SQL", ".r": "R", ".R": "R", ".lua": "Lua", ".dart": "Dart",
        ".json": "JSON", ".jsonc": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
        ".ini": "INI", ".cfg": "INI", ".xml": "XML", ".svg": "XML", ".proto": "Protocol Buffer",
        ".md": "Markdown", ".mdx": "Markdown", ".rst": "reStructuredText", ".txt": "Text",
        ".tex": "TeX", ".qss": "CSS", ".qml": "QML", ".cmake": "CMake",
    }
    文档语言 = {"Markdown", "reStructuredText", "Text", "TeX"}
    词法名 = {
        "Python": "python", "Cython": "cython", "JavaScript": "javascript", "TypeScript": "typescript", "TSX": "tsx",
        "C": "c", "C++": "cpp", "CUDA": "cuda", "C#": "csharp", "Java": "java", "Kotlin": "kotlin",
        "Swift": "swift", "Go": "go", "Rust": "rust", "Ruby": "ruby", "PHP": "php", "Vue": "vue",
        # 固定版本没有 Svelte 词法器；HTML 近似保留其嵌入 script/style 的注释分类。
        "Svelte": "html", "HTML": "html", "CSS": "css", "SCSS": "scss", "Less": "less",
        "Bash": "bash", "PowerShell": "powershell", "Batchfile": "bat", "SQL": "sql", "R": "r",
        "Lua": "lua", "Dart": "dart", "JSON": "json", "YAML": "yaml", "TOML": "toml", "INI": "ini",
        "XML": "xml", "Protocol Buffer": "protobuf", "QML": "qml", "CMake": "cmake", "Makefile": "make",
        "Dockerfile": "docker", "Markdown": "markdown", "reStructuredText": "rst", "Text": "text", "TeX": "tex",
    }

    def __init__(self, arg_配置: dict) -> None:
        self.配置 = arg_配置
        for 键 in ("exclude", "include", "languages", "max_blob_bytes", "include_forks"):
            if 键 not in arg_配置:
                raise ValueError(f"统计规则缺少字段：{键}")
        if arg_配置["max_blob_bytes"] <= 0:
            raise ValueError("max_blob_bytes 必须大于零")
        self.语言表 = {**self.默认语言, **arg_配置["languages"]}
        # Explicit hard exclusions apply before all include/preserve rules and
        # before blob reads. Canonical type and remapped type both participate,
        # so remapping .json/.svg to source code cannot revive a banned family.
        扩展排除 = arg_配置.get("exclude_extensions", [])
        语言排除 = arg_配置.get("exclude_languages", [])
        if not isinstance(扩展排除, list) or any(not isinstance(项, str) or not 项.startswith(".") or len(项) < 2 or any(符 in 项 for 符 in "/\\*?[]") for 项 in 扩展排除):
            raise ValueError("exclude_extensions 必须是以点开头的扩展名列表")
        已知语言 = {项.casefold() for 项 in self.词法名}
        if not isinstance(语言排除, list) or any(not isinstance(项, str) or 项.casefold() not in 已知语言 for 项 in 语言排除):
            raise ValueError("exclude_languages 必须是已知语言类别列表")
        self.硬排除扩展 = {项.casefold() for 项 in 扩展排除}
        self.硬排除语言 = {项.casefold() for 项 in 语言排除}
        for 语言 in self.语言表.values():
            if 语言 not in self.词法名:
                raise ValueError(f"未知语言类别：{语言}")
        self.版本 = hashlib.sha256(json.dumps({"rules": arg_配置, "parser": self.统计器版本, "languages": self.语言表}, sort_keys=True).encode()).hexdigest()[:16]
        # 同一规则组只编译一次，避免每个历史文件逐条进入 Python fnmatch 循环。
        self._路径匹配 = {键: self._编译匹配(arg_配置.get(键, [])) for 键 in ("exclude", "include", "artifact_exclude", "source_preserve")}

    @staticmethod
    def api_匹配(arg_路径: str, arg_模式: str) -> bool:
        # **/ 同时匹配根目录，避免根层依赖目录漏计。
        return fnmatch.fnmatchcase(arg_路径, arg_模式) or (arg_模式.startswith("**/") and 规则_类.api_匹配(arg_路径, arg_模式[3:]))

    @staticmethod
    def _编译匹配(arg_模式表: list[str]) -> re.Pattern:
        # 使用标准库 translate 保留大小写、字符组、跨斜杠 '*' 和特殊字符语义。
        # 展开所有前导 '**/' 的省略形式，与 api_匹配 的递归行为逐值等价。
        模式表 = {}
        for 模式 in arg_模式表:
            while True:
                模式表[模式] = None
                if not 模式.startswith("**/"):
                    break
                模式 = 模式[3:]
        return re.compile("|".join(fnmatch.translate(模式) for 模式 in 模式表) if 模式表 else r"(?!)")

    def api_语言(self, arg_路径: str) -> str | None:
        路径 = PurePosixPath(arg_路径)
        扩展 = 路径.suffix.casefold()
        类别 = (self.默认语言.get(扩展), self.语言表.get(扩展))
        if 扩展 in self.硬排除扩展 or any(语言 is not None and 语言.casefold() in self.硬排除语言 for 语言 in 类别):
            return None
        if self._路径匹配["exclude"].match(arg_路径):
            return None
        # 结果文件名有歧义，源码/测试上下文可保留；依赖等明确排除不受保护覆盖。
        if self._路径匹配["artifact_exclude"].match(arg_路径) and not self._路径匹配["source_preserve"].match(arg_路径):
            return None
        if not self._路径匹配["include"].match(arg_路径):
            return None
        if 路径.name in {"Dockerfile", "Makefile", "CMakeLists.txt"}:
            return {"Dockerfile": "Dockerfile", "Makefile": "Makefile", "CMakeLists.txt": "CMake"}[路径.name]
        return self.语言表[路径.suffix.lower()] if 路径.suffix.lower() in self.语言表 else None
