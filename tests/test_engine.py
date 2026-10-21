# ◑ 导入
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from poly_tally.engine import 历史引擎_类
from poly_tally.rules import 规则_类


# ◕ 功能
class Test历史_类(unittest.TestCase):
    """
    用真实 Git 树验证统计、缓存和历史修正规则。

    更新日志：
    2026.10.21 - 建立可手算的主线历史验收。
    """

    def setUp(self) -> None:
        self.临时 = tempfile.TemporaryDirectory()
        self.addCleanup(self.临时.cleanup)
        self.根 = Path(self.临时.name)
        self.源 = self.根 / "source"
        self.源.mkdir()
        self._git("init", "-b", "main")
        self._git("config", "user.email", "test@example.invalid")
        self._git("config", "user.name", "Fixture")
        self.元数据 = {"id": 1, "full_name": "fixture/one", "default_branch": "main", "private": False, "archived": False, "fork": False, "clone_url": str(self.源)}
        self.规则配置 = {"exclude": ["**/vendor/**"], "include": ["**"], "languages": {}, "max_blob_bytes": 2000000, "include_forks": False}
        self.引擎 = 历史引擎_类(self.根 / "state", 规则_类(self.规则配置))
        self.addCleanup(self.引擎.api_关闭)
        self.时间 = 0

    def _git(self, *arg_参数: str) -> str:
        return subprocess.check_output(["git", "-C", str(self.源), *arg_参数], stderr=subprocess.DEVNULL).decode().strip()

    def _提交(self, arg_文件: dict[str, str | None], arg_时间: str | None = None) -> str:
        for 路径, 内容 in arg_文件.items():
            目标 = self.源 / 路径
            if 内容 is None:
                目标.unlink()
            else:
                目标.parent.mkdir(parents=True, exist_ok=True)
                目标.write_text(内容)
        self._git("add", ".")
        self.时间 += 1
        日期 = arg_时间 or f"2024-01-{self.时间:02d}T12:00:00+00:00"
        subprocess.run(["git", "-C", str(self.源), "commit", "-qm", "fixture"], env={**os.environ, "GIT_AUTHOR_DATE": 日期, "GIT_COMMITTER_DATE": 日期}, check=True)
        return self._git("rev-parse", "HEAD")

    def _同步(self) -> dict:
        return self.引擎.api_同步(self.元数据, str(self.源))

    def test_口径与无变化零解析(self) -> None:
        self._提交({"a.py": '# note\nx = "# value"  # mixed\n\n"""doc"""\n', "readme.md": "# Title\n\nText\n", "a.png": "\x00binary", "vendor/b.py": "x=0\n", "asset.bin": "x=1\n", "pointer.py": "version https://git-lfs.github.com/spec/v1\noid sha256:aaa\nsize 12\n"})
        状态 = self._同步()
        self.assertEqual(状态["history"][-1]["metrics"], {"code": 1, "comment": 2, "blank": 2, "documentation": 2, "files": 2})
        引擎 = 历史引擎_类(self.根 / "state", 规则_类(self.规则配置))
        self.addCleanup(引擎.api_关闭)
        引擎.api_同步(self.元数据, str(self.源))
        self.assertEqual(引擎.计数["parsedBlobs"], 0)
        self.assertEqual(引擎.计数["recomputedCommits"], 0)

    def test_增量与独立全量一致(self) -> None:
        self._提交({"a.py": "# c\nx=1\n", "doc.md": "text\n"})
        self._同步()
        self._提交({"a.py": "# c\nx=2\ny=3\n"})
        状态 = self._同步()
        全量 = 历史引擎_类(self.根 / "fresh", 规则_类(self.规则配置))
        self.addCleanup(全量.api_关闭)
        self.assertEqual(状态["history"], 全量.api_同步(self.元数据, str(self.源))["history"])
        self.assertEqual(self.引擎.计数["parsedBlobs"], 3)
        self.assertEqual(状态["history"][-1]["metrics"]["code"], 2)

    def test_改名改变分类与规则全历史重算(self) -> None:
        self._提交({"a.py": "# title\nx=1\n"})
        self._同步()
        self._git("mv", "a.py", "a.md")
        self._提交({})
        状态 = self._同步()
        self.assertEqual(状态["history"][-1]["metrics"]["documentation"], 2)
        配置 = copy.deepcopy(self.规则配置)
        配置["exclude"].append("*.py")
        重算 = 历史引擎_类(self.根 / "state", 规则_类(配置))
        self.addCleanup(重算.api_关闭)
        状态 = 重算.api_同步(self.元数据, str(self.源))
        self.assertEqual(状态["history"][0]["metrics"]["code"], 0)
        self.assertEqual(状态["history"][-1]["metrics"]["documentation"], 2)

    def test_回退分叉与无公共历史撤销旧提交(self) -> None:
        首 = self._提交({"a.py": "x=1\n"})
        废弃 = self._提交({"a.py": "x=1\ny=2\n"})
        self._同步()
        self._git("reset", "--hard", 首)
        状态 = self._同步()
        self.assertEqual([项["sha"] for 项 in 状态["history"]], [首])
        新 = self._提交({"b.py": "z=2\n"})
        状态 = self._同步()
        self.assertEqual([项["sha"] for 项 in 状态["history"]], [首, 新])
        self.assertNotIn(废弃, str(状态["history"]))
        self._git("checkout", "--orphan", "new")
        self._git("rm", "-rf", ".")
        孤立 = self._提交({"alone.py": "q=1\n"})
        self._git("branch", "-M", "main")
        self.assertEqual([项["sha"] for 项 in self._同步()["history"]], [孤立])

    def test_分支切换改名与普通revert(self) -> None:
        首 = self._提交({"a.py": "x=1\n"})
        次 = self._提交({"a.py": "x=2\ny=3\n"})
        self._同步()
        self._git("revert", "--no-edit", 次)
        状态 = self._同步()
        self.assertEqual(len(状态["history"]), 3)
        self.assertEqual(状态["history"][-1]["metrics"]["code"], 1)
        self._git("branch", "other", 首)
        self.元数据["default_branch"] = "other"
        self.assertEqual(len(self._同步()["history"]), 1)
        self._git("branch", "-m", "other", "renamed")
        self.元数据["default_branch"] = "renamed"
        self.assertEqual(self._同步()["branch"], "renamed")

    def test_合并只统计第一父链与结果树(self) -> None:
        self._提交({"a.py": "x=1\n"})
        self._git("checkout", "-b", "side")
        self._提交({"side.py": "y=1\n"})
        self._git("checkout", "main")
        self._提交({"main.py": "z=1\n"})
        self._git("merge", "--no-ff", "side", "-m", "merge")
        状态 = self._同步()
        self.assertEqual(len(状态["history"]), 3)
        self.assertEqual(状态["history"][-1]["metrics"]["code"], 3)
        self.assertEqual(状态["history"][1]["metrics"]["code"], 2)

    def test_倒序同刻按拓扑归一化(self) -> None:
        self._提交({"a.py": "x=1\n"}, "2024-02-01T00:00:00Z")
        self._提交({"a.py": "x=2\ny=3\n"}, "2024-01-01T00:00:00Z")
        状态 = self._同步()
        self.assertEqual(状态["history"][0]["timestamp"], 状态["history"][1]["timestamp"])
        self.assertNotEqual(状态["history"][0]["committedAt"], 状态["history"][1]["committedAt"])

    def test_失败不覆盖最后成功与源refs不变(self) -> None:
        首 = self._提交({"a.py": "x=1\n"})
        之前 = self._git("show-ref")
        self._同步()
        self.assertEqual(之前, self._git("show-ref"))
        self.元数据["default_branch"] = "missing"
        with self.assertRaises(RuntimeError):
            self._同步()
        self.assertEqual(self.引擎.api_仓库列表()[0]["head"], 首)

    def test_冷数据对象仍在时离线重算(self) -> None:
        self._提交({"a.py": "x=1\n", "readme.md": "doc\n"})
        状态 = self._同步()
        状态["status"] = "cold"
        self.引擎.数据库.api_保存仓库(状态)
        配置 = copy.deepcopy(self.规则配置)
        配置["exclude"].append("*.py")
        新引擎 = 历史引擎_类(self.根 / "state", 规则_类(配置))
        self.addCleanup(新引擎.api_关闭)
        self.源.rename(self.根 / "source-gone")
        新状态 = 新引擎.api_重算冷数据("1")
        self.assertEqual(新状态["status"], "cold")
        self.assertEqual(新状态["history"][-1]["metrics"]["code"], 0)
        self.assertEqual(新状态["history"][-1]["metrics"]["documentation"], 1)

    def test_三个真实仓库按历史位置回填(self) -> None:
        for 序号 in range(1, 4):
            self.源 = self.根 / f"repo-{序号}"
            self.源.mkdir()
            self._git("init", "-b", "main")
            self._git("config", "user.email", "test@example.invalid")
            self._git("config", "user.name", "Fixture")
            self.元数据.update({"id": 序号, "full_name": f"fixture/repo-{序号}"})
            self._提交({"a.py": "x=1\n" * 序号}, f"2024-01-0{序号}T00:00:00Z")
            self._提交({"a.py": "x=1\n" * (序号 + 1)}, f"2024-01-0{序号 + 5}T00:00:00Z")
            self._同步()
        仓库表 = self.引擎.api_仓库列表()
        事件 = sorted((项["timestamp"], 仓库["id"], 项["metrics"]["code"]) for 仓库 in 仓库表 for 项 in 仓库["history"])
        状态表 = {}
        总量表 = []
        for 时间, ID, 值 in 事件:
            self.assertTrue(时间.startswith("2024-"))
            状态表[ID] = 值
            总量表.append(sum(状态表.values()))
        self.assertEqual(总量表, [1, 3, 6, 7, 8, 9])

    def test_删除文件后存量减少且全量一致(self) -> None:
        self._提交({"a.py": "x=1\n", "b.py": "y=2\n"})
        self._同步()
        self._提交({"a.py": None})
        状态 = self._同步()
        self.assertEqual(状态["history"][-1]["metrics"]["code"], 1)
        self.assertEqual(状态["history"][-1]["metrics"]["files"], 1)
        全量 = 历史引擎_类(self.根 / "fresh-delete", 规则_类(self.规则配置))
        self.addCleanup(全量.api_关闭)
        self.assertEqual(状态["history"], 全量.api_同步(self.元数据, str(self.源))["history"])

    def test_新规则撤销历史日志飞升而保留源码增长并与全量一致(self) -> None:
        self._提交({"src/main.ts": "const value = 1;\n"})
        self._同步()
        self._提交({"log/loc/scan.json": "[\n" + "1,\n" * 100 + "]\n", "docs/.obsidian/plugins/plugin/main.js": "var dependency = 1;\n" * 50})
        self._同步()
        self._提交({"src/main.ts": "const value = 1;\nconst next = 2;\n", "log/loc/scan.json": "[\n" + "2,\n" * 200 + "]\n"})
        旧状态 = self._同步()
        self.assertGreater(旧状态["history"][1]["metrics"]["code"], 100)
        配置 = json.loads((Path(__file__).parents[1] / "config.json").read_text())["rules"]
        重算 = 历史引擎_类(self.根 / "state", 规则_类(配置))
        self.addCleanup(重算.api_关闭)
        新状态 = 重算.api_同步(self.元数据, str(self.源))
        self.assertEqual([项["metrics"]["code"] for 项 in 新状态["history"]], [1, 1, 2])
        全量 = 历史引擎_类(self.根 / "fresh-exclusions", 规则_类(配置))
        self.addCleanup(全量.api_关闭)
        self.assertEqual(新状态["history"], 全量.api_同步(self.元数据, str(self.源))["history"])
        重算.api_同步(self.元数据, str(self.源))
        self.assertEqual(重算.计数["recomputedCommits"], 3)

    def test_跳过文件数是当前仓库清单而不是跨仓库运行计数(self) -> None:
        self._提交({"a.py": "x=1\n", "pointer.py": "version https://git-lfs.github.com/spec/v1\noid sha256:aaa\nsize 12\n"})
        self.assertEqual(self._同步()["skippedFiles"], 1)
        self._提交({"pointer.py": None})
        self.元数据.update({"id": 2, "full_name": "fixture/two"})
        self.assertEqual(self._同步()["skippedFiles"], 0)
        self.元数据.update({"id": 1, "full_name": "fixture/one"})
        self.assertEqual(self._同步()["skippedFiles"], 0)
