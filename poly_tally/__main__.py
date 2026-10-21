# ◑ 导入
import argparse
import json
import os
from pathlib import Path
import sqlite3

from poly_tally.collector import 采集器_类
from poly_tally.export import 公开导出_类
from poly_tally.lock import 运行锁_类


# ◕ 功能
def 主入口() -> int:
    参数器 = argparse.ArgumentParser(description="Poly Tally：只读采集、历史重算与静态发布")
    参数器.add_argument("command", choices=["collect", "export", "retire", "resume", "backup", "restore", "checkpoint"])
    参数器.add_argument("repository_id", nargs="?")
    参数器.add_argument("--config", type=Path, default=Path("config.json"))
    参数器.add_argument("--state", type=Path, default=Path(".poly-tally"))
    参数器.add_argument("--output", type=Path, default=Path("web/data/stats.json"))
    参数器.add_argument("--public-only", action="store_true", help="仅发现和计算公开仓库，适用于 GitHub Actions")
    参数器.add_argument("--refresh", action="store_true", help="无规模变化时也刷新静态产物的扫描时间，不制造数据提交")
    参数器.add_argument("--allow-partial", action="store_true", help="部分源仓库不可访问时保留旧数据、报告状态并允许发布")
    参数器.add_argument("--checkpoint", type=Path, help="只含公开仓库的可长期保存检查点")
    参数器.add_argument("--import-checkpoint", type=Path, help="只恢复本地尚未建账的仓库，避免覆盖更新结果")
    参数器.add_argument("--authoritative-checkpoint", action="store_true", help="以导入检查点为准，覆盖可能过期的 Actions 缓存")
    参数器.add_argument("--backup", type=Path, help="SQLite 一致性备份或恢复文件")
    参数 = 参数器.parse_args()
    配置 = json.loads(参数.config.read_text(encoding="utf-8"))
    令牌 = os.environ["POLY_TALLY_TOKEN"] if "POLY_TALLY_TOKEN" in os.environ else None
    with 运行锁_类(参数.state / "run.lock"):
        采集器 = 采集器_类(配置, 参数.state, 令牌, 参数.public_only)
        try:
            if 参数.import_checkpoint:
                采集器.api_恢复检查点(参数.import_checkpoint, 参数.authoritative_checkpoint)
            返回码 = 0
            match 参数.command:
                case "collect":
                    结果 = 采集器.api_采集()
                    print("[完成] " + json.dumps({键: 值 for 键, 值 in 结果.items() if 键 != "publicRun"}, ensure_ascii=False), flush=True)
                    返回码 = 1 if 结果["failed"] and not 参数.allow_partial else 0
                case "retire" | "resume":
                    if 参数.repository_id is None:
                        参数器.error("retire/resume 必须提供稳定仓库 ID")
                    if 参数.command == "retire":
                        采集器.api_归档(参数.repository_id)
                    else:
                        采集器.api_激活(参数.repository_id)
                case "backup" | "restore":
                    if 参数.backup is None:
                        参数器.error("backup/restore 必须提供 --backup 文件路径")
                    if 参数.command == "backup":
                        采集器.引擎.数据库.api_备份(参数.backup)
                    else:
                        if not 参数.backup.is_file():
                            参数器.error("备份文件不存在")
                        with sqlite3.connect(f"file:{参数.backup.resolve()}?mode=ro", uri=True) as 来源:
                            if 来源.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                                raise ValueError("备份完整性检查失败")
                            来源.backup(采集器.引擎.数据库.连接)
                case "checkpoint" | "export":
                    pass
            if 参数.checkpoint:
                采集器.api_保存检查点(参数.checkpoint, 参数.public_only)
            if 参数.command != "backup":
                已写入 = 公开导出_类(采集器.引擎.数据库, 采集器.规则).api_写入(参数.output, 参数.refresh)
                print(f"[信息] 公开数据{'已更新' if 已写入 else '无统计变化'}：{参数.output}", flush=True)
            return 返回码
        finally:
            采集器.api_关闭()


# ◍ 运行
if __name__ == "__main__":
    raise SystemExit(主入口())
