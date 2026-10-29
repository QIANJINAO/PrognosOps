# Agent 工具定义与执行模块
# 职责:定义运行时 Agent 可调用的 5 个工具(OpenAI function calling 格式),
#       并实现工具执行函数(调用后端核心计算模块,返回结构化 JSON)
#
# 安全规则:
# - 大模型不得直接计算概率和成本(规则 8)→ 所有数值由本模块调用后端核心计算
# - 大模型不得编造 regret(规则 10)→ regret 只能来自后端回测计算
# - 概率分布(probs)不通过 LLM 传递,由 Agent 层直接注入,防止篡改
# - 工具必须返回结构化 JSON(要求 9)
# - 页面只显示工具返回的真实结果(要求 10)

import json
from dataclasses import dataclass, field

from app.domain.models import BacktestConfig, DecisionParams
from app.core.backtest import BacktestError, export_backtest_csv, run_backtest
from app.core.decision import (
    DEFAULT_PARAMS,
    DEFAULT_WINDOWS,
    DecisionError,
    run_decision,
)
from app.core.session import get_session


class ToolError(Exception):
    """工具执行异常。"""

    def __init__(self, tool_name: str, message: str, detail: str = ""):
        self.tool_name = tool_name
        self.message = message
        self.detail = detail
        super().__init__(f"[tool:{tool_name}] {message}")


@dataclass
class AgentContext:
    """Agent 执行上下文(由前端传入,后端注入,不经过 LLM)。

    Attributes:
        session_id: 会话 ID
        probs: 当前 RUL 离散概率分布 P(h),h=0..h_max
        h_max: 最大离散 RUL
        unit_id: 当前选择的设备单元
        cycle: 当前预测时点周期
        current_params: 当前决策参数(cm/cd/cp/cc/alpha)
    """
    session_id: str = ""
    probs: list[float] = field(default_factory=list)
    h_max: int = 150
    unit_id: int | None = None
    cycle: int | None = None
    current_params: dict = field(default_factory=dict)


# ──────────────────────────────────────────────
# 工具 Schema(OpenAI function calling 格式,给 LLM 识别意图用)
# ──────────────────────────────────────────────

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "recompute_decision",
            "description": (
                "当用户询问参数变化的影响时调用(如'停机损失翻倍会怎样''alpha改为0.02会怎样')。"
                "使用修改后的成本参数重新计算四策略(ETO-C/IEO-C/ETO-Q/IEO-Q)的推荐维修窗口、"
                "期望成本、失效概率等。当前概率分布由系统自动注入,无需传入。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "cm": {"type": "number", "description": "最小维护成本(覆盖当前值)"},
                    "cd": {"type": "number", "description": "停机成本(覆盖当前值)"},
                    "cp": {"type": "number", "description": "预防性更换成本(覆盖当前值)"},
                    "cc": {"type": "number", "description": "纠正性更换成本(覆盖当前值)"},
                    "alpha": {"type": "number", "description": "折现因子(覆盖当前值)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compare_scenarios",
            "description": (
                "当用户要求比较不同方案时调用(如'再等一个窗口会多花多少钱''比较两种参数')。"
                "对多组参数配置分别计算决策结果并返回对比表。"
                "当前概率分布由系统自动注入,无需传入。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scenarios": {
                        "type": "array",
                        "description": "待比较的方案列表",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "description": "方案名称(如'当前方案''停机翻倍')"},
                                "cm": {"type": "number"},
                                "cd": {"type": "number"},
                                "cp": {"type": "number"},
                                "cc": {"type": "number"},
                                "alpha": {"type": "number"},
                            },
                            "required": ["name"],
                        },
                    },
                },
                "required": ["scenarios"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_data",
            "description": (
                "当用户询问数据相关问题时调用(如'数据质量怎么样''有哪些单元''数据有多少行')。"
                "返回当前会话的数据概览与质量报告摘要。无需传入参数。"
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_backtest",
            "description": (
                "当用户询问回测相关问题时调用(如'回测的regret是多少''模型校准怎么样''NLL是多少')。"
                "对当前会话数据执行离线回测,返回 NLL/MAE/regret/校准等指标。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "data_mode": {"type": "string", "enum": ["offline", "online"], "description": "数据模式,默认 offline"},
                    "step": {"type": "integer", "description": "决策时点间隔,默认 10"},
                    "n_repeats": {"type": "integer", "description": "重复实验次数,默认 1"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "export_report",
            "description": (
                "当用户要求导出报告时调用(如'导出结果''生成报告''下载JSON')。"
                "返回当前会话的报告内容(JSON/CSV/文本)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "format": {"type": "string", "enum": ["json", "csv", "text"], "description": "导出格式"},
                },
                "required": ["format"],
            },
        },
    },
]


