# ◑ 导入
import argparse
from contextlib import ExitStack
import json
import os
import re
from pathlib import Path
import sqlite3
import time

from poly_tally.collector import 采集器_类
from poly_tally.credentials import 凭证_类
from poly_tally.gateway import gateway_config
from poly_tally.export import 公开导出_类
from poly_tally.lock import 运行锁_类
from poly_tally.private_metrics import 私有规模导出_类


# ◕ 功能
def 主入口() -> int:
    开始 = time.perf_counter()
    参数器 = argparse.ArgumentParser(description="Poly Tally：只读采集、历史重算与静态发布")
    参数器.add_argument("command", choices=["collect", "rebuild", "export", "retire", "resume", "backup", "restore", "checkpoint"])
    参数器.add_argument("repository_id", nargs="?")
    参数器.add_argument("--config", type=Path, default=Path("config.json"))
    参数器.add_argument("--dataset-epoch", default=os.environ.get("POLY_TALLY_DATASET_EPOCH"), help="隔离重算批次；新批次使用独立状态且禁止导入旧检查点")
    参数器.add_argument("--expected-inventory", type=Path, help="本次重算的新鲜授权仓库元数据盘点；检测凭据缩小，不导入旧统计或改变自动发现")
    参数器.add_argument("--state", type=Path, default=Path(".poly-tally"))
    参数器.add_argument("--cache", type=Path, help="跨批次保留的原始对象与解析事实根目录；自动隔离公开/私有范围")
    参数器.add_argument("--from-state", type=Path, help="rebuild 的来源批次目录，含 stats.sqlite；只读取已知仓库身份与 HEAD，不联网")
    参数器.add_argument("--report", type=Path, help="本地性能报告，含私有仓库诊断，不可直接公开")
    参数器.add_argument("--output", type=Path, default=Path("web/data/stats.json"))
    范围参数 = 参数器.add_mutually_exclusive_group()
    范围参数.add_argument("--public-only", action="store_true", help="仅发现和计算公开仓库")
    范围参数.add_argument("--private-only", action="store_true", help="仅采集授权范围的私有仓库")
    参数器.add_argument("--git-credential", action="store_true", help="从已配置的 Git credential helper 读取 GitHub 凭证，仅在内存使用")
    参数器.add_argument("--include-private-metrics", action="store_true", help="公开私有仓库名称与日级规模，仍排除源码和 Git 提交细节")
    参数器.add_argument("--private-metrics-output", type=Path, help="额外写入可公开的私有日级规模文件，配合 --include-private-metrics")
    参数器.add_argument("--refresh", action="store_true", help="无规模变化时也刷新静态产物的扫描时间，不制造数据提交")
    参数器.add_argument("--allow-partial", action="store_true", help="部分源仓库不可访问时保留旧数据、报告状态并允许发布")
    参数器.add_argument("--checkpoint", type=Path, help="只含公开仓库的可长期保存检查点")
    参数器.add_argument("--import-checkpoint", type=Path, help="只恢复本地尚未建账的仓库，避免覆盖更新结果")
    参数器.add_argument("--authoritative-checkpoint", action="store_true", help="以导入检查点为准，覆盖可能过期的 Actions 缓存")
    参数器.add_argument("--backup", type=Path, help="SQLite 一致性备份或恢复文件")
    参数 = 参数器.parse_args()
    if 参数.command == "rebuild":
        if 参数.from_state is None:
            参数器.error("rebuild 必须提供 --from-state 来源批次目录")
        if 参数.import_checkpoint or 参数.expected_inventory or 参数.authoritative_checkpoint:
            参数器.error("rebuild 不导入旧检查点或授权清单；只重放本地已知 HEAD")
    配置 = json.loads(参数.config.read_text(encoding="utf-8"))
    参数.cache = (参数.cache or 参数.state / "cache") / ("public" if 参数.public_only else "private")
    参数.dataset_epoch = 参数.dataset_epoch or 配置.get("datasetEpoch")
    if 参数.dataset_epoch:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", 参数.dataset_epoch):
            参数器.error("dataset epoch 必须是安全的批次名称")
        参数.state = 参数.state / "epochs" / 参数.dataset_epoch
    令牌 = None if 参数.command == "rebuild" else 凭证_类.api_读取(参数.git_credential)
    if 参数.command == "collect" and not 参数.public_only and 令牌 is None and gateway_config() is None:
        raise ValueError("私有范围采集需要凭证：设置 POLY_TALLY_TOKEN 或显式使用 --git-credential；仅公开采集请指定 --public-only")
    if 参数.private_metrics_output and not 参数.include_private_metrics:
        参数器.error("--private-metrics-output 必须配合 --include-private-metrics，确认仅发布脱敏规模")
    if 令牌 is not None:
        os.environ["POLY_TALLY_TOKEN"] = 令牌
    if 参数.command in {"collect", "rebuild"} and not 参数.public_only:
        参数.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        参数.state.chmod(0o700)
    with ExitStack() as 锁栈:
        参数.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        参数.cache.chmod(0o700)
        # 不同统计批次也会写同一事实库，锁必须覆盖共享缓存而非仅覆盖 epoch。
        锁栈.enter_context(运行锁_类(参数.cache / "run.lock"))
        锁栈.enter_context(运行锁_类(参数.state / "run.lock"))
        采集器 = 采集器_类(配置, 参数.state, 令牌, 参数.public_only, 参数.private_only, 参数.dataset_epoch, json.loads(参数.expected_inventory.read_text()) if 参数.expected_inventory else None, 参数.cache)
        try:
            if 参数.import_checkpoint:
                采集器.api_恢复检查点(参数.import_checkpoint, 参数.authoritative_checkpoint)
            返回码 = 0
            match 参数.command:
                case "collect":
                    结果 = 采集器.api_采集()
                    print("[完成] " + json.dumps({键: 值 for 键, 值 in 结果.items() if 键 not in {"publicRun", "repositoryMeasurements"}}, ensure_ascii=False), flush=True)
                    返回码 = 1 if 结果["failed"] and not 参数.allow_partial else 0
                case "rebuild":
                    结果 = 采集器.api_离线重算(参数.from_state)
                    print("[完成] " + json.dumps({键: 值 for 键, 值 in 结果.items() if 键 != "publicRun"}, ensure_ascii=False), flush=True)
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
                            if 采集器.引擎.数据库.lineage_enabled:
                                expected = 采集器.引擎.数据库.连接.execute("SELECT value FROM metadata WHERE key='epochContract'").fetchone()
                                try:
                                    actual = 来源.execute("SELECT value FROM metadata WHERE key='epochContract'").fetchone()
                                except sqlite3.OperationalError:
                                    actual = None
                                if actual != expected:
                                    raise ValueError("backup epoch contract mismatch; cannot restore old state into rebuild")
                            来源.backup(采集器.引擎.数据库.连接)
                case "checkpoint" | "export":
                    pass
            导出开始 = time.perf_counter()
            if 参数.checkpoint:
                采集器.api_保存检查点(参数.checkpoint, True)
            if 参数.private_metrics_output:
                私有数据 = 私有规模导出_类(采集器.引擎.数据库, 采集器.规则).api_构建()
                公开导出_类.api_原子写入(参数.private_metrics_output, 私有数据)
            if 参数.command != "backup":
                已写入 = 公开导出_类(采集器.引擎.数据库, 采集器.规则, 参数.include_private_metrics).api_写入(参数.output, 参数.refresh)
                print(f"[信息] 公开数据{'已更新' if 已写入 else '无统计变化'}：{参数.output}", flush=True)
            if 参数.report and 参数.command in {"collect", "rebuild"}:
                公开导出_类.api_原子写入(参数.report, {"schemaVersion": 1, "collection": {键: 值 for 键, 值 in 结果.items() if 键 != "publicRun"}, "exportSeconds": round(time.perf_counter() - 导出开始, 6), "totalSeconds": round(time.perf_counter() - 开始, 6)})
            return 返回码
        finally:
            采集器.api_关闭()


# ◍ 运行
if __name__ == "__main__":
    raise SystemExit(主入口())
