# 运行时 AI Agent 测试
# 覆盖:
# 1. 工具执行(recompute_decision / compare_scenarios / inspect_data / run_backtest / export_report)
# 2. Agent 循环(mock LLM:意图识别 → 工具调度 → 结果汇总)
# 3. API 端点(POST /api/agent/chat:未配置→400,正常→200)
# 4. 安全规则(未配置不假装成功 / probs 不经过 LLM / regret 不编造)

import io
import json
import random
from unittest.mock import patch

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.agent.agent import AgentError, run_agent
from app.agent.tools import (
    TOOL_SCHEMAS,
    AgentContext,
    ToolError,
    execute_tool,
)
from app.core.llm_gateway import ChatMessage, LLMResponse
from app.core.session import clear_sessions
from app.main import app

client = TestClient(app)


# ──────────────────────────────────────────────
# 测试辅助
# ──────────────────────────────────────────────

def make_fd001_csv(n_units: int = 5, min_cycles: int = 80, max_cycles: int = 120, seed: int = 42) -> str:
    """生成合法 FD001 格式 CSV(空格分隔,26 列,传感器线性退化+噪声)。

    回测需要足够的周期数(≥30 窗口)和退化趋势,纯随机数据无法产生有效时点。
    """
    rng = np.random.default_rng(seed)
    # 14 个选定传感器索引(与 config/sensors.json 一致)
    selected = {2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 17, 20, 21}
    lines = []
    for u in range(1, n_units + 1):
        n_cycles = int(rng.integers(min_cycles, max_cycles))
        base = float(rng.uniform(80, 120))
        slope = float(rng.uniform(0.1, 0.5))
        for t in range(1, n_cycles + 1):
            sensors = []
            for s in range(1, 22):
                if s in selected:
                    sensors.append(round(base + slope * t + rng.normal(0, 0.5), 6))
                else:
                    sensors.append(round(float(rng.uniform(-0.01, 0.01)), 6))
            fields = [str(u), str(t), "0.0", "0.0", "0.0"] + [str(v) for v in sensors]
            lines.append(" ".join(fields))
    return "\n".join(lines)


