# API 路由定义
# 本文件定义所有 HTTP 接口
# 当前阶段包含:健康检查、CSV 数据上传(含 FD001 格式校验与数据质量检查)、
#               维修决策(四策略 + regret + failure frequency)、
#               离线回测(NLL/MAE/regret/校准/敏感性/CSV 导出)
# 后续阶段将逐步追加:质量报告查询、分析、对话、导出等路由

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

from app.core.backtest import BacktestError, export_backtest_csv, run_backtest
from app.core.config import get_column_roles, get_quality_thresholds
from app.core.data_loader import DataLoaderError, parse_csv
from app.core.decision import (
    DEFAULT_PARAMS,
    DEFAULT_WINDOWS,
    DecisionError,
    compute_failure_frequency,
    compute_regret,
    run_decision,
)
from app.core.features import FeatureError, compute_norm_params, extract_features
from app.core.quality import run_quality_checks
from app.core.rul import RULFitError, estimate_rul_distribution
from app.core.session import create_session, get_session
from app.domain.models import (
    AgentChatRequest,
    AgentChatResponse,
    BacktestConfig,
    BacktestRunRequest,
    DataOverview,
    DecisionRunRequest,
    FailureFrequencyRequest,
    RegretRequest,
    RULPredictRequest,
    RULPredictResponse,
    SensorTrendResponse,
    ToolCallLog,
    UnitOverview,
    UploadResponse,
)

# 创建路由器,所有接口以 /api 为前缀
router = APIRouter(prefix="/api")


@router.get("/health")
async def health_check():
    """健康检查接口。

    用于容器编排与云部署平台探活,确认服务是否正常启动。
    返回服务名称、版本与运行状态。
    """
    return {
        "status": "ok",
        "service": "PrognosOps",
        "version": "0.1.0",
        "message": "维策 · 决策导向的预测性维护智能体服务运行中",
    }


@router.post("/data/upload", response_model=UploadResponse)
async def upload_csv(file: UploadFile = File(...)):
    """CSV 数据上传接口(用户要求 1)。

    接收 NASA C-MAPSS FD001 格式的 CSV 文件(空格或逗号分隔,有表头或无表头均可),
    执行 FD001 格式校验与数据质量检查,创建内存会话并返回数据概览与质量报告。

    错误响应统一结构:{"code": "Exxxx", "message": "...", "detail": "..."}
    - E1001: CSV 格式不符(空文件/列数不符/缺列/非数值)→ 400
    - E1002: 文件超过 50MB 限制 → 413
    """
    # 读取文件内容
    content_bytes = await file.read()
    file_size = len(content_bytes)

    # 解码为文本(仅支持 UTF-8)
    try:
        text = content_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail={"code": "E1001", "message": "文件编码错误,请使用 UTF-8 编码的 CSV 文件", "detail": ""},
        )

    # 解析与格式校验
    try:
        parsed = parse_csv(text, file.filename or "unknown.csv", file_size)
    except DataLoaderError as e:
        # 错误码到 HTTP 状态码的映射(设计文档 8.1 节)
        status_map = {"E1001": 400, "E1002": 413}
        raise HTTPException(
            status_code=status_map.get(e.code, 400),
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )

    # 数据质量检查
    report = run_quality_checks(parsed)

    # 创建内存会话
    session_id = create_session(parsed, report)

    # 构建数据概览
    units_overview = [
        UnitOverview(unit_id=u.unit_id, cycles=u.cycle_count)
        for u in report.units
    ]
    overview = DataOverview(
        total_rows=report.total_rows,
        unit_count=report.unit_count,
        units=units_overview,
        columns=report.total_columns,
        separator=parsed.separator,
    )

    return UploadResponse(
        session_id=session_id,
        overview=overview,
        quality_report=report,
    )


# ──────────────────────────────────────────────
# 维修决策接口
# ──────────────────────────────────────────────

