# ◑ 导入
import importlib.util
import json
from pathlib import Path
import subprocess

from poly_tally.engine import 历史引擎_类
from poly_tally.rules import 规则_类


# ◕ 功能
def test_固定原生对象重放逐提交一致且不联网(tmp_path: Path) -> None:
    源 = tmp_path / "source"
    源.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(源)], check=True, capture_output=True)
    for 键, 值 in [("user.email", "fixture@example.invalid"), ("user.name", "Fixture")]:
        subprocess.run(["git", "-C", str(源), "config", 键, 值], check=True)
    (源 / "main.py").write_text("x=1\n")
    subprocess.run(["git", "-C", str(源), "add", "."], check=True)
    subprocess.run(["git", "-C", str(源), "commit", "-qm", "fixture"], check=True)
    配置 = json.loads(Path("config.json").read_text())
    缓存 = tmp_path / "cache"
    状态目录 = tmp_path / "state"
    引擎 = 历史引擎_类(状态目录, 规则_类(配置["rules"]), 缓存)
    try:
        引擎.api_同步({"id": 1, "full_name": "fixture/one", "default_branch": "main", "private": False, "archived": False}, str(源))
    finally:
        引擎.api_关闭()
    源.rename(tmp_path / "source-unavailable")
    规格 = importlib.util.spec_from_file_location("native_benchmark", "scripts/benchmark-native.py")
    模块 = importlib.util.module_from_spec(规格)
    规格.loader.exec_module(模块)
    报告 = 模块.原生重算基准_类.api_运行(状态目录, 缓存, 配置)
    assert 报告["equivalent"] is True
    assert 报告["commits"] == 1
    assert 报告["counters"]["parsedBlobs"] == 0
    assert 报告["counters"]["recomputedCommits"] == 1
    assert 报告["counters"]["fetchedRepositories"] == 0
