# PrognosOps - FastAPI 应用
# 与本地已通过测试的版本一致，满足 NumPy 2.5 的 Python >=3.12 要求
FROM python:3.14.4-slim

# 设置工作目录
WORKDIR /app

# 禁用字节码缓存,减少镜像体积
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# 先复制依赖文件并安装(利用 Docker 层缓存)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码与配置
COPY app/ ./app/
COPY config/ ./config/

# 平台仅暴露 8080 端口
EXPOSE 8080

# 生产启动命令:监听 0.0.0.0,端口从平台注入的 PORT 读取(默认 8080)
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}
