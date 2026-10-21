# ◑ 导入
import json
import math
import re


# ◕ 功能
type JSON值 = dict[str, JSON值] | list[JSON值] | str | int | float | bool | None


class 资产策略_类:
    """
    识别完整的蒙皮、烘焙动画和绑定导出结构，将资产载荷与程序配置区分。

    更新日志：
    2026.10.21 - 依据实际生成链路确定数据结构，不按 manifest 文件名或文件大小推断来源。
    """

    @classmethod
    def api_机器资产(cls, arg_文本: str) -> bool:
        if not any(键 in arg_文本 for 键 in ('"jointIndices"', '"librarySha256"', '"restLocal"')):
            return False
        try:
            数据 = json.loads(arg_文本)
        except (ValueError, RecursionError):
            # 不是完整 JSON 对象时不猜测资产来源，交还原有词法统计。
            return False
        return isinstance(数据, dict) and (cls._蒙皮网格(数据) or cls._烘焙动画(数据) or cls._绑定导出(数据))

    @staticmethod
    def _数值(arg_值: JSON值) -> bool:
        return type(arg_值) is int or (type(arg_值) is float and math.isfinite(arg_值))

    @classmethod
    def _向量(cls, arg_值: JSON值, arg_维度: int) -> bool:
        return isinstance(arg_值, list) and len(arg_值) == arg_维度 and all(cls._数值(项) for 项 in arg_值)

    @classmethod
    def _蒙皮网格(cls, arg_数据: dict) -> bool:
        if not {"positions", "triangles", "weights", "jointIndices", "joints"}.issubset(arg_数据):
            return False
        点, 面, 权重, 绑定, 骨骼 = (arg_数据[键] for 键 in ("positions", "triangles", "weights", "jointIndices", "joints"))
        if not all(isinstance(项, list) and 项 for 项 in (点, 面, 权重, 绑定, 骨骼)) or len(权重) != len(点) or len(绑定) != len(点):
            return False
        if not all(cls._向量(项, 3) for 项 in 点):
            return False
        if not all(isinstance(项, list) and len(项) == 3 and all(type(值) is int and 0 <= 值 < len(点) for 值 in 项) for 项 in 面):
            return False
        for 影响权重, 影响索引 in zip(权重, 绑定):
            if not isinstance(影响权重, list) or not isinstance(影响索引, list) or not 影响权重 or len(影响权重) != len(影响索引):
                return False
            if not all(cls._数值(值) and 值 >= 0 for 值 in 影响权重) or not all(type(值) is int and 0 <= 值 < len(骨骼) for 值 in 影响索引):
                return False
        return all(isinstance(项, dict) and {"name", "parent", "position"}.issubset(项) and isinstance(项["name"], str) and type(项["parent"]) is int and -1 <= 项["parent"] < len(骨骼) and cls._向量(项["position"], 3) for 项 in 骨骼)

    @staticmethod
    def _文件描述(arg_值: JSON值) -> bool:
        return isinstance(arg_值, dict) and {"file", "sha256", "bytes"}.issubset(arg_值) and isinstance(arg_值["file"], str) and bool(arg_值["file"]) and isinstance(arg_值["sha256"], str) and re.fullmatch(r"[0-9a-fA-F]{64}", arg_值["sha256"]) is not None and type(arg_值["bytes"]) is int and arg_值["bytes"] > 0

    @classmethod
    def _动画采样(cls, arg_值: JSON值) -> bool:
        if not isinstance(arg_值, dict) or not {"time", "feet", "pelvis", "root", "contacts"}.issubset(arg_值):
            return False
        脚, 接触 = arg_值["feet"], arg_值["contacts"]
        return cls._数值(arg_值["time"]) and cls._向量(arg_值["pelvis"], 3) and cls._向量(arg_值["root"], 3) and isinstance(脚, dict) and isinstance(接触, dict) and {"L", "R"}.issubset(脚) and {"L", "R"}.issubset(接触) and all(cls._向量(脚[侧], 3) and type(接触[侧]) is bool for 侧 in ("L", "R"))

    @classmethod
    def _烘焙动画(cls, arg_数据: dict) -> bool:
        if not {"librarySha256", "bakeFps", "sourceLibrary", "characters", "actions"}.issubset(arg_数据):
            return False
        if not isinstance(arg_数据["librarySha256"], str) or re.fullmatch(r"[0-9a-fA-F]{64}", arg_数据["librarySha256"]) is None or not cls._数值(arg_数据["bakeFps"]) or arg_数据["bakeFps"] <= 0 or not cls._文件描述(arg_数据["sourceLibrary"]):
            return False
        角色, 动作 = arg_数据["characters"], arg_数据["actions"]
        if not isinstance(角色, dict) or not 角色 or not isinstance(动作, dict) or not 动作:
            return False
        if not all(cls._文件描述(项) and {"rootMotion", "groundOffsets"}.issubset(项) and isinstance(项["rootMotion"], dict) and isinstance(项["groundOffsets"], dict) for 项 in 角色.values()):
            return False
        return all(isinstance(项, dict) and {"duration", "loop", "samples"}.issubset(项) and cls._数值(项["duration"]) and type(项["loop"]) is bool and isinstance(项["samples"], list) and bool(项["samples"]) and all(cls._动画采样(采样) for 采样 in 项["samples"]) for 项 in 动作.values())

    @classmethod
    def _绑定导出(cls, arg_数据: dict) -> bool:
        if not {"boneCount", "restLocal", "restPositions", "referencePositions", "parents", "map", "rolls"}.issubset(arg_数据):
            return False
        数量, 本地 = arg_数据["boneCount"], arg_数据["restLocal"]
        if type(数量) is not int or 数量 <= 0 or not isinstance(本地, list) or len(本地) != 数量:
            return False
        if not all(isinstance(项, dict) and {"semantic", "name", "position", "quaternion"}.issubset(项) and isinstance(项["semantic"], str) and isinstance(项["name"], str) and cls._向量(项["position"], 3) and cls._向量(项["quaternion"], 4) for 项 in 本地):
            return False
        for 键, 维度 in (("restPositions", 3), ("referencePositions", 3), ("rolls", 4)):
            表 = arg_数据[键]
            if not isinstance(表, dict) or not 表 or not all(cls._向量(项, 维度) for 项 in 表.values()):
                return False
        映射, 父表 = arg_数据["map"], arg_数据["parents"]
        return len(arg_数据["restPositions"]) == 数量 and isinstance(映射, dict) and bool(映射) and all(isinstance(值, str) for 值 in 映射.values()) and isinstance(父表, dict) and len(父表) == 数量 and all(值 is None or isinstance(值, str) for 值 in 父表.values())
