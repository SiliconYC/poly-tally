# ◑ 导入
import fnmatch
import hashlib
import json
from pathlib import PurePosixPath

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
        for 语言 in self.语言表.values():
            if 语言 not in self.词法名:
                raise ValueError(f"未知语言类别：{语言}")
        self.版本 = hashlib.sha256(json.dumps({"rules": arg_配置, "parser": self.统计器版本, "languages": self.语言表}, sort_keys=True).encode()).hexdigest()[:16]

    @staticmethod
    def api_匹配(arg_路径: str, arg_模式: str) -> bool:
        # **/ 同时匹配根目录，避免根层依赖目录漏计。
        return fnmatch.fnmatchcase(arg_路径, arg_模式) or (arg_模式.startswith("**/") and 规则_类.api_匹配(arg_路径, arg_模式[3:]))

    def api_语言(self, arg_路径: str) -> str | None:
        if any(self.api_匹配(arg_路径, 项) for 项 in self.配置["exclude"]):
            return None
        产物规则 = self.配置["artifact_exclude"] if "artifact_exclude" in self.配置 else []
        源码保护 = self.配置["source_preserve"] if "source_preserve" in self.配置 else []
        # 结果文件名有歧义，源码/测试上下文可保留；依赖等明确排除不受保护覆盖。
        if any(self.api_匹配(arg_路径, 项) for 项 in 产物规则) and not any(self.api_匹配(arg_路径, 项) for 项 in 源码保护):
            return None
        if not any(self.api_匹配(arg_路径, 项) for 项 in self.配置["include"]):
            return None
        路径 = PurePosixPath(arg_路径)
        if 路径.name in {"Dockerfile", "Makefile", "CMakeLists.txt"}:
            return {"Dockerfile": "Dockerfile", "Makefile": "Makefile", "CMakeLists.txt": "CMake"}[路径.name]
        return self.语言表[路径.suffix.lower()] if 路径.suffix.lower() in self.语言表 else None