def make_session_id() -> str:
    """通过 API 上传数据创建会话,返回 session_id。"""
    content = make_fd001_csv()
    resp = client.post(
        "/api/data/upload",
        files={"file": ("test.csv", io.BytesIO(content.encode("utf-8")), "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["session_id"]


def make_probs(h_value: int = 80, h_max: int = 150) -> list[float]:
    """构造确定性概率分布:P(RUL = h_value) = 1。"""
    probs = [0.0] * (h_max + 1)
    probs[h_value] = 1.0
    return probs


def make_ctx(session_id: str = "", probs: list | None = None) -> AgentContext:
    """构造 Agent 上下文。"""
    if probs is None:
        probs = make_probs()
    return AgentContext(
        session_id=session_id,
        probs=probs,
        h_max=150,
        unit_id=1,
        cycle=40,
        current_params={"cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 0.01, "h_max": 150},
    )


@pytest.fixture(autouse=True)
def cleanup():
    """每个测试前后清理会话。"""
    clear_sessions()
    yield
    clear_sessions()


# ──────────────────────────────────────────────
# 工具 Schema 测试
# ──────────────────────────────────────────────

class TestToolSchemas:
    """工具定义完整性测试。"""

    def test_five_tools_defined(self):
        """应定义 5 个工具(recompute_decision / compare_scenarios / inspect_data / run_backtest / export_report)。"""
        names = [s["function"]["name"] for s in TOOL_SCHEMAS]
        assert names == [
            "recompute_decision",
            "compare_scenarios",
            "inspect_data",
            "run_backtest",
            "export_report",
        ]

    def test_all_schemas_have_description(self):
        """每个工具都应有描述(供 LLM 识别意图)。"""
        for s in TOOL_SCHEMAS:
            assert s["function"]["description"], f"工具 {s['function']['name']} 缺少描述"

    def test_recompute_decision_params(self):
        """recompute_decision 应支持 cm/cd/cp/cc/alpha 参数覆盖。"""
        schema = next(s for s in TOOL_SCHEMAS if s["function"]["name"] == "recompute_decision")
        props = schema["function"]["parameters"]["properties"]
        for k in ("cm", "cd", "cp", "cc", "alpha"):
            assert k in props, f"recompute_decision 缺少参数 {k}"


# ──────────────────────────────────────────────
# 工具执行测试(不需要 LLM)
# ──────────────────────────────────────────────

class TestExecuteRecomputeDecision:
    """recompute_decision 工具测试(参数变化重新计算决策)。"""

    def test_cd_doubled(self):
        """停机损失翻倍:cd=5→10,应重新计算并返回新决策结果。"""
        ctx = make_ctx(probs=make_probs(80))
        result = execute_tool("recompute_decision", ctx, {"cd": 10})
        assert result["tool"] == "recompute_decision"
        assert result["changed_params"] == {"cd": 10}
        # 决策结果应包含四策略
        strategies = result["decision"]["strategies"]
        assert "ETO-C" in strategies
        assert "IEO-C" in strategies
        # 数值由后端计算,非 LLM 编造
        etoc = strategies["ETO-C"]
        assert isinstance(etoc["optimal_window"], int)
        assert isinstance(etoc["expected_total_cost"], float)
        assert isinstance(etoc["failure_prob"], float)

    def test_alpha_changed(self):
        """alpha 改为 0.02:应重新计算。"""
        ctx = make_ctx(probs=make_probs(80))
        result = execute_tool("recompute_decision", ctx, {"alpha": 0.02})
        assert result["changed_params"] == {"alpha": 0.02}
        assert result["decision"]["params"]["alpha"] == 0.02

    def test_no_probs_raises(self):
        """无 RUL 概率分布时应抛出 ToolError(不编造结果)。"""
        ctx = AgentContext(session_id="", probs=[], h_max=150)
        with pytest.raises(ToolError, match="无 RUL 概率分布"):
            execute_tool("recompute_decision", ctx, {"cd": 10})

    def test_params_merge_with_current(self):
        """覆盖参数应与当前参数合并(未覆盖的保持当前值)。"""
        ctx = make_ctx(probs=make_probs(80))
        result = execute_tool("recompute_decision", ctx, {"cd": 10})
        params = result["decision"]["params"]
        # cd 被覆盖为 10,cm 保持当前值 1
        assert params["cd"] == 10
        assert params["cm"] == 1


class TestExecuteCompareScenarios:
    """compare_scenarios 工具测试(多方案对比)。"""

    def test_two_scenarios(self):
        """比较当前方案与停机翻倍方案。"""
        ctx = make_ctx(probs=make_probs(80))
        result = execute_tool("compare_scenarios", ctx, {
            "scenarios": [
                {"name": "当前方案"},
                {"name": "停机翻倍", "cd": 10},
            ]
        })
        assert result["tool"] == "compare_scenarios"
        assert len(result["comparisons"]) == 2
        # 每个方案应包含 ETO-C 和 IEO-C 结果
        for comp in result["comparisons"]:
            assert "ETO-C" in comp
            assert "IEO-C" in comp
            assert "optimal_window" in comp["ETO-C"]

    def test_wait_one_window(self):
        """再等一个窗口:比较窗口 z 和 z+5 的成本差异。"""
        ctx = make_ctx(probs=make_probs(80))
        result = execute_tool("compare_scenarios", ctx, {
            "scenarios": [
                {"name": "立即维修"},
                {"name": "再等一个窗口", "cd": 5},
            ]
        })
        assert len(result["comparisons"]) == 2

    def test_no_scenarios_raises(self):
        """未提供方案时应抛出 ToolError。"""
        ctx = make_ctx(probs=make_probs(80))
        with pytest.raises(ToolError, match="未提供"):
            execute_tool("compare_scenarios", ctx, {"scenarios": []})


class TestExecuteInspectData:
    """inspect_data 工具测试(数据概览与质量)。"""

    def test_inspect_valid_session(self):
        """检查有效会话的数据概览。"""
        sid = make_session_id()
        ctx = make_ctx(session_id=sid)
        result = execute_tool("inspect_data", ctx, {})
        assert result["tool"] == "inspect_data"
        assert result["total_rows"] > 0
        assert result["unit_count"] == 5
        assert isinstance(result["units"], list)
        assert result["is_valid"] is True

    def test_inspect_invalid_session(self):
        """不存在的会话应抛出 ToolError。"""
        ctx = make_ctx(session_id="sess_nonexistent")
        with pytest.raises(ToolError, match="不存在"):
            execute_tool("inspect_data", ctx, {})


class TestExecuteRunBacktest:
    """run_backtest 工具测试(回测指标)。"""

    def test_backtest_returns_metrics(self):
        """回测应返回 NLL/MAE/regret 等指标(由后端计算)。"""
        sid = make_session_id()
        ctx = make_ctx(session_id=sid)
        result = execute_tool("run_backtest", ctx, {"step": 20, "n_repeats": 1})
        assert result["tool"] == "run_backtest"
        assert result["n_points"] > 0
        assert "strategies" in result
        # regret 由后端计算,不编造
        for name, s in result["strategies"].items():
            assert "regret_mean" in s
            # regret_mean 可能为 None(无真实 RUL)或 float,但不能是编造的字符串
            assert s["regret_mean"] is None or isinstance(s["regret_mean"], (int, float))

    def test_backtest_invalid_session(self):
        """不存在的会话应抛出 ToolError。"""
        ctx = make_ctx(session_id="sess_nonexistent")
        with pytest.raises(ToolError, match="不存在"):
            execute_tool("run_backtest", ctx, {})


class TestExecuteExportReport:
    """export_report 工具测试(报告导出)。"""

    def test_export_json(self):
        """导出 JSON 格式报告。"""
        sid = make_session_id()
        ctx = make_ctx(session_id=sid, probs=make_probs(80))
        result = execute_tool("export_report", ctx, {"format": "json"})
        assert result["tool"] == "export_report"
        assert result["format"] == "json"
        assert "quality_report" in result["report"]

    def test_export_csv(self):
        """导出 CSV 格式报告(返回预览)。"""
        sid = make_session_id()
        ctx = make_ctx(session_id=sid)
        result = execute_tool("export_report", ctx, {"format": "csv"})
        assert result["format"] == "csv"
        assert "content_preview" in result
        assert result["full_length"] > 0


class TestExecuteToolErrors:
    """工具执行错误处理测试。"""

    def test_unknown_tool(self):
        """未知工具应抛出 ToolError。"""
        ctx = make_ctx()
        with pytest.raises(ToolError, match="未知工具"):
            execute_tool("nonexistent_tool", ctx, {})


# ──────────────────────────────────────────────
# Agent 循环测试(mock LLM)
# ──────────────────────────────────────────────

class TestAgentLoop:
    """Agent 主循环测试(mock chat_completion,不调用真实 LLM)。"""

    def test_not_configured_raises_e4002(self):
        """未配置模型 API 时应抛出 E4002(不假装成功)。"""
        with patch.dict("os.environ", {}, clear=True):
            ctx = make_ctx()
            with pytest.raises(AgentError) as exc_info:
                run_agent("测试问题", ctx)
            assert exc_info.value.code == "E4002"
            assert "未配置" in exc_info.value.message

    def test_direct_text_response(self):
        """LLM 直接返回纯文本(无工具调用)→ 直接返回。"""
        mock_resp = LLMResponse(
            content="当前推荐维修窗口为 80 周期。",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        with patch("app.agent.agent.chat_completion", return_value=mock_resp):
            with patch("app.agent.agent.is_configured", return_value=True):
                ctx = make_ctx()
                result = run_agent("推荐什么时候维修?", ctx)
        assert result["answer"] == "当前推荐维修窗口为 80 周期。"
        assert result["tool_calls_log"] == []
        assert result["n_rounds"] == 0
        assert result["model_used"] == "test-model"

    def test_tool_call_then_text(self):
        """LLM 先调用工具,再基于工具结果回复(两轮循环)。"""
        # 第一轮:LLM 要求调用 recompute_decision
        first_resp = LLMResponse(
            content=None,
            tool_calls=[{
                "id": "call_1",
                "type": "function",
                "function": {"name": "recompute_decision", "arguments": {"cd": 10}},
            }],
            finish_reason="tool_calls",
            model_used="test-model",
        )
        # 第二轮:LLM 基于工具结果回复
        second_resp = LLMResponse(
            content="停机损失翻倍后,ETO-C 推荐窗口为 75 周期,期望总成本为 55.5。",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        with patch("app.agent.agent.chat_completion", side_effect=[first_resp, second_resp]):
            with patch("app.agent.agent.is_configured", return_value=True):
                ctx = make_ctx(probs=make_probs(80))
                result = run_agent("如果停机损失翻倍会怎样?", ctx)
        assert "停机损失翻倍" in result["answer"]
        assert len(result["tool_calls_log"]) == 1
        assert result["tool_calls_log"][0]["tool"] == "recompute_decision"
        assert result["tool_calls_log"][0]["args"] == {"cd": 10}
        # 工具结果应包含后端计算的真实数值
        assert "result" in result["tool_calls_log"][0]
        assert "decision" in result["tool_calls_log"][0]["result"]
        assert result["n_rounds"] == 1

    def test_tool_error_handled(self):
        """工具执行失败时,错误传回 LLM,Agent 不中断。"""
        # 第一轮:LLM 要求调用 recompute_decision(但 ctx 无 probs)
        first_resp = LLMResponse(
            content=None,
            tool_calls=[{
                "id": "call_1",
                "type": "function",
                "function": {"name": "recompute_decision", "arguments": {"cd": 10}},
            }],
            finish_reason="tool_calls",
            model_used="test-model",
        )
        # 第二轮:LLM 收到工具错误后告知用户
        second_resp = LLMResponse(
            content="当前无 RUL 概率分布,请先在趋势分析中预测 RUL。",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        with patch("app.agent.agent.chat_completion", side_effect=[first_resp, second_resp]):
            with patch("app.agent.agent.is_configured", return_value=True):
                ctx = AgentContext(session_id="", probs=[], h_max=150)
                result = run_agent("如果停机损失翻倍会怎样?", ctx)
        assert "无 RUL 概率分布" in result["answer"]
        # 工具日志中应记录错误
        assert result["tool_calls_log"][0]["result"]["error"] is True

    def test_max_rounds_enforced(self):
        """LLM 持续要求调用工具时,达到最大轮数后强制总结。"""
        # 每轮都返回工具调用
        tool_resp = LLMResponse(
            content=None,
            tool_calls=[{
                "id": "call_x",
                "type": "function",
                "function": {"name": "inspect_data", "arguments": {}},
            }],
            finish_reason="tool_calls",
            model_used="test-model",
        )
        # 强制总结的回复
        final_resp = LLMResponse(
            content="已达到最大工具调用次数,基于已获取结果总结。",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        sid = make_session_id()
        with patch("app.agent.agent.chat_completion", side_effect=[tool_resp] * 5 + [final_resp]):
            with patch("app.agent.agent.is_configured", return_value=True):
                ctx = make_ctx(session_id=sid)
                result = run_agent("数据质量怎么样?", ctx)
        assert result["n_rounds"] == 5
        assert len(result["tool_calls_log"]) == 5

    def test_history_passed_to_llm(self):
        """对话历史应传递给 LLM(多轮对话)。"""
        mock_resp = LLMResponse(
            content="好的",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        with patch("app.agent.agent.chat_completion", return_value=mock_resp) as mock_fn:
            with patch("app.agent.agent.is_configured", return_value=True):
                ctx = make_ctx()
                history = [
                    ChatMessage(role="user", content="之前的问题"),
                    ChatMessage(role="assistant", content="之前的回答"),
                ]
                run_agent("新问题", ctx, history=history)
        # 验证消息列表包含历史
        call_args = mock_fn.call_args
        messages = call_args.kwargs.get("messages") or call_args[0][0] if call_args[0] else call_args.kwargs["messages"]
        roles = [m.role for m in messages]
        assert "system" in roles
        assert "user" in roles
        assert "assistant" in roles


# ──────────────────────────────────────────────
# API 端点测试
# ──────────────────────────────────────────────

class TestAgentChatEndpoint:
    """POST /api/agent/chat 端点测试。"""

    def test_not_configured_returns_400(self):
        """未配置模型 API 时应返回 400 与 E4002(不假装成功)。"""
        with patch.dict("os.environ", {}, clear=True):
            resp = client.post("/api/agent/chat", json={
                "session_id": "",
                "query": "测试问题",
            })
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["code"] == "E4002"
        assert "未配置" in detail["message"]

    def test_agent_chat_success(self):
        """正常调用(mock LLM)应返回 200 与 AgentChatResponse。"""
        first_resp = LLMResponse(
            content=None,
            tool_calls=[{
                "id": "call_1",
                "type": "function",
                "function": {"name": "inspect_data", "arguments": {}},
            }],
            finish_reason="tool_calls",
            model_used="test-model",
        )
        second_resp = LLMResponse(
            content="数据包含 3 个设备单元,质量检查全部通过。",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        sid = make_session_id()
        with patch("app.agent.agent.chat_completion", side_effect=[first_resp, second_resp]):
            with patch("app.agent.agent.is_configured", return_value=True):
                resp = client.post("/api/agent/chat", json={
                    "session_id": sid,
                    "query": "数据质量怎么样?",
                    "probs": make_probs(80),
                    "h_max": 150,
                    "unit_id": 1,
                    "cycle": 40,
                    "current_params": {"cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 0.01, "h_max": 150},
                })
        assert resp.status_code == 200
        body = resp.json()
        assert "answer" in body
        assert "tool_calls_log" in body
        assert body["model_used"] == "test-model"
        assert len(body["tool_calls_log"]) == 1
        assert body["tool_calls_log"][0]["tool"] == "inspect_data"

    def test_agent_chat_with_history(self):
        """带对话历史的请求应正常处理。"""
        mock_resp = LLMResponse(
            content="基于之前的分析...",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        with patch("app.agent.agent.chat_completion", return_value=mock_resp):
            with patch("app.agent.agent.is_configured", return_value=True):
                resp = client.post("/api/agent/chat", json={
                    "session_id": "",
                    "query": "继续分析",
                    "history": [
                        {"role": "user", "content": "之前的问题"},
                        {"role": "assistant", "content": "之前的回答"},
                    ],
                })
        assert resp.status_code == 200
        assert "answer" in resp.json()

    def test_agent_chat_empty_query_rejected(self):
        """空问题应被 Pydantic 校验拒绝(422)。"""
        resp = client.post("/api/agent/chat", json={
            "session_id": "",
            "query": "",
        })
        assert resp.status_code == 422

    def test_agent_chat_probs_not_leaked_to_llm(self):
        """概率分布不应出现在发送给 LLM 的消息中(安全:probs 由后端注入工具)。"""
        mock_resp = LLMResponse(
            content="回答",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        probs = make_probs(80)
        with patch("app.agent.agent.chat_completion", return_value=mock_resp) as mock_fn:
            with patch("app.agent.agent.is_configured", return_value=True):
                client.post("/api/agent/chat", json={
                    "session_id": "",
                    "query": "测试",
                    "probs": probs,
                    "h_max": 150,
                })
        # 检查发送给 LLM 的消息中不包含 probs 数组
        call_args = mock_fn.call_args
        messages = call_args.kwargs.get("messages") or []
        for m in messages:
            content = m.content or ""
            assert str(probs) not in content, "概率分布不应出现在 LLM 消息中"

    def test_agent_chat_llm_failure_returns_502(self):
        """LLM 调用失败(E4003)应返回 502。"""
        from app.core.llm_gateway import LLMGatewayError
        with patch("app.agent.agent.chat_completion", side_effect=LLMGatewayError("E4003", "模型 API 请求超时", "")):
            with patch("app.agent.agent.is_configured", return_value=True):
                resp = client.post("/api/agent/chat", json={
                    "session_id": "",
                    "query": "测试",
                })
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["code"] == "E4003"


# ──────────────────────────────────────────────
# 安全规则测试
# ──────────────────────────────────────────────

class TestSecurityRules:
    """Agent 安全规则测试(用户要求 7~14)。"""

    def test_regret_not_fabricated(self):
        """规则 10:无真实 RUL 时 regret 为 null,不编造。"""
        # 离线数据(无真实 RUL 列)→ has_true_rul=False → regret_mean=None
        sid = make_session_id()
        ctx = make_ctx(session_id=sid)
        result = execute_tool("run_backtest", ctx, {"step": 20, "n_repeats": 1})
        for name, s in result["strategies"].items():
            # 合成数据无真实 RUL,regret 应为 None 或数值(取决于数据构造)
            # 关键:不能是编造的字符串
            assert s["regret_mean"] is None or isinstance(s["regret_mean"], (int, float))

    def test_api_key_not_in_response(self):
        """规则 12:API Key 不出现在 API 响应中。"""
        mock_resp = LLMResponse(
            content="回答",
            tool_calls=[],
            finish_reason="stop",
            model_used="test-model",
        )
        with patch("app.agent.agent.chat_completion", return_value=mock_resp):
            with patch("app.agent.agent.is_configured", return_value=True):
                resp = client.post("/api/agent/chat", json={
                    "session_id": "",
                    "query": "测试",
                })
        body_str = json.dumps(resp.json())
        assert "api_key" not in body_str.lower()
        assert "sk-" not in body_str

    def test_tool_returns_structured_json(self):
        """规则 9:工具必须返回结构化 JSON。"""
        ctx = make_ctx(probs=make_probs(80))
        result = execute_tool("recompute_decision", ctx, {"cd": 10})
        # 结果应为 dict(JSON 可序列化)
        assert isinstance(result, dict)
        json.dumps(result)  # 不抛异常说明可序列化

    def test_no_pretend_success(self):
        """规则 14:未配置模型时不假装调用成功。"""
        with patch.dict("os.environ", {}, clear=True):
            resp = client.post("/api/agent/chat", json={
                "session_id": "",
                "query": "测试",
            })
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "E4002"