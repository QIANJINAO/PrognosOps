# 认证路由模块
# 提供简易登录/登出/令牌校验接口(演示用途,内存态账户与令牌)
# 账户存储:模块级字典(演示用,重启后失效;生产应替换为数据库 + 密码哈希)
# 令牌:secrets.token_urlsafe 生成,内存字典保存,有效期 12 小时

import secrets
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# 创建认证路由器,所有接口以 /api/auth 为前缀
auth_router = APIRouter(prefix="/api/auth")

# 令牌有效期(秒):12 小时
_TOKEN_TTL = 12 * 3600

# ──────────────────────────────────────────────
# 演示账户表(内存态)
# 生产环境应替换为数据库存储 + 密码哈希(如 bcrypt),此处仅演示登录闭环
# ──────────────────────────────────────────────
_DEMO_ACCOUNTS: dict[str, dict] = {
    "admin": {
        "password": "admin123",
        "display_name": "管理员",
        "role": "admin",
    },
    "engineer": {
        "password": "eng123",
        "display_name": "运维工程师",
        "role": "engineer",
    },
}

# 已签发令牌表:{token: {"username": ..., "display_name": ..., "role": ..., "issued_at": ...}}
_ACTIVE_TOKENS: dict[str, dict] = {}


# ──────────────────────────────────────────────
# 请求/响应模型
# ──────────────────────────────────────────────

class LoginRequest(BaseModel):
    """登录请求体。"""

    username: str
    password: str


class LoginResponse(BaseModel):
    """登录成功响应。"""

    token: str
    username: str
    display_name: str
    role: str
    expires_in: int  # 令牌剩余有效秒数


class VerifyResponse(BaseModel):
    """令牌校验响应。"""

    valid: bool
    username: str | None = None
    display_name: str | None = None
    role: str | None = None


# ──────────────────────────────────────────────
# 内部工具函数
# ──────────────────────────────────────────────

def _is_token_valid(token: str) -> dict | None:
    """校验令牌是否有效,有效则返回账户信息,否则返回 None。"""
    info = _ACTIVE_TOKENS.get(token)
    if info is None:
        return None
    # 检查是否过期
    if time.time() - info["issued_at"] > _TOKEN_TTL:
        _ACTIVE_TOKENS.pop(token, None)
        return None
    return info


# ──────────────────────────────────────────────
# 接口定义
# ──────────────────────────────────────────────

@auth_router.post("/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    """登录接口:校验用户名与密码,签发访问令牌。

    错误响应统一结构:{"code": "E6001", "message": "...", "detail": ""} → 401
    """
    account = _DEMO_ACCOUNTS.get(req.username)
    # 账户不存在或密码不符(统一提示,避免账户枚举)
    if account is None or account["password"] != req.password:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "E6001",
                "message": "用户名或密码错误",
                "detail": "",
            },
        )

    # 签发令牌
    token = secrets.token_urlsafe(32)
    _ACTIVE_TOKENS[token] = {
        "username": req.username,
        "display_name": account["display_name"],
        "role": account["role"],
        "issued_at": time.time(),
    }

    return LoginResponse(
        token=token,
        username=req.username,
        display_name=account["display_name"],
        role=account["role"],
        expires_in=_TOKEN_TTL,
    )


@auth_router.post("/logout")
async def logout(token: str = ""):
    """登出接口:撤销指定令牌。

    前端在登出时调用,后端从内存令牌表中移除该令牌。
    无论令牌是否存在都返回成功(幂等)。
    """
    _ACTIVE_TOKENS.pop(token, None)
    return {"status": "ok", "message": "已登出"}


@auth_router.get("/verify", response_model=VerifyResponse)
async def verify(token: str = ""):
    """令牌校验接口:前端启动时检查登录态是否有效。"""
    info = _is_token_valid(token)
    if info is None:
        return VerifyResponse(valid=False)
    return VerifyResponse(
        valid=True,
        username=info["username"],
        display_name=info["display_name"],
        role=info["role"],
    )