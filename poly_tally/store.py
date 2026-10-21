# ◑ 导入
import json
from pathlib import Path
import sqlite3


# ◕ 功能
class 数据库_类:
    """
    保存最后成功历史、解析事实与审计记录，SQLite 事务为切换边界。

    更新日志：
    2026.10.21 - 仓库按稳定 ID 建账，不自动删除历史或对象缓存。
    """

    def __init__(self, arg_目录: Path) -> None:
        arg_目录.mkdir(parents=True, exist_ok=True)
        self.连接 = sqlite3.connect(arg_目录 / "stats.sqlite")
        self.连接.execute("PRAGMA journal_mode=WAL")
        self.连接.executescript("""
            CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, state TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS blobs(oid TEXT, context TEXT, version TEXT, metrics TEXT, PRIMARY KEY(oid,context,version));
            CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, data TEXT NOT NULL);
        """)

    def api_仓库列表(self) -> list[dict]:
        return [json.loads(行[0]) for 行 in self.连接.execute("SELECT state FROM repositories ORDER BY id")]

    def api_读取仓库(self, arg_ID: str) -> dict | None:
        行 = self.连接.execute("SELECT state FROM repositories WHERE id=?", (arg_ID,)).fetchone()
        return json.loads(行[0]) if 行 else None

    def api_保存仓库(self, arg_状态: dict) -> None:
        with self.连接:
            self.连接.execute("INSERT OR REPLACE INTO repositories VALUES(?,?)", (arg_状态["id"], json.dumps(arg_状态, ensure_ascii=False)))

    def api_读取解析(
        self,
        arg_OID: str,
        arg_上下文: str,
        arg_版本: str,
    ) -> tuple[bool, dict[str, int] | None]:
        行 = self.连接.execute("SELECT metrics FROM blobs WHERE oid=? AND context=? AND version=?", (arg_OID, arg_上下文, arg_版本)).fetchone()
        return (True, json.loads(行[0])) if 行 else (False, None)

    def api_保存解析(
        self,
        arg_OID: str,
        arg_上下文: str,
        arg_版本: str,
        arg_指标: dict[str, int] | None,
    ) -> None:
        self.连接.execute("INSERT OR REPLACE INTO blobs VALUES(?,?,?,?)", (arg_OID, arg_上下文, arg_版本, json.dumps(arg_指标)))

    def api_记录运行(self, arg_记录: dict) -> None:
        with self.连接:
            self.连接.execute("INSERT INTO runs(data) VALUES(?)", (json.dumps(arg_记录),))

    def api_最近运行(self) -> list[dict]:
        return [json.loads(行[0]) for 行 in self.连接.execute("SELECT data FROM runs ORDER BY id DESC LIMIT 10")]

    def api_备份(self, arg_目标: Path) -> None:
        arg_目标.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(arg_目标) as 目标:
            self.连接.backup(目标)

    def api_关闭(self) -> None:
        self.连接.close()