@router.post("/decision/run")
async def decision_run(req: DecisionRunRequest):
    """维修决策分析接口:计算四策略 + 全部曲线 + 假设说明。

    输入离散 RUL 概率分布 P(h) 与可选的成本参数/IEO 配置,
    后端计算 ETO-C/IEO-C/ETO-Q/IEO-Q 四种策略的推荐维修窗口、
    期望成本、失效概率、与 ETO 的差额等全部关键数值(规则 7)。

    错误响应统一结构:{"code": "E4001", "message": "...", "detail": "..."} → 422
    """
    try:
        result = run_decision(
            probs=req.probs,
            params=req.params,
            windows=req.windows,
            ieo_config=req.ieo_config,
            use_cache=req.use_cache,
        )
        return result
    except DecisionError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )


@router.post("/decision/regret")
async def decision_regret(req: RegretRequest):
    """Regret 计算接口(规则 10:无真实 RUL 时 regret 为 null)。

    给定真实 RUL 与策略所选窗口,计算真实成本、完美信息最优成本与 regret。
    无真实 RUL 标签时(true_rul 省略或为 null),regret 字段返回 null(用户要求 3)。
    """
    try:
        params = req.params or DEFAULT_PARAMS
        windows = req.windows or DEFAULT_WINDOWS
        result = compute_regret(
            true_rul=req.true_rul,
            chosen_window=req.chosen_window,
            windows=windows,
            params=params,
            strategy=req.strategy,
        )
        return result
    except DecisionError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )


@router.post("/decision/failure-frequency")
async def decision_failure_frequency(req: FailureFrequencyRequest):
    """失效频率接口(用户要求 10):对全部候选窗口输出 P(RUL < z) 曲线。

    输入离散 RUL 概率分布,输出各候选窗口的失效概率。
    """
    try:
        windows = req.windows or DEFAULT_WINDOWS
        result = compute_failure_frequency(
            probs=req.probs,
            windows=windows,
            h_max=req.h_max,
        )
        return result
    except DecisionError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )


# ──────────────────────────────────────────────
# 离线回测接口
# ──────────────────────────────────────────────

def _get_session_df(session_id: str):
    """获取会话数据,不存在则抛 404。"""
    session = get_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "E2002", "message": f"会话 {session_id} 不存在", "detail": ""},
        )
    return session


@router.post("/backtest/run")
async def backtest_run(req: BacktestRunRequest):
    """离线回测接口:多时点决策模拟 + NLL/MAE/regret/校准/敏感性分析。

    输入会话 ID 与回测配置,后端执行完整回测流程并返回结构化 JSON(用户要求 11)。

    数据模式区分(强制):
    - offline:有真实 RUL 标签,可计算真实 regret/NLL/MAE/校准
    - online:无真实失效时间,regret 恒为 null(规则 10)

    错误响应:{"code": "E5001", "message": "...", "detail": "..."} → 422
    """
    session = _get_session_df(req.session_id)
    config = req.config or BacktestConfig()
    try:
        result = run_backtest(session.parsed_data.df, config)
        return result
    except BacktestError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )


@router.post("/backtest/export-csv", response_class=PlainTextResponse)
async def backtest_export_csv(req: BacktestRunRequest):
    """回测结果 CSV 导出接口(用户要求 12)。

    执行回测并将结果导出为 CSV 格式(text/csv)。
    每行对应一个回测时点 × 一个策略。
    """
    session = _get_session_df(req.session_id)
    config = req.config or BacktestConfig()
    # CSV 导出需要逐时点详情
    config = config.model_copy(update={"include_points": True})
    try:
        result = run_backtest(session.parsed_data.df, config)
        return export_backtest_csv(result)
    except BacktestError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )


# ──────────────────────────────────────────────
# 前端工作台联调接口(传感器趋势 + RUL 概率预测)
# ──────────────────────────────────────────────

@router.get("/data/sensor-trend", response_model=SensorTrendResponse)
async def data_sensor_trend(session_id: str, unit_id: int):
    """传感器趋势数据接口(前端图表用,纯数据检索)。

    从会话中读取指定单元的原始传感器读数,供前端绘制趋势图。
    仅返回 14 个选定传感器的数据(与特征工程一致)。
    """
    session = _get_session_df(session_id)
    df = session.parsed_data.df
    roles = get_column_roles()
    unit_col = roles["unit_column"]
    cycle_col = roles["cycle_column"]
    sensors = roles["selected_sensors"]

    # 校验单元存在
    unit_data = df[df[unit_col] == unit_id]
    if unit_data.empty:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "E2002",
                "message": f"设备单元 {unit_id} 不存在",
                "detail": f"可用单元: {sorted(df[unit_col].unique().tolist())}",
            },
        )

    # 按周期排序,提取周期序列与传感器读数
    unit_data = unit_data.sort_values(cycle_col)
    cycles = unit_data[cycle_col].astype(int).tolist()
    sensor_data = {}
    for s in sensors:
        if s in unit_data.columns:
            sensor_data[s] = unit_data[s].astype(float).tolist()
        else:
            sensor_data[s] = []

    return SensorTrendResponse(
        session_id=session_id,
        unit_id=unit_id,
        cycles=cycles,
        sensor_names=list(sensors),
        sensor_data=sensor_data,
    )


