# 运行时 AI Agent 模块
# 职责:意图识别 → 工具调度 → 结构化结果 → 自然语言汇总
#
# 核心循环:
#   1. 接收用户问题 + AgentContext(含 probs/session,不经过 LLM)
#   2. 构建 system prompt(约束 LLM 不计算数值/不编造 regret)
#   3. 调用 LLM(携带工具定义)→ LLM 返回 tool_calls 或直接回复
#   4. 执行工具(后端核心计算)→ 将结果作为 tool 消息回传 LLM
#   5. 循环直到 LLM 返回纯文本回复(最多 MAX_TOOL_ROUNDS 轮)
#   6. 返回最终回复 + 工具调用记录

import json
import logging

from app.agent.tools import (
    TOOL_SCHEMAS,
    AgentContext,
    ToolError,
    execute_tool,
)
from app.core.llm_gateway import (
    ChatMessage,
    LLMGatewayError,
    LLMResponse,
    chat_completion,
    is_configured,
)

logger = logging.getLogger(__name__)

# 最大工具调用轮数(防止无限循环)
MAX_TOOL_ROUNDS = 5

# Agent 层错误码
AGENT_ERROR_CODE = "E4004"


class AgentError(Exception):
    """Agent 执行异常。"""

    def __init__(self, code: str, message: str, detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message}")


# ──────────────────────────────────────────────
# 系统提示词(约束大模型行为)
# ──────────────────────────────────────────────

SYSTEM_PROMPT = """你是 PrognosOps(维策)设备维修决策系统的运行时助手。

## 你的职责
帮助用户理解维修决策结果、分析参数变化影响、比较方案、检查数据质量、解读回测指标。

## 严格规则(违反将导致错误结果)
1. **禁止自行计算任何数值**。所有概率、成本、regret、窗口、指标必须来自工具返回的结构化结果。
2. **禁止编造 regret**。regret 只能来自 run_backtest 工具;若工具返回 null,如实告知用户"无真实 RUL 标签,无法计算 regret"。
3. **必须调用工具获取数据**。回答用户问题前,先判断需要哪个工具,调用后基于返回的 JSON 组织回答。
4. **只引用工具返回的真实数值**。回答中出现的每个数字都必须能在工具结果中找到对应。
5. **不确定时如实说明**。如果工具未返回某项数据,告知用户当前无法获取,不要猜测。

## 可用工具
- **recompute_decision**:用户问"如果 XX 参数改为 YY 会怎样"时调用。传入变更的参数(cm/cd/cp/cc/alpha),系统用当前 RUL 分布重新计算。
- **compare_scenarios**:用户问"比较方案 A 和 B""再等一个窗口多花多少钱"时调用。传入多组参数配置。
- **inspect_data**:用户问数据质量、单元数量、数据规模时调用。无需参数。
- **run_backtest**:用户问 regret、NLL、MAE、校准、失效频率时调用。
- **export_report**:用户要求导出报告/生成 JSON/下载 CSV 时调用。

## 当前会话上下文(系统注入,可信)
- 设备单元: {unit_id}
- 预测时点: 第 {cycle} 周期
- 当前决策参数: cm={cm}, cd={cd}, cp={cp}, cc={cc}, alpha={alpha}
- RUL 分布: 已由系统注入工具,无需你传递

## 回答风格
- 用中文回答,简洁专业。
- 引用数值时保留工具返回的精度,不要四舍五入到不同位数。
- 对比类问题用表格或列表呈现。
- 解释决策推荐时,引用工具返回的 optimal_window、expected_total_cost、failure_prob 等。
"""


def _build_system_prompt(ctx: AgentContext) -> str:
    """根据上下文构建系统提示词。"""
    p = ctx.current_params or {"cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 0.01}
    return SYSTEM_PROMPT.format(
        unit_id=ctx.unit_id if ctx.unit_id is not None else "未选择",
        cycle=ctx.cycle if ctx.cycle is not None else "未指定",
        cm=p.get("cm", 1),
        cd=p.get("cd", 5),
        cp=p.get("cp", 50),
        cc=p.get("cc", 200),
        alpha=p.get("alpha", 0.01),
    )


def _execute_tool_calls(
    tool_calls: list[dict], ctx: AgentContext
) -> list[ChatMessage]:
    """执行 LLM 返回的工具调用,返回 tool 结果消息列表。

    工具失败时返回错误消息(让 LLM 知道失败原因,可调整重试或告知用户)。
    """
    results = []
    for tc in tool_calls:
        tc_id = tc.get("id", "")
        fn = tc.get("function", {})
        tool_name = fn.get("name", "")
        args = fn.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}

        try:
            tool_result = execute_tool(tool_name, ctx, args)
            content = json.dumps(tool_result, ensure_ascii=False, default=str)
        except ToolError as e:
            # 工具执行失败:将错误传回 LLM,不中断整个 Agent
            logger.warning("工具 %s 执行失败: %s", tool_name, e.message)
            content = json.dumps(
                {"error": True, "tool": tool_name, "message": e.message},
                ensure_ascii=False,
            )
        except Exception as e:
            logger.exception("工具 %s 意外异常", tool_name)
            content = json.dumps(
                {"error": True, "tool": tool_name, "message": f"工具执行异常: {e}"},
                ensure_ascii=False,
            )

        results.append(
            ChatMessage(role="tool", content=content, tool_call_id=tc_id, name=tool_name)
        )
    return results


