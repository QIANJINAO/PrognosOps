# PrognosOps 应用入口
# 维策 · 决策导向的预测性维护智能体
# 启动命令:uvicorn app.main:app --host 0.0.0.0 --port 8080
# 或直接运行:python app/main.py

import os
import sys

# 支持直接运行 python app/main.py(将项目根目录加入模块搜索路径)
if __name__ == "__main__" and __package__ is None:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 加载 .env 环境变量(在所有业务模块导入之前,确保 MODEL_API_KEY 等变量可用)
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router

# 创建 FastAPI 应用实例
app = FastAPI(
    title="PrognosOps",
    description="维策 · 决策导向的预测性维护智能体 —— 不看预测准不准,只看这次检修值不值",
    version="0.1.0",
)


# 全局异常处理器:捕获所有未处理的异常,返回结构化 500 响应(不泄露堆栈)
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """未捕获异常的兜底处理:返回 500 + E9999,响应体不含堆栈信息。"""
    return JSONResponse(
        status_code=500,
        content={
            "code": "E9999",
            "message": "服务器内部错误,请稍后重试",
            "detail": "",
        },
    )


# 注册 API 路由(含 /api/health 健康检查)
app.include_router(router)


# 根路径重定向说明,方便首次访问的用户了解入口
@app.get("/")
async def root():
    """根路径,返回服务基本信息与 API 文档入口。"""
    return {
        "service": "PrognosOps",
        "version": "0.1.0",
        "docs": "/docs",
        "health": "/api/health",
    }


# 挂载静态资源目录(前端页面将在后续阶段放入)
_static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=_static_dir), name="static")


# 支持通过 python app/main.py 直接启动服务
# HOST/PORT 从环境变量读取(云平台会注入 PORT),默认 0.0.0.0:8080
if __name__ == "__main__":
    import uvicorn

    _host = os.getenv("HOST", "0.0.0.0")
    _port = int(os.getenv("PORT", "8080"))
    uvicorn.run("app.main:app", host=_host, port=_port)