@router.post("/rul/predict", response_model=RULPredictResponse)
async def rul_predict(req: RULPredictRequest):
    """RUL 概率预测接口(复用已有特征工程 + kNN + Weibull 模块)。

    对指定单元在指定周期执行完整 RUL 估计流程:
    1. 留一单元法构建参考集(排除查询单元,假设 A-B1)
    2. 提取查询特征(最近 30 周期窗口)
    3. kNN 检索 → Weibull MLE 拟合 → 离散化

    返回 Weibull 参数与离散 RUL 概率分布,供前端绘制概率图与决策分析。
    """
    session = _get_session_df(req.session_id)
    df = session.parsed_data.df
    roles = get_column_roles()
    thresholds = get_quality_thresholds()
    unit_col = roles["unit_column"]
    cycle_col = roles["cycle_column"]
    sensors = roles["selected_sensors"]
    window_size = thresholds["feature_window"]

    # 校验查询单元存在
    query_unit_data = df[df[unit_col] == req.unit_id]
    if query_unit_data.empty:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "E2002",
                "message": f"设备单元 {req.unit_id} 不存在",
                "detail": f"可用单元: {sorted(df[unit_col].unique().tolist())}",
            },
        )

    # 确定预测时点(默认为该单元最后一个周期)
    query_unit_data = query_unit_data.sort_values(cycle_col)
    if req.cycle is not None:
        cycle = req.cycle
        if cycle not in query_unit_data[cycle_col].values:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "E2002",
                    "message": f"单元 {req.unit_id} 不存在周期 {cycle}",
                    "detail": f"该单元周期范围: {int(query_unit_data[cycle_col].min())} ~ {int(query_unit_data[cycle_col].max())}",
                },
            )
    else:
        cycle = int(query_unit_data[cycle_col].max())

    # 查询时点数据不足 30 周期时返回错误(与特征工程一致,不补造)
    df_upto = query_unit_data[query_unit_data[cycle_col] <= cycle]
    if len(df_upto) < window_size:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "E3002",
                "message": f"单元 {req.unit_id} 在周期 {cycle} 处数据不足:仅 {len(df_upto)} 行,需 ≥ {window_size} 行",
                "detail": "特征窗口为最近 30 周期,不足时不补造数据(假设 A1)",
            },
        )

    # 全量归一化参数(保证参考集与查询特征空间一致,假设 A2)
    norm_params = compute_norm_params(df, sensors, window_size)

    # 留一单元法构建参考集(排除查询单元,假设 A-B1)
    other_units = df[df[unit_col] != req.unit_id]
    ref_features_list, ref_ruls_list = [], []
    if not other_units.empty:
        for uid in sorted(other_units[unit_col].unique()):
            u_data = other_units[other_units[unit_col] == uid].sort_values(cycle_col)
            max_cycle_u = int(u_data[cycle_col].max())
            for t in range(window_size, max_cycle_u + 1, req.step):
                df_u = u_data[u_data[cycle_col] <= t]
                if len(df_u) < window_size:
                    continue
                try:
                    feat = extract_features(df_u, uid, normalize=True, norm_params=norm_params)
                    ref_features_list.append(feat.feature_vector)
                    ref_ruls_list.append(max_cycle_u - t)
                except FeatureError:
                    continue

    if len(ref_features_list) < 2:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "E3001",
                "message": "参考集样本不足,无法执行 RUL 预测",
                "detail": f"排除单元 {req.unit_id} 后仅构建 {len(ref_features_list)} 个参考样本,至少需要 2 个",
            },
        )

    import numpy as np
    ref_features = np.array(ref_features_list)
    ref_ruls = np.array(ref_ruls_list)

    # 提取查询特征
    try:
        query_feat_result = extract_features(df_upto, req.unit_id, normalize=True, norm_params=norm_params)
    except FeatureError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )
    query_feature = np.array(query_feat_result.feature_vector)

    # kNN → Weibull → 离散化
    effective_k = min(req.k_nn, len(ref_ruls))
    try:
        weibull_fit, discrete_rul = estimate_rul_distribution(
            query_feature=query_feature,
            reference_features=ref_features,
            reference_ruls=ref_ruls,
            k=effective_k,
            h_max=req.h_max,
            random_seed=req.random_seed,
        )
    except RULFitError as e:
        raise HTTPException(
            status_code=422,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )

    assumptions = [
        f"【假设 A-B1】采用留一单元法:参考集排除单元 {req.unit_id},防止数据泄露。",
        f"【假设 A3/A4】kNN 检索:在 420 维特征空间中使用欧氏距离,近邻数 k={effective_k}。",
        f"【假设 A5】Weibull 双参数 MLE 拟合,位置参数固定为 0,参数由数据拟合而非硬编码。",
        f"【假设 A6】离散化使用生存函数 S(t)=exp(-(t/λ)^k),在 [0, {req.h_max}] 上截断归一化。",
        f"参考集规模:{len(ref_ruls)} 个样本(来自 {len(other_units[unit_col].unique())} 个单元,采样间隔 {req.step} 周期)。",
    ]

    return RULPredictResponse(
        session_id=req.session_id,
        unit_id=req.unit_id,
        cycle=cycle,
        weibull=weibull_fit,
        discrete=discrete_rul,
        n_reference=len(ref_ruls),
        assumptions=assumptions,
    )


