# ◑ 导入
import fcntl
from pathlib import Path
from types import TracebackType
from typing import IO


# ◕ 功能
class 运行锁_类:
    """
    同一状态目录只允许一个采集、恢复或导出进程，崩溃后系统自动释放。

    更新日志：
    2026.10.21 - 使用 POSIX 文件锁而非遗留 PID 判断。
    """

    def __init__(self, arg_路径: Path) -> None:
        self.路径 = arg_路径
        self.文件: IO[str] | None = None

    def __enter__(self) -> "运行锁_类":
        self.路径.parent.mkdir(parents=True, exist_ok=True)
        self.文件 = self.路径.open("a+")
        try:
            fcntl.flock(self.文件, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as 异常:
            self.文件.close()
            raise RuntimeError("已有进程正在使用此状态目录，请等待其完成") from 异常
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self.文件 is not None:
            self.文件.close()