def run_agent(
    query: str,
    ctx: AgentContext,
    history: list[ChatMessage] | None = None,
) -> dict:
    """Agent 主入口:处理用户问题,返回最终回复与工具调用记录。

    Args:
        query: 用户问题
        ctx: Agent 上下文(含 probs/session_id/当前参数,不经过 LLM)
        history: 历史对话消息(可选,支持多轮对话)

    Returns:
        {
            "answer": 最终自然语言回复,
            "tool_calls_log": [{"tool": 名称, "args": 参数, "result": 结果}, ...],
            "model_used": 使用的模型名,
            "n_rounds": 实际工具调用轮数,
        }

    Raises:
        AgentError: E4002(未配置模型)/ E4003(模型调用失败)/ E4004(Agent 内部错误)
    """
    if not is_configured():
        raise AgentError(
            "E4002",
            "运行时 AI Agent 未配置模型 API",
            "请在后端环境变量中设置 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME,"
            "配置后重启服务。参见 .env.example。",
        )

    # 构建消息列表
    messages: list[ChatMessage] = [ChatMessage(role="system", content=_build_system_prompt(ctx))]
    if history:
        messages.extend(history)
    messages.append(ChatMessage(role="user", content=query))

    tool_calls_log: list[dict] = []
    model_used = ""

    for round_idx in range(MAX_TOOL_ROUNDS):
        try:
            resp: LLMResponse = chat_completion(
                messages=messages,
                tools=TOOL_SCHEMAS,
                tool_choice="auto",
                temperature=0.1,
            )
        except LLMGatewayError as e:
            raise AgentError(e.code, e.message, e.detail)

        model_used = resp.model_used or model_used

        # 情况 1:LLM 返回纯文本回复(无工具调用)→ 结束循环
        if not resp.tool_calls:
            return {
                "answer": resp.content or "(模型未返回内容)",
                "tool_calls_log": tool_calls_log,
                "model_used": model_used,
                "n_rounds": round_idx,
            }

        # 情况 2:LLM 要求调用工具 → 执行工具并回传结果
        # 先记录 assistant 的 tool_calls 消息
        messages.append(
            ChatMessage(role="assistant", content=resp.content, tool_calls=resp.tool_calls)
        )

        # 记录工具调用日志
        for tc in resp.tool_calls:
            fn = tc.get("function", {})
            tool_calls_log.append({
                "tool": fn.get("name", ""),
                "args": fn.get("arguments", {}),
                "round": round_idx + 1,
            })

        # 执行工具
        tool_results = _execute_tool_calls(resp.tool_calls, ctx)
        messages.extend(tool_results)

        # 将工具结果补充到日志
        for i, tc in enumerate(resp.tool_calls):
            fn = tc.get("function", {})
            tool_name = fn.get("name", "")
            # 从 tool_results 中找到对应的工具结果
            for tr in tool_results:
                if tr.name == tool_name and tr.tool_call_id == tc.get("id", ""):
                    try:
                        tool_calls_log[-(len(resp.tool_calls) - i)]["result"] = json.loads(tr.content or "{}")
                    except Exception:
                        tool_calls_log[-(len(resp.tool_calls) - i)]["result"] = {"raw": tr.content}
                    break

    # 超过最大轮数仍有工具调用 → 要求 LLM 直接总结
    logger.warning("Agent 达到最大工具调用轮数(%d),强制总结", MAX_TOOL_ROUNDS)
    messages.append(
        ChatMessage(
            role="user",
            content="已达到最大工具调用次数,请基于已获取的工具结果直接回答用户问题,不要再调用工具。",
        )
    )
    try:
        resp = chat_completion(messages=messages, tools=None, tool_choice="none", temperature=0.1)
    except LLMGatewayError as e:
        raise AgentError(e.code, e.message, e.detail)

    return {
        "answer": resp.content or "(模型未返回内容)",
        "tool_calls_log": tool_calls_log,
        "model_used": resp.model_used or model_used,
        "n_rounds": MAX_TOOL_ROUNDS,
    }