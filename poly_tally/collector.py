# ◑ 导入
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time

import requests

from poly_tally.engine import 历史引擎_类
from poly_tally.export import 公开导出_类
from poly_tally.github import GitHub发现器_类
from poly_tally.rules import 规则_类
from poly_tally.rebuild import 离线重算器_类
from poly_tally.lineage import validate_groups, member_names, lineage_version, collapse_repositories


# ◕ 功能
class 采集器_类:
    """
    自动发现与调度仓库扫描，外部故障保留最后成功版本并公开可见状态。

    更新日志：
    2026.10.21 - 缺失不等于删除，只有显式归档产生永久冷数据。
    2026.10.22 - 支持从本地已知 HEAD 离线重算新规则批次。
    """

    def __init__(
        self,
        arg_配置: dict,
        arg_目录: Path,
        arg_令牌: str | None,
        arg_仅公开: bool,
        arg_仅私有: bool = False,
        arg_数据批次: str | None = None,
        arg_预期清单: dict | None = None,
        arg_缓存目录: Path | None = None,
    ) -> None:
        self.配置 = arg_配置
        if not arg_配置["owners"]:
            raise ValueError("owners 至少包含一个账号或组织")
        self.规则 = 规则_类(arg_配置["rules"])
        self.引擎 = 历史引擎_类(arg_目录, self.规则, arg_缓存目录)
        self.数据批次 = arg_数据批次
        self.引擎.数据库.数据批次 = arg_数据批次
        self.同源组 = validate_groups(arg_配置.get("lineageGroups", []))
        self.成员名称 = member_names(self.同源组)
        self.引擎.数据库.lineage_groups = self.同源组
        self.引擎.数据库.lineage_enabled = "lineageGroups" in arg_配置
        if "lineageGroups" in arg_配置:
            try:
                self.引擎.数据库.api_绑定批次(arg_数据批次, self.规则.版本 + ":" + lineage_version(self.同源组))
            except ValueError:
                self.引擎.api_关闭()
                raise
        self.发现器 = GitHub发现器_类(arg_令牌, arg_仅公开)
        self.仅公开 = arg_仅公开
        self.仅私有 = arg_仅私有
        self.预期清单 = self._校验预期清单(arg_预期清单) if arg_预期清单 is not None else []

    def api_采集(self) -> dict:
        开始 = time.monotonic()
        基线 = self.引擎.计数.copy()
        阶段总基线 = self.引擎.阶段耗时.copy()
        失败 = 0
        发现完整 = True
        缺成员 = 0
        预期 = {item["id"] for item in self.预期清单 if
            (not item["archived"] or item["name"].casefold() in self.成员名称)
            and (self._名称在范围(item["name"]) or item["name"].casefold() in self.成员名称)
            and (not self.仅公开 or item["visibility"] == "public")
            and (not self.仅私有 or item["visibility"] == "private" or item["name"].casefold() in self.成员名称)}
        清单预期 = 预期.copy()
        已扫描 = set()
        公开失败 = 0
        公开计数 = {键: 0 for 键 in 基线}
        公开阶段 = {键: 0.0 for 键 in self.引擎.阶段耗时}
        仓库测量 = []
        已见: set[str] = set()
        已知 = {仓库["id"]: 仓库 for 仓库 in self.引擎.api_仓库列表()}
        for 仓库 in 已知.values():
            if self.仅公开 and 仓库["private"]:
                continue
            if 仓库["status"] == "cold" and 仓库["rulesVersion"] != self.规则.版本:
                try:
                    self.引擎.api_重算冷数据(仓库["id"])
                except (RuntimeError, OSError, subprocess.TimeoutExpired):
                    仓库["notice"] = "冷数据源码对象不可用，保留旧规则版本；已隔离出当前口径汇总"
                    self.引擎.数据库.api_保存仓库(仓库)
        已知 = {仓库["id"]: 仓库 for 仓库 in self.引擎.api_仓库列表()}
        发现开始 = time.perf_counter()
        try:
            元数据表 = self.发现器.api_发现(self.配置["owners"])
        except (requests.RequestException, ValueError) as 异常:
            发现完整 = False
            for 仓库 in 已知.values():
                if 仓库["status"] not in {"cold", "archived"}:
                    self._失败状态(仓库, "仓库发现失败；保留最后成功历史，等待下一轮重试")
            失败 = max(1, len(已知))
            公开失败 = max(1, sum(not 项["private"] for 项 in 已知.values()))
            元数据表 = []
            已见.update(已知)
        发现耗时 = time.perf_counter() - 发现开始
        # Explicit groups must be complete, including archived/public members in
        # a private job. Public-only cannot prove private access and defers groups.
        if not self.仅公开:
            发现名称 = {item["full_name"].casefold() for item in 元数据表}
            for 名称 in sorted(self.成员名称 - 发现名称):
                try:
                    元数据表.append(self.发现器.api_读取仓库(名称))
                except (requests.RequestException, ValueError):
                    缺成员 += 1
                    失败 += 1
        for 元数据 in 元数据表:
            ID = str(元数据["id"])
            已见.add(ID)
            旧状态 = 已知[ID] if ID in 已知 else None
            if 旧状态:
                旧状态.update({"private": 元数据["private"], "name": 元数据["full_name"], "url": f"https://github.com/{元数据['full_name']}"})
                self.引擎.数据库.api_保存仓库(旧状态)
            是成员 = 元数据["full_name"].casefold() in self.成员名称
            if 元数据.get("archived") is True and not 是成员:
                self._排除归档(元数据)
                continue
            if self.仅私有 and not 元数据["private"] and not 是成员:
                continue
            # 显式确认的冷数据不会因同名或列表重新出现而自动激活。
            if 旧状态 and 旧状态["status"] == "cold" and not 是成员:
                continue
            if self.仅公开 and 元数据["private"]:
                continue
            范围内 = self._纳入(元数据)
            if not 范围内:
                if 旧状态:
                    旧状态.update({"status": "excluded", "private": 元数据["private"], "name": 元数据["full_name"], "notice": "当前账号或全局仓库规则已排除；已采集历史仍保留"})
                    self.引擎.数据库.api_保存仓库(旧状态)
                continue
            预期.add(ID)
            仓库基线 = self.引擎.计数.copy()
            阶段基线 = self.引擎.阶段耗时.copy()
            仓库开始 = time.perf_counter()
            try:
                print(f"[开始] 扫描仓库 {元数据['full_name']}", flush=True)
                HEAD = self.发现器.api_读取默认分支(元数据)
                if HEAD is None:
                    if 旧状态 and 旧状态["history"]:
                        raise RuntimeError("默认分支暂不可用；不清空已采集历史")
                    状态 = self._空状态(元数据)
                    self.引擎.数据库.api_保存仓库(状态)
                else:
                    # Archived is a scan exclusion only for ordinary repositories.
                    self.引擎.api_同步({**元数据, "archived": False} if 是成员 else 元数据, 元数据["clone_url"], HEAD)
                已扫描.add(ID)
            except (requests.RequestException, RuntimeError, OSError, subprocess.TimeoutExpired) as 异常:
                状态 = 旧状态 or self._空状态(元数据)
                状态["private"] = 元数据["private"]
                if 旧状态 and (旧状态["branch"] != 元数据["default_branch"] or 旧状态["rulesVersion"] != self.规则.版本):
                    self._失败状态(状态, "默认分支或规则已变，重建失败；当前显示上次成功版本", "stale")
                else:
                    self._失败状态(状态, f"本次扫描失败（{type(异常).__name__}）；保留最后成功历史")
                失败 += 1
                if not 元数据["private"]:
                    公开失败 += 1
                print(f"[警告] 仓库 {元数据['full_name']} 扫描失败，已保留最后成功结果", flush=True)
            finally:
                仓库测量.append({"repository": 元数据["full_name"], "durationSeconds": round(time.perf_counter() - 仓库开始, 6), "success": ID in 已扫描, "counters": {键: self.引擎.计数[键] - 仓库基线[键] for 键 in 仓库基线}, "phases": {键: round(self.引擎.阶段耗时[键] - 阶段基线[键], 6) for 键 in 阶段基线}})
                if not 元数据["private"]:
                    for 键 in 公开计数:
                        公开计数[键] += self.引擎.计数[键] - 仓库基线[键]
                    for 键 in 公开阶段:
                        公开阶段[键] += self.引擎.阶段耗时[键] - 阶段基线[键]
        for ID, 状态 in 已知.items():
            if self.仅私有 and not 状态["private"] and 状态["name"].casefold() not in self.成员名称:
                continue
            if ID in 已见:
                continue
            if 状态["status"] in {"cold", "archived"}:
                try:
                    元数据 = self.发现器.api_读取仓库(状态["name"])
                    if str(元数据["id"]) == ID:
                        状态.update({"private": 元数据["private"], "name": 元数据["full_name"], "url": f"https://github.com/{元数据['full_name']}"})
                        if 元数据.get("archived") is True:
                            self._排除归档(元数据)
                        else:
                            self.引擎.数据库.api_保存仓库(状态)
                except requests.RequestException:
                    # 已确认删除的冷数据本就可能 404；读取不到新元数据不撤销历史授权。
                    状态["notice"] = "冷数据元数据不可访问；保留已授权的历史档案与原口径"
                    self.引擎.数据库.api_保存仓库(状态)
                continue
            if not self._名称在范围(状态["name"]):
                状态.update({"status": "excluded", "notice": "已移出授权账号或仓库纳入范围；历史保留"})
                self.引擎.数据库.api_保存仓库(状态)
                continue
            try:
                # 列表缺失可能源于改名、转移、权限变化，不能凭一次缺失判定删除。
                元数据 = self.发现器.api_读取仓库(状态["name"])
                if str(元数据["id"]) != ID:
                    raise RuntimeError("原仓库地址被其他仓库复用")
                状态["name"] = 元数据["full_name"]
                状态["url"] = f"https://github.com/{元数据['full_name']}"
                状态["private"] = 元数据["private"]
                if 元数据.get("archived") is True:
                    self._排除归档(元数据)
                    continue
                提示 = "仓库未出现在完整发现列表中；保留历史，等待下一次发现确认"
            except (requests.RequestException, RuntimeError):
                提示 = "仓库缺失或无访问权限；尚未确认删除，保留最后成功历史"
            self._失败状态(状态, 提示)
            失败 += 1
            if not 状态["private"]:
                公开失败 += 1
        if 清单预期 - 已扫描:
            失败 = max(失败, len(清单预期 - 已扫描))
            if self.仅公开:
                公开失败 = max(公开失败, len(清单预期 - 已扫描))
        仓库表 = [项 for 项 in self.引擎.api_仓库列表() if 项["status"] != "archived"]
        公共运行 = {"finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "durationSeconds": round(time.monotonic() - 开始, 3), "repositories": sum(not 项["private"] for 项 in 仓库表), "failed": 公开失败, **公开计数}
        公共运行["phases"] = {键: round(值, 6) for 键, 值 in 公开阶段.items()}
        运行 = {**公共运行, "repositories": len(仓库表), "failed": 失败, **{键: self.引擎.计数[键] - 基线[键] for 键 in 基线}, "publicRun": 公共运行, "phases": {"discoverySeconds": round(发现耗时, 6), **{键: round(值 - 阶段总基线[键], 6) for 键, 值 in self.引擎.阶段耗时.items()}}, "repositoryMeasurements": 仓库测量}
        if self.引擎.数据库.lineage_enabled:
            if not self.仅公开:
                try:
                    collapse_repositories(self.引擎.api_仓库列表(), self.同源组, self.规则.版本)
                except ValueError:
                    失败 = max(失败, 1)
                    运行["failed"] = 失败
            完整性 = {"complete": 发现完整 and 失败 == 0 and 缺成员 == 0 and 预期 == 已扫描, "discoveryComplete": 发现完整, "expectedRepositories": len(预期) + 缺成员, "scannedRepositories": len(已扫描), "missingMembers": 缺成员, "failed": 失败}
            运行["completeness"] = 完整性
            公共运行["completeness"] = {**完整性, "complete": 发现完整 and 公开失败 == 0, "expectedRepositories": sum(not item["private"] and item["id"] in 预期 for item in 仓库表), "scannedRepositories": sum(not item["private"] and item["id"] in 已扫描 for item in 仓库表), "missingMembers": 0, "failed": 公开失败}
        self.引擎.数据库.api_记录运行(运行)
        return 运行

    def api_离线重算(self, arg_来源目录: Path) -> dict:
        return 离线重算器_类(self).api_运行(arg_来源目录)

    @staticmethod
    def _校验预期清单(inventory: dict) -> list[dict]:
        # Optional fresh metadata audit, not old statistics and not a permanent
        # manually curated repository allow-list. Discovery remains automatic.
        if not isinstance(inventory, dict) or not isinstance(inventory.get("source"), str) or not isinstance(inventory.get("verifiedAt"), str) or not isinstance(inventory.get("repositories"), list):
            raise ValueError("invalid expected inventory")
        datetime.fromisoformat(inventory["verifiedAt"])
        ids = set()
        for item in inventory["repositories"]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or item["id"] in ids or not isinstance(item.get("name"), str) or item.get("visibility") not in {"private", "public"} or type(item.get("archived")) is not bool:
                raise ValueError("invalid expected repository inventory")
            ids.add(item["id"])
        return inventory["repositories"]

    def _排除归档(self, arg_元数据: dict) -> None:
        # 只保留稳定 ID 的归档证据，不保留可进入统计的旧历史、HEAD 或文件清单。
        状态 = self._空状态(arg_元数据)
        状态.update({"status": "archived", "notice": "GitHub 已归档；不参与任何统计"})
        self.引擎.数据库.api_保存仓库(状态)

    def _名称在范围(self, arg_全名: str) -> bool:
        所有者 = arg_全名.split("/")[0].casefold()
        return 所有者 in {账号.casefold() for 账号 in self.配置["owners"]} and any(规则_类.api_匹配(arg_全名.casefold(), 模式.casefold()) for 模式 in self.配置["repositories"]["include"]) and not any(规则_类.api_匹配(arg_全名.casefold(), 模式.casefold()) for 模式 in self.配置["repositories"]["exclude"])

    def _纳入(self, arg_元数据: dict) -> bool:
        if arg_元数据["full_name"].casefold() in self.成员名称:
            return True
        return not arg_元数据.get("archived", False) and self._名称在范围(arg_元数据["full_name"]) and (not arg_元数据["fork"] or self.规则.配置["include_forks"])

    def _空状态(self, arg_元数据: dict) -> dict:
        return {"id": str(arg_元数据["id"]), "name": arg_元数据["full_name"], "url": f"https://github.com/{arg_元数据['full_name']}", "branch": arg_元数据["default_branch"], "head": None, "private": arg_元数据["private"], "status": "empty", "lastSuccessAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "rulesVersion": self.规则.版本, "historyComplete": True, "notice": "等待首个提交", "history": [], "inventory": {}, "skippedFiles": 0}

    def _失败状态(
        self,
        arg_状态: dict,
        arg_说明: str,
        arg_状态名: str = "inaccessible",
    ) -> None:
        arg_状态.update({"status": arg_状态名, "notice": arg_说明})
        self.引擎.数据库.api_保存仓库(arg_状态)

    def api_归档(self, arg_ID: str) -> None:
        状态 = self.引擎.数据库.api_读取仓库(arg_ID)
        if 状态 is None:
            raise ValueError(f"未找到已采集仓库 ID：{arg_ID}")
        状态.update({"status": "cold", "notice": "已明确确认删除或停止跟踪；永久保留最后成功历史。旧口径不能混入新口径总量。"})
        self.引擎.数据库.api_保存仓库(状态)

    def api_激活(self, arg_ID: str) -> None:
        状态 = self.引擎.数据库.api_读取仓库(arg_ID)
        if 状态 is None:
            raise ValueError(f"未找到已采集仓库 ID：{arg_ID}")
        状态.update({"status": "inaccessible", "notice": "已请求恢复跟踪，等待下一次成功扫描"})
        self.引擎.数据库.api_保存仓库(状态)

    def api_保存检查点(self, arg_路径: Path, arg_仅公开: bool = False) -> bool:
        仓库表 = self.引擎.api_仓库列表()
        if arg_仅公开:
            仓库表 = [项 for 项 in 仓库表 if not 项["private"]]
        if any(项["private"] for 项 in 仓库表):
            raise ValueError("公开检查点禁止包含私有仓库；私有状态请使用 SQLite backup")
        数据 = {"schemaVersion": 1, "repositories": 仓库表, "generatedAt": datetime.now(timezone.utc).isoformat()}
        if self.引擎.数据库.lineage_enabled:
            数据["lineageVersion"] = lineage_version(self.同源组)
        if self.数据批次:
            数据["datasetEpoch"] = self.数据批次
            运行 = self.引擎.数据库.api_最近运行()
            数据["collection"] = 运行[0].get("publicRun", {}) if 运行 else {}
        if arg_路径.exists() and 公开导出_类.api_指纹(json.loads(arg_路径.read_text())) == 公开导出_类.api_指纹(数据):
            return False
        公开导出_类.api_原子写入(arg_路径, 数据)
        return True

    def api_恢复检查点(self, arg_路径: Path, arg_覆盖: bool = False) -> None:
        数据 = json.loads(arg_路径.read_text())
        if not isinstance(数据, dict) or "schemaVersion" not in 数据 or type(数据["schemaVersion"]) is not int or 数据["schemaVersion"] != 1:
            raise ValueError("不支持的检查点版本或结构")
        if "generatedAt" not in 数据 or not isinstance(数据["generatedAt"], str) or "repositories" not in 数据 or not isinstance(数据["repositories"], list):
            raise ValueError("检查点缺少生成时间或仓库列表")
        if self.数据批次 and 数据.get("datasetEpoch") != self.数据批次:
            raise ValueError("检查点批次不匹配；新批次必须从当前默认分支重新采集")
        if self.引擎.数据库.lineage_enabled and 数据.get("lineageVersion") != lineage_version(self.同源组):
            raise ValueError("检查点 lineage epoch 契约不匹配；禁止旧数据进入重算")
        已见: set[str] = set()
        写入: list[tuple[str, str]] = []
        for 仓库 in 数据["repositories"]:
            self._校验检查点仓库(仓库)
            if 仓库["id"] in 已见:
                raise ValueError("检查点存在重复仓库 ID")
            已见.add(仓库["id"])
            写入.append((仓库["id"], json.dumps(仓库, ensure_ascii=False, allow_nan=False)))
        # 持久分支检查点可覆盖较旧的 Actions 缓存；完整验证后才启动原子写入。
        语句 = "INSERT OR REPLACE INTO repositories(id,state) VALUES(?,?)" if arg_覆盖 else "INSERT OR IGNORE INTO repositories(id,state) VALUES(?,?)"
        with self.引擎.数据库.连接:
            if arg_覆盖:
                # 权威公开检查点的缺失项可能已撤销公开，不能从较旧缓存复活。
                # 真正的本地私有记录仍留在 SQLite，公开备份不是其删除授权。
                缓存表 = self.引擎.api_仓库列表()
                self.引擎.数据库.连接.executemany("DELETE FROM repositories WHERE id=?", [(项["id"],) for 项 in 缓存表 if not 项["private"] and 项["id"] not in 已见])
                私有ID = {项["id"] for 项 in 缓存表 if 项["private"]}
                写入 = [项 for 项 in 写入 if 项[0] not in 私有ID]
            self.引擎.数据库.连接.executemany(语句, 写入)

    @staticmethod
    def _校验检查点仓库(arg_仓库: dict) -> None:
        if not isinstance(arg_仓库, dict):
            raise ValueError("检查点仓库必须是对象")
        类型表 = {"id": str, "name": str, "url": str, "branch": (str, type(None)), "head": (str, type(None)), "private": bool, "status": str, "lastSuccessAt": str, "rulesVersion": str, "historyComplete": bool, "notice": str, "history": list, "inventory": dict, "skippedFiles": int}
        for 字段, 类型 in 类型表.items():
            if 字段 not in arg_仓库 or not isinstance(arg_仓库[字段], 类型):
                raise ValueError(f"检查点仓库字段缺失或类型错误：{字段}")
        if arg_仓库["private"] is not False:
            raise ValueError("公开检查点出现私有记录")
        if not arg_仓库["id"] or arg_仓库["status"] not in {"active", "archived", "empty", "cold", "excluded", "inaccessible", "stale"}:
            raise ValueError("检查点仓库 ID 或状态无效")
        if type(arg_仓库["skippedFiles"]) is not int or arg_仓库["skippedFiles"] < 0:
            raise ValueError("检查点跳过文件数无效")
        for 提交 in arg_仓库["history"]:
            if not isinstance(提交, dict) or any(字段 not in 提交 or not isinstance(提交[字段], str) for 字段 in ("sha", "timestamp", "committedAt", "authoredAt")):
                raise ValueError("检查点历史记录缺失提交标识或时间")
            if "metrics" not in 提交 or "languages" not in 提交 or not isinstance(提交["languages"], dict):
                raise ValueError("检查点历史记录缺失指标或语言表")
            采集器_类._校验检查点指标(提交["metrics"])
            for 语言, 指标 in 提交["languages"].items():
                if not isinstance(语言, str):
                    raise ValueError("检查点语言名称必须是字符串")
                采集器_类._校验检查点指标(指标)
        for 路径, 文件 in arg_仓库["inventory"].items():
            if not isinstance(路径, str) or not isinstance(文件, dict) or "oid" not in 文件 or not isinstance(文件["oid"], str):
                raise ValueError("检查点文件清单结构无效")

    @staticmethod
    def _校验检查点指标(arg_指标: dict) -> None:
        if not isinstance(arg_指标, dict) or any(键 not in arg_指标 or type(arg_指标[键]) is not int or arg_指标[键] < 0 for 键 in ("code", "comment", "blank", "documentation", "files")):
            raise ValueError("检查点行指标缺失或不是非负整数")

    def api_关闭(self) -> None:
        self.引擎.api_关闭()
        self.发现器.会话.close()
