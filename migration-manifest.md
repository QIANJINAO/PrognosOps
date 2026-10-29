# PrognosOps 远程迁移清单

> 目标远程项目:PrognosOps-Remote(JoyCode 远程 Python 项目)
> 生成时间:2026-10-23
> 本地验证:194 测试全通过,/health 200,首页 200,监听 0.0.0.0:8080

---

## 1. 需要迁移的文件

### 应用源代码
| 路径 | 说明 |
|---|---|
| `app/__init__.py` | 应用包初始化 |
| `app/main.py` | FastAPI 启动入口(全局异常处理 + 静态挂载 + .env 加载) |
| `app/agent/__init__.py` | Agent 包初始化 |
| `app/agent/agent.py` | AI Agent 主循环(意图识别→工具调度→结果汇总) |
| `app/agent/tools.py` | 5 个后端工具(recompute_decision/compare_scenarios/inspect_data/run_backtest/export_report) |
| `app/api/__init__.py` | API 包初始化 |
| `app/api/routes.py` | 全部 REST API 路由 |
| `app/core/__init__.py` | 核心包初始化 |
| `app/core/backtest.py` | 离线回测引擎 |
| `app/core/config.py` | 传感器配置加载(相对路径解析) |
| `app/core/data_loader.py` | CSV 解析与校验 |
| `app/core/decision.py` | 四策略维修决策(ETO-C/ETO-Q/IEO-C/IEO-Q) |
| `app/core/features.py` | 特征工程(420 维滑动窗口) |
| `app/core/llm_gateway.py` | OpenAI 兼容 LLM 网关(DeepSeek 适配) |
| `app/core/quality.py` | 数据体检 |
| `app/core/rul.py` | Weibull 双参数 MLE + KNN 检索 |
| `app/core/session.py` | 内存会话管理 |
| `app/domain/__init__.py` | 领域包初始化 |
| `app/domain/models.py` | Pydantic 数据模型 |
| `app/services/__init__.py` | 服务包初始化 |

### 前端静态文件
| 路径 | 说明 |
|---|---|
| `app/static/index.html` | 单页前端 |
| `app/static/css/style.css` | 样式(含移动端适配) |
| `app/static/js/api.js` | API 调用层(全部相对路径 fetch) |
| `app/static/js/app.js` | 前端主逻辑 |
| `app/static/js/charts.js` | ECharts 图表 |
| `app/static/js/demo-data.js` | 演示数据生成 |

### 配置与依赖
| 路径 | 说明 |
|---|---|
| `config/sensors.json` | 14 个选定传感器配置 |
| `requirements.txt` | 固定版本依赖 |
| `.env.example` | 环境变量模板(不含真实值) |
| `Dockerfile` | 云部署镜像定义(python:3.11-slim) |
| `.dockerignore` | Docker 构建排除规则 |
| `README.md` | 项目说明 |

### 测试(可选,用于远程验证)
| 路径 | 说明 |
|---|---|
| `tests/`(排除调试脚本) | 194 项测试 |

---

## 2. 禁止迁移的文件

| 路径 | 原因 |
|---|---|
| `.env` | **含真实 API Key,严禁迁移** |
| `.git/` | 版本控制元数据 |
| `.venv/`、`venv/` | 虚拟环境 |
| `__pycache__/` | Python 字节码缓存 |
| `.pytest_cache/` | 测试缓存 |
| `data/`(除 .gitkeep) | 用户上传的隐私数据 |
| `.joycode/` | JoyCode IDE 本地配置与记忆 |
| `tests/_debug_agent.py` | 调试脚本 |
| `tests/_test_deepseek.py` | 调试脚本 |
| `*.log` | 运行日志 |
| `PROJECT_RULES.md` | 本地开发规则(非运行必需) |
| `docs/` | 设计文档(非运行必需,可选迁移) |

---

## 3. 环境变量清单

> 以下仅列出变量名与默认值,**不含任何真实密钥**。真实值需在远程环境单独配置。

| 变量名 | 用途 | 默认值 | 必填 |
|---|---|---|---|
| `MODEL_API_KEY` | LLM API 密钥 | (空) | 是(Agent 功能) |
| `MODEL_BASE_URL` | LLM API 地址 | `https://api.deepseek.com` | 否 |
| `MODEL_NAME` | 模型名称 | `deepseek-chat` | 否 |
| `MODEL_TIMEOUT` | 请求超时(秒) | `60` | 否 |
| `HOST` | 监听地址 | `0.0.0.0` | 否(平台注入) |
| `PORT` | 监听端口 | `8080` | 否(平台注入) |

---

## 4. 远程项目启动命令

```bash
# 安装依赖
pip install -r requirements.txt

# 生产启动(与 Dockerfile CMD 一致)
uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}
```

---

## 5. 远程部署验证步骤

1. 访问 `/api/health` → 期望返回 `{"status":"ok",...}` 且 HTTP 200
2. 访问 `/static/index.html` → 期望 HTTP 200
3. 上传 NASA C-MAPSS FD001 格式 CSV(26 列)→ 期望返回 session_id
4. 运行 RUL 预测 → 期望返回 Weibull 参数与离散分布
5. 运行维修决策 → 期望返回四策略对比
6. (配置 MODEL_API_KEY 后)Agent 对话 → 期望返回结构化结果

---

## 6. 已知限制

1. **AI Agent 功能依赖 MODEL_API_KEY**:未配置时调用 Agent 返回 E4002 错误(设计行为,不假装成功)
2. **数据仅存内存会话**:服务重启后会话丢失,无持久化存储
3. **仅支持 CSV 格式**:NASA C-MAPSS FD001 26 列格式(含 unit/cycle/setting3/sensor21)
4. **无数据库依赖**:全部计算在内存完成,适合演示与中小规模数据
5. **Linux 大小写**:所有模块名与文件名均为小写,已在本地验证无大小写敏感问题
6. **无 Windows 绝对路径**:config.py 使用 `os.path` 相对路径解析,已 grep 确认零匹配