# ──────────────────────────────────────────────
# 工具执行函数(后端核心计算,返回结构化 JSON)
# ──────────────────────────────────────────────

def _merge_params(base: dict, overrides: dict) -> DecisionParams:
    """合并基准参数与覆盖参数,返回 DecisionParams 对象。"""
    merged = dict(base)
    for k in ("cm", "cd", "cp", "cc", "alpha"):
        if k in overrides and overrides[k] is not None:
            merged[k] = overrides[k]
    merged.setdefault("h_max", 150)
    return DecisionParams(**merged)


def _summarize_decision(result) -> dict:
    """从 DecisionResult 中提取摘要(供 LLM 组织语言,数值均为后端计算)。"""
    strategies_summary = {}
    for name, s in result.strategies.items():
        strategies_summary[name] = {
            "optimal_window": s.optimal_window,
            "objective_value": round(s.objective_value, 4),
            "expected_cost": round(s.expected_cost, 4),
            "expected_total_cost": round(s.expected_total_cost, 4),
            "failure_prob": round(s.failure_prob, 6),
            "expected_life": round(s.expected_life, 4),
            "diff_window_vs_eto": s.diff_window_vs_eto,
            "diff_objective_vs_eto": round(s.diff_objective_vs_eto, 4),
        }
    return {
        "params": result.params.model_dump(),
        "strategies": strategies_summary,
        "assumptions": result.assumptions,
    }


def execute_recompute_decision(ctx: AgentContext, args: dict) -> dict:
    """工具:参数变化重新计算决策。

    使用当前概率分布 + 覆盖参数,调用后端 run_decision 计算四策略。
    所有数值由后端计算,LLM 不参与数值计算。
    """
    if not ctx.probs:
        raise ToolError("recompute_decision", "当前无 RUL 概率分布,请先在趋势分析中预测 RUL")

    # 合并参数:当前参数为基准,LLM 传入的覆盖值生效
    base_params = ctx.current_params if ctx.current_params else {
        "cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 0.01, "h_max": ctx.h_max,
    }
    params = _merge_params(base_params, args)

    try:
        result = run_decision(
            probs=ctx.probs,
            params=params,
            use_cache=False,  # 参数已变化,不使用缓存
        )
    except DecisionError as e:
        raise ToolError("recompute_decision", e.message, e.detail)

    return {
        "tool": "recompute_decision",
        "changed_params": {k: v for k, v in args.items() if k in ("cm", "cd", "cp", "cc", "alpha")},
        "decision": _summarize_decision(result),
    }


def execute_compare_scenarios(ctx: AgentContext, args: dict) -> dict:
    """工具:多方案对比。

    对每组参数配置分别计算决策结果,返回对比表。
    """
    if not ctx.probs:
        raise ToolError("compare_scenarios", "当前无 RUL 概率分布,请先在趋势分析中预测 RUL")

    scenarios = args.get("scenarios", [])
    if not scenarios:
        raise ToolError("compare_scenarios", "未提供待比较的方案")

    base_params = ctx.current_params if ctx.current_params else {
        "cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 0.01, "h_max": ctx.h_max,
    }

    comparisons = []
    for sc in scenarios:
        sc_name = sc.get("name", "未命名方案")
        params = _merge_params(base_params, sc)
        try:
            result = run_decision(probs=ctx.probs, params=params, use_cache=False)
            etoc = result.strategies["ETO-C"]
            ieoc = result.strategies["IEO-C"]
            comparisons.append({
                "name": sc_name,
                "params": params.model_dump(),
                "ETO-C": {
                    "optimal_window": etoc.optimal_window,
                    "expected_total_cost": round(etoc.expected_total_cost, 4),
                    "failure_prob": round(etoc.failure_prob, 6),
                },
                "IEO-C": {
                    "optimal_window": ieoc.optimal_window,
                    "expected_total_cost": round(ieoc.expected_total_cost, 4),
                    "failure_prob": round(ieoc.failure_prob, 6),
                },
            })
        except DecisionError as e:
            comparisons.append({"name": sc_name, "error": e.message})

    return {
        "tool": "compare_scenarios",
        "comparisons": comparisons,
    }


