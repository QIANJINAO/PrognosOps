---
title: PrognosOps 维策
emoji: 🔧
colorFrom: blue
colorTo: green
sdk: docker
app_port: 8080
pinned: false
---

# PrognosOps 维策 · 决策导向的预测性维护智能体

> 不看预测准不准,只看这次检修值不值。

## 项目简介

PrognosOps 是面向设备运维工程师的预测性维护决策智能体。系统接收 NASA C-MAPSS FD001 传感器数据,估计剩余使用寿命(RUL)的概率分布,并基于成本与质量双目标给出最优维修窗口建议。

## 当前阶段

**项目骨架已搭建**,包含:
- FastAPI 后端框架,健康检查接口可用
- 分层目录结构(api / domain / services / agent)
- 基础测试套件

完整功能(数据上传、质量检查、RUL 估计、四种决策策略、离线回测、自然语言交互、导出)将在后续阶段逐步实现,详见 [docs/tasks.md](docs/tasks.md)。

## 目录结构

```
PrognosOps/
├─ app/                  # 后端应用
│  ├─ main.py            # 应用入口(FastAPI 实例)
│  ├─ api/               # API 路由层
│  ├─ domain/            # 领域模型层
│  ├─ services/          # 服务层(数值算法模块)
│  ├─ agent/             # 大模型网关模块
│  └─ static/            # 静态资源目录
├─ tests/                # 测试目录
├─ data/                 # 数据目录(演示数据)
├─ docs/                 # 设计文档
│  ├─ requirements.md    # 需求文档
│  ├─ design.md          # 设计文档
│  └─ tasks.md           # 实施任务列表
├─ requirements.txt      # Python 依赖
├─ .env.example          # 环境变量示例
└─ PROJECT_RULES.md      # 项目规则(最高开发规约)
```

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置环境变量(可选)

```bash
copy .env.example .env
# 编辑 .env 填入大模型 API Key(仅后端使用,规则 9)
```

### 3. 运行测试

```bash
pytest tests/ -v
```

### 4. 启动服务

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

### 5. 验证服务

- 健康检查:http://localhost:8080/api/health
- API 文档:http://localhost:8080/docs

## 技术栈

| 层 | 技术 |
|----|------|
| 后端框架 | Python 3.10+ / FastAPI |
| 数值计算 | numpy、scipy |
| 大模型调用 | httpx(OpenAI 兼容接口) |
| 测试 | pytest |
| 部署 | Docker(端口 8080) |

## 开发规则

所有开发必须遵守 [PROJECT_RULES.md](PROJECT_RULES.md),核心规则:
1. 分阶段迭代,每次只完成当前阶段
2. 所有关键数值由后端算法模块计算,大模型不得编造
3. API Key 仅存于后端环境变量
4. 无真实 RUL 标签时 regret 必须为 null
5. 所有代码注释使用中文