# ──────────────────────────────────────────────
# 运行时 AI Agent(意图识别 → 工具调度 → 结果汇总)
# ──────────────────────────────────────────────

@router.post("/agent/chat", response_model=AgentChatResponse)
async def agent_chat(req: AgentChatRequest):
    """运行时 AI Agent 对话接口。

    前端将当前工作台状态(RUL 分布、决策参数等)随请求发送,
    后端构建 AgentContext 并调用 Agent 循环:
    意图识别 → 工具调度(后端核心计算)→ 结构化结果 → 自然语言汇总。

    安全规则:
    - 大模型不得直接计算概率和成本 → 所有数值由后端工具计算
    - 大模型不得编造 regret → regret 只能来自 run_backtest 工具
    - API Key 仅从后端环境变量读取,不出现在前端
    - 未配置模型 API 时返回明确错误(E4002),不假装调用成功

    错误码:
    - E4002: 未配置模型 API(MODEL_BASE_URL/MODEL_API_KEY/MODEL_NAME)
    - E4003: 模型 API 调用失败(网络/超时/认证/限流/服务端错误)
    """
    from app.agent.agent import AgentError, run_agent
    from app.agent.tools import AgentContext
    from app.core.llm_gateway import ChatMessage

    # 构建 Agent 上下文(probs/params 由后端注入工具,不经过 LLM)
    ctx = AgentContext(
        session_id=req.session_id,
        probs=req.probs,
        h_max=req.h_max,
        unit_id=req.unit_id,
        cycle=req.cycle,
        current_params=req.current_params,
    )

    # 构建对话历史(如有)
    history = None
    if req.history:
        history = [
            ChatMessage(role=m.role, content=m.content)
            for m in req.history[-10:]  # 最多保留最近 10 条,控制 token 用量
        ]

    try:
        result = run_agent(query=req.query, ctx=ctx, history=history)
    except AgentError as e:
        # E4002(配置缺失)→ 400;E4003(调用失败)→ 502
        status = 400 if e.code == "E4002" else 502
        raise HTTPException(
            status_code=status,
            detail={"code": e.code, "message": e.message, "detail": e.detail},
        )

    return AgentChatResponse(
        answer=result["answer"],
        tool_calls_log=[ToolCallLog(**tc) for tc in result["tool_calls_log"]],
        model_used=result["model_used"],
        n_rounds=result["n_rounds"],
    )