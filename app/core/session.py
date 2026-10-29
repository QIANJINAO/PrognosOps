# 会话管理模块
# 内存会话的创建、查询与存储(设计文档 4.2 节)
# V1 纯内存存储,不落盘明文(规则:上传后数据存入后端会话,不落盘)
# 后续阶段将追加过期清理逻辑

import uuid
from dataclasses import dataclass
from datetime import datetime

from app.core.data_loader import ParsedData
from app.domain.models import DataQualityReport


@dataclass
class SessionData:
    """会话数据结构。

    Attributes:
        session_id: 会话标识(格式 sess_xxxxxxxx)
        created_at: 创建时间
        parsed_data: 解析后的数据(DataFrame + 元信息)
        quality_report: 数据质量报告
    """

    session_id: str
    created_at: datetime
    parsed_data: ParsedData
    quality_report: DataQualityReport


# 内存会话存储(session_id → SessionData)
_sessions: dict[str, SessionData] = {}


def create_session(parsed_data: ParsedData, quality_report: DataQualityReport) -> str:
    """创建新会话,存储解析数据与质量报告,返回 session_id。"""
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    _sessions[session_id] = SessionData(
        session_id=session_id,
        created_at=datetime.now(),
        parsed_data=parsed_data,
        quality_report=quality_report,
    )
    return session_id


def get_session(session_id: str) -> SessionData | None:
    """查询会话,不存在返回 None。"""
    return _sessions.get(session_id)


def clear_sessions() -> None:
    """清空所有会话(仅供测试使用)。"""
    _sessions.clear()