def execute_inspect_data(ctx: AgentContext, args: dict) -> dict:
    """工具:检查当前会话数据概览与质量。"""
    session = get_session(ctx.session_id)
    if session is None:
        raise ToolError("inspect_data", f"会话 {ctx.session_id} 不存在或已过期")

    qr = session.quality_report
    ov_units = [{"unit_id": u.unit_id, "cycles": u.cycle_count} for u in qr.units]

    failed_checks = [
        {"name": c.name, "level": c.level, "message": c.message}
        for c in qr.checks if not c.passed
    ]

    return {
        "tool": "inspect_data",
        "file_name": qr.file_name,
        "total_rows": qr.total_rows,
        "unit_count": qr.unit_count,
        "units": ov_units,
        "is_valid": qr.is_valid,
        "has_critical": qr.has_critical,
        "failed_checks": failed_checks,
        "assumptions": qr.assumptions,
    }


def execute_run_backtest(ctx: AgentContext, args: dict) -> dict:
    """工具:执行离线回测,返回 NLL/MAE/regret/校准等指标。

    regret 由后端计算,LLM 不得编造。无真实 RUL 时 regret 为 null(规则 10)。
    """
    session = get_session(ctx.session_id)
    if session is None:
        raise ToolError("run_backtest", f"会话 {ctx.session_id} 不存在或已过期")

    config = BacktestConfig(
        data_mode=args.get("data_mode", "offline"),
        step=args.get("step", 10),
        n_repeats=args.get("n_repeats", 1),
        include_points=False,  # Agent 场景只需要摘要
    )

    try:
        result = run_backtest(session.parsed_data.df, config)
    except BacktestError as e:
        raise ToolError("run_backtest", e.message, e.detail)

    strategies_summary = {}
    for name, s in result.strategies.items():
        strategies_summary[name] = {
            "regret_mean": s.regret_mean,  # 无真实RUL时为 None,不编造
            "failure_frequency": s.failure_frequency,
            "mean_failure_prob": round(s.mean_failure_prob, 6),
            "ece": s.ece,
        }

    return {
        "tool": "run_backtest",
        "n_points": result.n_points,
        "n_units": result.n_units,
        "has_true_rul": result.has_true_rul,
        "nll_mean": result.nll_mean,
        "mae_mean": result.mae_mean,
        "strategies": strategies_summary,
        "data_sufficiency_note": result.data_sufficiency_note,
        "assumptions": result.assumptions,
    }


def execute_export_report(ctx: AgentContext, args: dict) -> dict:
    """工具:导出当前会话报告。"""
    fmt = args.get("format", "json")
    session = get_session(ctx.session_id)
    if session is None:
        raise ToolError("export_report", f"会话 {ctx.session_id} 不存在或已过期")

    if fmt == "csv":
        config = BacktestConfig(include_points=True, step=20, min_cycle=30, k_nn=5, n_repeats=1, random_seed=42)
        try:
            result = run_backtest(session.parsed_data.df, config)
            csv_text = export_backtest_csv(result)
        except BacktestError as e:
            raise ToolError("export_report", e.message, e.detail)
        return {
            "tool": "export_report",
            "format": "csv",
            "content_preview": csv_text[:500],
            "full_length": len(csv_text),
            "note": "完整 CSV 可通过 /api/backtest/export-csv 端点下载",
        }

    # JSON 格式:返回质量报告 + 决策结果(如有)
    report = {
        "session_id": ctx.session_id,
        "quality_report": {
            "file_name": session.quality_report.file_name,
            "total_rows": session.quality_report.total_rows,
            "unit_count": session.quality_report.unit_count,
            "is_valid": session.quality_report.is_valid,
        },
    }
    if ctx.probs and ctx.current_params:
        try:
            params = _merge_params(ctx.current_params, {})
            decision = run_decision(probs=ctx.probs, params=params, use_cache=True)
            report["decision"] = _summarize_decision(decision)
        except DecisionError:
            pass  # 决策计算失败不影响报告导出

    return {
        "tool": "export_report",
        "format": fmt,
        "report": report,
    }


# ──────────────────────────────────────────────
# 工具注册表
# ──────────────────────────────────────────────

TOOL_EXECUTORS = {
    "recompute_decision": execute_recompute_decision,
    "compare_scenarios": execute_compare_scenarios,
    "inspect_data": execute_inspect_data,
    "run_backtest": execute_run_backtest,
    "export_report": execute_export_report,
}


def execute_tool(tool_name: str, ctx: AgentContext, args: dict) -> dict:
    """执行指定工具,返回结构化 JSON。

    Args:
        tool_name: 工具名称
        ctx: Agent 上下文(含 probs/session 等,不经过 LLM)
        args: LLM 解析出的工具参数

    Returns:
        结构化 JSON 结果

    Raises:
        ToolError: 工具不存在或执行失败
    """
    executor = TOOL_EXECUTORS.get(tool_name)
    if executor is None:
        raise ToolError(tool_name, f"未知工具: {tool_name}")
    return executor(ctx, args)