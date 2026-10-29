# 领域数据模型
# 定义数据上传与数据体检模块的结构化数据模型
# 全部使用 Pydantic BaseModel,保证 JSON 序列化与 API 文档自动生成

from pydantic import BaseModel, Field


# ──────────────────────────────────────────────
# 数据质量检查相关模型
# ──────────────────────────────────────────────

class CheckResult(BaseModel):
    """单项质量检查结果。

    Attributes:
        name: 检查项名称(如"缺失值检查"、"周期连续性检查")
        passed: 是否通过(无问题则为 True)
        level: 严重级别:"info"(提示)/ "warning"(警告)/ "error"(错误)/ "critical"(严重)
        message: 检查结果的可读描述
        details: 补充细节(如缺失列名、不连续的单元列表等)
    """
    name: str
    passed: bool
    level: str = Field(description="严重级别: info / warning / error / critical")
    message: str
    details: dict = Field(default_factory=dict)


class ColumnMapping(BaseModel):
    """列识别结果:识别出的 unit、cycle、setting 与 sensor 列。

    Attributes:
        unit_column: 识别出的设备单元编号列名(未识别到则为 None)
        cycle_column: 识别出的运行周期列名(未识别到则为 None)
        setting_columns: 识别出的操作设定列名列表
        sensor_columns: 识别出的全部传感器列名列表
        selected_sensors: 14 个选定传感器列名(来自配置文件)
        missing_sensors: 选定传感器中在数据里缺失的列名
        constant_sensors: 常量传感器列名(来自配置文件)
        all_columns: 数据中实际出现的全部列名
    """
    unit_column: str | None = None
    cycle_column: str | None = None
    setting_columns: list[str] = Field(default_factory=list)
    sensor_columns: list[str] = Field(default_factory=list)
    selected_sensors: list[str] = Field(default_factory=list)
    missing_sensors: list[str] = Field(default_factory=list)
    constant_sensors: list[str] = Field(default_factory=list)
    all_columns: list[str] = Field(default_factory=list)


class UnitSummary(BaseModel):
    """单个设备单元的质量摘要。

    Attributes:
        unit_id: 设备单元编号
        cycle_count: 该单元的总周期数(去重后的行数)
        cycle_min: 最小周期号
        cycle_max: 最大周期号
        cycle_continuous: 周期序列是否连续(无跳跃)
        missing_cycles: 缺失的周期号列表(如 [3, 7] 表示第 3、7 周期缺失)
        meets_min_cycles: 周期数是否满足最低要求(≥30)
    """
    unit_id: int
    cycle_count: int
    cycle_min: int
    cycle_max: int
    cycle_continuous: bool
    missing_cycles: list[int] = Field(default_factory=list)
    meets_min_cycles: bool


class DataQualityReport(BaseModel):
    """结构化数据质量报告(用户要求 15)。

    涵盖文件级检查(空文件、大小)、列级检查(列名、列识别)、
    值级检查(缺失值、重复行、非数值)与单元级检查(周期连续性、最少周期数)。
    缺少数据时生成明确的假设说明(assumptions),绝不静默补造(用户要求 13/14)。

    Attributes:
        file_name: 上传的文件名
        file_size_mb: 文件大小(兆字节)
        file_empty: 文件是否为空(无有效数据行)
        total_rows: 数据总行数(不含表头)
        total_columns: 数据总列数
        unit_count: 设备单元总数
        column_mapping: 列识别结果
        checks: 各检查项的结果列表
        units: 各设备单元的质量摘要
        assumptions: 假设说明列表(数据不完整或需工程假设时生成)
        is_valid: 总体判定:数据是否可用于后续分析
        has_critical: 是否存在严重(critical)问题
    """
    file_name: str
    file_size_mb: float
    file_empty: bool = False
    total_rows: int = 0
    total_columns: int = 0
    unit_count: int = 0
    column_mapping: ColumnMapping = Field(default_factory=ColumnMapping)
    checks: list[CheckResult] = Field(default_factory=list)
    units: list[UnitSummary] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    is_valid: bool = False
    has_critical: bool = False


# ──────────────────────────────────────────────
# 数据上传响应模型
# ──────────────────────────────────────────────

class UnitOverview(BaseModel):
    """单个设备单元的数据概览。"""
    unit_id: int
    cycles: int


class DataOverview(BaseModel):
    """数据概览:上传成功后返回的基本统计信息。"""
    total_rows: int
    unit_count: int
    units: list[UnitOverview]
    columns: int
    separator: str = Field(description="检测到的分隔符: space / comma / tab")


class UploadResponse(BaseModel):
    """CSV 上传接口的响应结构。"""
    session_id: str
    overview: DataOverview
    quality_report: DataQualityReport


# ──────────────────────────────────────────────
# 特征工程相关模型
# ──────────────────────────────────────────────

class SensorMapping(BaseModel):
    """传感器到特征向量索引的映射(用户要求 5:保存传感器映射)。

    特征向量按行优先展平:第 i 周期的 14 个传感器值位于索引 [i*14, (i+1)*14)。
    传感器 s_j 在特征向量中的位置为:i * stride + column_index(i=0..29)。

    Attributes:
        sensor_name: 传感器名称(如 s2)
        column_index: 该传感器在 14 个传感器列表中的位置(0-based)
        stride: 相邻周期同一传感器的索引间隔(= 传感器数 14)
        first_index: 该传感器在 420 维向量中首次出现的索引(= column_index)
    """
    sensor_name: str
    column_index: int
    stride: int
    first_index: int


class NormParams(BaseModel):
    """z-score 归一化参数(假设 A2)。

    Attributes:
        mean: 420 维均值向量
        std: 420 维标准差向量(σ=0 的维度归一化后约定为 0,见假设 A-F2)
    """
    mean: list[float]
    std: list[float]


class FeatureResult(BaseModel):
    """特征提取结果(用户要求 3/5/8)。

    Attributes:
        unit_id: 设备单元编号
        feature_vector: 420 维特征向量(归一化后)
        dim: 特征维度(必须为 420)
        window: 特征窗口长度(30 周期)
        sensors: 使用的 14 个传感器名称(来自配置文件)
        sensor_mapping: 传感器名 → 特征向量索引映射
        normalized: 是否已归一化
        norm_params: 归一化参数(未归一化时为 None)
        assumptions: 数据假设说明列表(用户要求 8)
    """
    unit_id: int
    feature_vector: list[float]
    dim: int
    window: int
    sensors: list[str]
    sensor_mapping: list[SensorMapping]
    normalized: bool
    norm_params: NormParams | None = None
    assumptions: list[str] = Field(default_factory=list)


# ──────────────────────────────────────────────
# Weibull 概率预测相关模型
# ──────────────────────────────────────────────

class WeibullFitResult(BaseModel):
    """Weibull MLE 拟合结果(用户要求 1/2)。

    Attributes:
        lam: 尺度参数 λ(必须 > 0,用户要求 2)
        k: 形状参数(必须 > 0,用户要求 2)
        log_likelihood: 对数似然值
        n_samples: 拟合样本数
    """
    lam: float = Field(gt=0, description="尺度参数 λ,必须为正数")
    k: float = Field(gt=0, description="形状参数 k,必须为正数")
    log_likelihood: float
    n_samples: int


class DiscreteRULResult(BaseModel):
    """离散 RUL 概率分布(用户要求 4/5)。

    Attributes:
        probs: 151 维概率向量 P(RUL=h),h=0..150,Σ=1(输出前已校验)
        cdf: 151 维累计概率,单调递增,末项=1
        h_max: 最大离散 RUL(150)
        is_normalized: 概率是否已归一化(校验通过则为 True)
    """
    probs: list[float]
    cdf: list[float]
    h_max: int
    is_normalized: bool


# ──────────────────────────────────────────────
# 维修决策相关模型
# ──────────────────────────────────────────────

class DecisionParams(BaseModel):
    """维修决策成本与风险参数(用户指定默认值)。

    Attributes:
        cm: 最小维护成本(每周期,必须 > 0)
        cd: 停机成本(每周期,≥ 0)
        cp: 预防性更换成本(必须 > 0)
        cc: 纠正性更换成本(必须 > 0)
        alpha: 折现因子(0 < alpha ≤ 1)
        h_max: 最大离散 RUL(与离散化模块一致,默认 150)
    """
    cm: float = Field(gt=0, description="最小维护成本,必须为正数")
    cd: float = Field(ge=0, description="停机成本,非负")
    cp: float = Field(gt=0, description="预防性更换成本,必须为正数")
    cc: float = Field(gt=0, description="纠正性更换成本,必须为正数")
    alpha: float = Field(gt=0, le=1, description="折现因子,0 < alpha ≤ 1")
    h_max: int = Field(gt=0, default=150, description="最大离散 RUL")


class IEOOptConfig(BaseModel):
    """IEO 策略梯度优化配置(用户要求 8/9:记录训练步数和配置)。

    Attributes:
        n_steps: 训练步数
        batch_size: 每步采样窗口数
        mc_samples: 每个窗口的蒙特卡洛样本数
        sigma_init: 初始高斯标准差
        sigma_min: 最小高斯标准差
        sigma_decay: σ 每步衰减系数
        lr_mu: μ 的学习率
        baseline_decay: baseline EMA 衰减系数
        random_seed: 随机种子(None 表示不固定)
    """
    n_steps: int = Field(gt=0, default=100, description="训练步数")
    batch_size: int = Field(gt=0, default=16, description="每步采样窗口数")
    mc_samples: int = Field(gt=0, default=64, description="每个窗口的 MC 样本数")
    sigma_init: float = Field(gt=0, default=5.0, description="初始高斯标准差(约一个窗口步长)")
    sigma_min: float = Field(gt=0, default=0.5, description="最小高斯标准差")
    sigma_decay: float = Field(gt=0, le=1, default=0.92, description="σ 每步衰减系数")
    lr_mu: float = Field(gt=0, default=0.1, description="μ 的学习率")
    baseline_decay: float = Field(gt=0, le=1, default=0.9, description="baseline EMA 衰减系数")
    random_seed: int | None = Field(default=None, description="随机种子(固定则可复现)")


class StrategyResult(BaseModel):
    """单个决策策略的计算结果。

    Attributes:
        strategy: 策略名称("ETO-C" / "IEO-C" / "ETO-Q" / "IEO-Q")
        optimal_window: 推荐维修窗口 z*(用户要求 7)
        objective_value: 策略目标值(ETO-C/IEO-C 为期望总成本 E[TC];ETO-Q/IEO-Q 为期望总质量 E[TQ])
        expected_cost: E[C1(z*)] 单次更换期望成本(用户要求 5)
        expected_total_cost: E[TC(z*)] 期望总成本(含折现续跑项)
        expected_quality: E[Q1(z*)] 单次更换期望质量
        expected_total_quality: E[TQ(z*)] 期望总质量(含折现续跑项)
        failure_prob: P(RUL < z*) 失效概率(用户要求 6)
        expected_life: E[L(z*)] 到下次更换的期望周期数
        diff_window_vs_eto: 与 ETO 的窗口差额(仅 IEO 策略,ETO 自身为 0)
        diff_objective_vs_eto: 与 ETO 的目标值差额(仅 IEO 策略,ETO 自身为 0)
    """
    strategy: str
    optimal_window: int
    objective_value: float
    expected_cost: float
    expected_total_cost: float
    expected_quality: float
    expected_total_quality: float
    failure_prob: float
    expected_life: float
    diff_window_vs_eto: int = 0
    diff_objective_vs_eto: float = 0.0


class IEOOptTrace(BaseModel):
    """IEO 优化过程记录(用户要求 8/9:记录随机种子、训练步数和配置)。

    Attributes:
        config: 优化配置(完整记录,保证可追溯)
        n_steps_actual: 实际执行步数
        initial_window: 初始方案(z*_ETO)
        final_mu: 优化结束时的 μ 值
        final_sigma: 优化结束时的 σ 值
        baseline_history: 每步 baseline 值(降方差记录)
        mu_history: 每步 μ 值
        converged: 是否收敛(σ 达到 σ_min 或梯度足够小)
    """
    config: IEOOptConfig
    n_steps_actual: int
    initial_window: int
    final_mu: float
    final_sigma: float
    baseline_history: list[float] = Field(default_factory=list)
    mu_history: list[float] = Field(default_factory=list)
    converged: bool = False


class DecisionResult(BaseModel):
    """完整维修决策结果(四策略 + 曲线 + 假设)。

    Attributes:
        params: 决策参数(回显,保证可追溯)
        windows: 候选窗口集合 Z
        cost_curve: E[C1(z)] 各窗口单次期望成本曲线
        total_cost_curve: E[TC(z)] 各窗口期望总成本曲线
        quality_curve: E[Q1(z)] 各窗口单次期望质量曲线
        total_quality_curve: E[TQ(z)] 各窗口期望总质量曲线
        failure_prob_curve: P(RUL < z) 各窗口失效概率曲线
        expected_life_curve: E[L(z)] 各窗口期望寿命曲线
        strategies: 四策略结果 {"ETO-C": ..., "IEO-C": ..., "ETO-Q": ..., "IEO-Q": ...}
        ieo_traces: IEO 优化过程记录 {"IEO-C": ..., "IEO-Q": ...}
        assumptions: 工程假设说明列表(用户要求 4:工程近似写入报告)
    """
    params: DecisionParams
    windows: list[int]
    cost_curve: list[float]
    total_cost_curve: list[float]
    quality_curve: list[float]
    total_quality_curve: list[float]
    failure_prob_curve: list[float]
    expected_life_curve: list[float]
    strategies: dict[str, StrategyResult]
    ieo_traces: dict[str, IEOOptTrace] = Field(default_factory=dict)
    assumptions: list[str] = Field(default_factory=list)


class RegretResult(BaseModel):
    """Regret 计算结果(规则 10:无真实 RUL 时 regret 为 null)。

    Attributes:
        strategy: 策略名称
        true_rul: 真实 RUL 值(无标签时为 None)
        chosen_window: 策略所选维修窗口
        actual_cost: 真实成本 C_real(ẑ)(无标签时为 None)
        optimal_cost: 完美信息最优成本 C_opt(无标签时为 None)
        regret: regret 值(无标签时为 None,用户要求 3)
    """
    strategy: str
    true_rul: int | None = None
    chosen_window: int
    actual_cost: float | None = None
    optimal_cost: float | None = None
    regret: float | None = None


class FailureFrequencyResult(BaseModel):
    """失效频率接口结果(用户要求 10)。

    对全部候选窗口 Z 输出失效概率曲线 P(RUL < z)。

    Attributes:
        windows: 候选窗口集合 Z
        failure_probs: 各窗口失效概率 P(RUL < z)
        h_max: 最大离散 RUL
    """
    windows: list[int]
    failure_probs: list[float]
    h_max: int


# ──────────────────────────────────────────────
# 决策 API 请求模型
# ──────────────────────────────────────────────

class DecisionRunRequest(BaseModel):
    """决策分析请求体。

    Attributes:
        probs: 离散 RUL 概率向量 P(h),h=0..h_max,长度 h_max+1,Σ=1
        params: 决策参数(缺省使用默认值 cm=1,cd=5,cp=50,cc=200,alpha=0.01,H=150)
        windows: 候选窗口集合(缺省 Z={0,5,...,125})
        ieo_config: IEO 优化配置(缺省使用默认配置)
        use_cache: 是否使用缓存(演示数据推荐开启)
    """
    probs: list[float] = Field(description="离散 RUL 概率向量,长度 h_max+1,Σ=1")
    params: DecisionParams | None = None
    windows: list[int] | None = None
    ieo_config: IEOOptConfig | None = None
    use_cache: bool = True


class RegretRequest(BaseModel):
    """Regret 计算请求体(规则 10:无真实 RUL 时 regret 为 null)。

    Attributes:
        strategy: 策略名称(记录用,如 "ETO-C")
        chosen_window: 策略所选维修窗口 ẑ
        true_rul: 真实 RUL 值(无标签时为 None/省略,regret 返回 null)
        params: 决策参数(缺省使用默认值)
        windows: 候选窗口集合(缺省 Z={0,5,...,125})
    """
    strategy: str = ""
    chosen_window: int = Field(ge=0, description="策略所选维修窗口")
    true_rul: int | None = None
    params: DecisionParams | None = None
    windows: list[int] | None = None


class FailureFrequencyRequest(BaseModel):
    """失效频率请求体(用户要求 10)。

    Attributes:
        probs: 离散 RUL 概率向量 P(h)
        windows: 候选窗口集合(缺省 Z={0,5,...,125})
        h_max: 最大离散 RUL(缺省 150)
    """
    probs: list[float] = Field(description="离散 RUL 概率向量,长度 h_max+1,Σ=1")
    windows: list[int] | None = None
    h_max: int = Field(gt=0, default=150)


# ──────────────────────────────────────────────
# 离线回测相关模型
# ──────────────────────────────────────────────

class BacktestConfig(BaseModel):
    """回测配置。

    Attributes:
        data_mode: 数据模式 "offline"(有真实RUL,可计算regret) / "online"(无真实RUL,regret=null)
        unit_ids: 回测单元列表(None=全部单元)
        step: 决策时点间隔(周期数)
        min_cycle: 最早决策时点(需≥30才能提取特征)
        k_nn: kNN 近邻数
        h_max: 最大离散 RUL
        n_repeats: 重复实验次数
        random_seed: 基础随机种子(第 i 次重复使用 seed+i)
        decision_params: 决策参数(缺省使用决策模块默认值)
        ieo_config: IEO 优化配置(缺省使用决策模块默认值)
        windows: 候选窗口集合(缺省 Z={0,5,...,125})
        sensitivity_param: 敏感性分析参数名("cm"/"cd"/"cp"/"cc"/"alpha"),None=不做
        sensitivity_values: 敏感性分析参数取值列表
        n_calibration_bins: 校准分箱数
        include_points: 是否在结果中包含逐时点详情
    """
    data_mode: str = Field(default="offline", description="数据模式: offline(有真实RUL) / online(无真实RUL)")
    unit_ids: list[int] | None = None
    step: int = Field(gt=0, default=10)
    min_cycle: int = Field(gt=0, default=30)
    k_nn: int = Field(gt=0, default=50)
    h_max: int = Field(gt=0, default=150)
    n_repeats: int = Field(gt=0, default=1)
    random_seed: int | None = None
    decision_params: DecisionParams | None = None
    ieo_config: IEOOptConfig | None = None
    windows: list[int] | None = None
    sensitivity_param: str | None = None
    sensitivity_values: list[float] | None = None
    n_calibration_bins: int = Field(gt=1, default=10)
    include_points: bool = True


class CalibrationBin(BaseModel):
    """校准分箱结果。

    Attributes:
        bin_index: 分箱索引(0-based)
        bin_low: 分箱下界(含)
        bin_high: 分箱上界(不含,末箱含)
        n_points: 落入该箱的时点数
        mean_predicted: 该箱内平均预测失效概率
        observed_freq: 该箱内观测失效频率
    """
    bin_index: int
    bin_low: float
    bin_high: float
    n_points: int
    mean_predicted: float
    observed_freq: float


class StrategyBacktestSummary(BaseModel):
    """单策略回测汇总。

    Attributes:
        strategy: 策略名称
        n_points: 回测时点数
        regret_mean: regret 均值(无真实RUL时为 None)
        regret_median: regret 中位数(无真实RUL时为 None)
        regret_std: regret 标准差(无真实RUL时为 None)
        regret_list: 各时点 regret 列表(无真实RUL时元素为 None)
        failure_frequency: 观测失效频率(无真实RUL时为 None)
        mean_failure_prob: 平均预测失效概率
        calibration_bins: 校准分箱列表(无真实RUL时为空)
        ece: Expected Calibration Error(无真实RUL时为 None)
    """
    strategy: str
    n_points: int
    regret_mean: float | None = None
    regret_median: float | None = None
    regret_std: float | None = None
    regret_list: list[float | None] = Field(default_factory=list)
    failure_frequency: float | None = None
    mean_failure_prob: float = 0.0
    calibration_bins: list[CalibrationBin] = Field(default_factory=list)
    ece: float | None = None


class ETOIEODiffSummary(BaseModel):
    """ETO 与 IEO 差异汇总(按成本/质量目标分组)。

    Attributes:
        target: 目标类型 "C"(成本)或 "Q"(质量)
        window_diff_mean: 窗口差额均值(IEO 窗口 − ETO 窗口)
        window_diff_std: 窗口差额标准差
        objective_diff_mean: 目标值差额均值(IEO − ETO)
        objective_diff_std: 目标值差额标准差
        n_ieo_better: IEO 优于 ETO 的时点数(regret 更小)
        n_ieo_worse: IEO 劣于 ETO 的时点数
        n_ieo_same: IEO 与 ETO 相同的时点数
    """
    target: str
    window_diff_mean: float = 0.0
    window_diff_std: float = 0.0
    objective_diff_mean: float = 0.0
    objective_diff_std: float = 0.0
    n_ieo_better: int = 0
    n_ieo_worse: int = 0
    n_ieo_same: int = 0


class SensitivityPoint(BaseModel):
    """成本敏感性分析数据点。

    Attributes:
        param_name: 变化的参数名
        param_value: 参数取值
        regret_mean_by_strategy: 各策略的 regret 均值(无真实RUL时值为 None)
    """
    param_name: str
    param_value: float
    regret_mean_by_strategy: dict[str, float | None] = Field(default_factory=dict)


class BacktestPointResult(BaseModel):
    """单个回测时点结果(精简版,不含完整决策曲线)。

    Attributes:
        unit_id: 设备单元编号
        cycle: 决策时点周期号
        true_rul: 真实 RUL(无标签时为 None)
        has_true_rul: 是否有真实 RUL 标签
        lam: Weibull 尺度参数
        k: Weibull 形状参数
        predicted_rul_mean: 预测 RUL 均值(λ·Γ(1+1/k))
        nll: 负对数似然(无真实RUL时为 None)
        mae_point: 该点绝对误差(无真实RUL时为 None)
        chosen_windows: 各策略所选窗口 {strategy: window}
        failure_probs: 各策略预测失效概率 {strategy: P_fail}
        objective_values: 各策略目标值 {strategy: obj}
        regrets: 各策略 regret {strategy: regret}(无真实RUL时值为 None)
    """
    unit_id: int
    cycle: int
    true_rul: int | None = None
    has_true_rul: bool = False
    lam: float = 0.0
    k: float = 0.0
    predicted_rul_mean: float = 0.0
    nll: float | None = None
    mae_point: float | None = None
    chosen_windows: dict[str, int] = Field(default_factory=dict)
    failure_probs: dict[str, float] = Field(default_factory=dict)
    objective_values: dict[str, float] = Field(default_factory=dict)
    regrets: dict[str, float | None] = Field(default_factory=dict)


class RepeatMetrics(BaseModel):
    """单次重复实验的汇总指标。

    Attributes:
        repeat_index: 重复序号(0-based)
        random_seed_used: 本次使用的随机种子
        nll_mean: 本次实验的 NLL 均值(无真实RUL时为 None)
        mae_mean: 本次实验的 MAE 均值(无真实RUL时为 None)
        regret_mean_by_strategy: 各策略的 regret 均值(无真实RUL时值为 None)
        failure_freq_by_strategy: 各策略的观测失效频率(无真实RUL时值为 None)
    """
    repeat_index: int
    random_seed_used: int | None = None
    nll_mean: float | None = None
    mae_mean: float | None = None
    regret_mean_by_strategy: dict[str, float | None] = Field(default_factory=dict)
    failure_freq_by_strategy: dict[str, float | None] = Field(default_factory=dict)


class BacktestResult(BaseModel):
    """完整回测结果(结构化 JSON,用户要求 11)。

    Attributes:
        config: 回测配置(回显,保证可追溯)
        n_points: 回测时点总数
        n_units: 回测单元数
        has_true_rul: 是否有真实 RUL 标签(决定 regret/NLL/MAE/校准是否可计算)
        nll_mean: NLL 均值(无真实RUL时为 None)
        nll_std: NLL 标准差(跨重复实验)
        mae_mean: MAE 均值(无真实RUL时为 None)
        mae_std: MAE 标准差(跨重复实验)
        strategies: 各策略回测汇总 {"ETO-C": ..., "IEO-C": ..., "ETO-Q": ..., "IEO-Q": ...}
        eto_ieo_diff: ETO/IEO 差异汇总 {"C": ..., "Q": ...}
        sensitivity: 成本敏感性分析结果列表
        points: 逐时点详情(include_points=False 时为空)
        repeat_metrics: 多次重复实验的汇总指标列表
        assumptions: 工程假设说明列表
        data_sufficiency_note: 数据充分性说明(用户要求:数据不足时明确说明)
    """
    config: BacktestConfig
    n_points: int = 0
    n_units: int = 0
    has_true_rul: bool = False
    nll_mean: float | None = None
    nll_std: float | None = None
    mae_mean: float | None = None
    mae_std: float | None = None
    strategies: dict[str, StrategyBacktestSummary] = Field(default_factory=dict)
    eto_ieo_diff: dict[str, ETOIEODiffSummary] = Field(default_factory=dict)
    sensitivity: list[SensitivityPoint] = Field(default_factory=list)
    points: list[BacktestPointResult] = Field(default_factory=list)
    repeat_metrics: list[RepeatMetrics] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    data_sufficiency_note: str = ""


class BacktestRunRequest(BaseModel):
    """回测分析请求体。

    Attributes:
        session_id: 上传数据返回的会话 ID
        config: 回测配置(缺省使用默认值)
    """
    session_id: str = Field(description="上传数据返回的会话 ID")
    config: BacktestConfig | None = None


# ──────────────────────────────────────────────
# 前端工作台联调模型(传感器趋势 + RUL 概率预测)
# ──────────────────────────────────────────────

class SensorTrendResponse(BaseModel):
    """传感器趋势数据响应(前端图表用,纯数据检索无算法)。

    Attributes:
        session_id: 会话 ID
        unit_id: 设备单元编号
        cycles: 周期序列
        sensor_names: 14 个选定传感器名称
        sensor_data: 传感器名 → 读数列表(与 cycles 等长)
    """
    session_id: str
    unit_id: int
    cycles: list[int]
    sensor_names: list[str]
    sensor_data: dict[str, list[float]]


class RULPredictRequest(BaseModel):
    """RUL 概率预测请求体(复用已有特征工程 + kNN + Weibull 模块)。

    Attributes:
        session_id: 上传数据返回的会话 ID
        unit_id: 目标设备单元编号
        cycle: 预测时点周期号(None = 该单元最后一个周期)
        k_nn: kNN 近邻数(默认 50)
        h_max: 最大离散 RUL(默认 150)
        random_seed: 随机种子(可选)
        step: 参考集采样间隔(默认 10,控制参考集规模)
    """
    session_id: str = Field(description="会话 ID")
    unit_id: int = Field(description="目标设备单元编号")
    cycle: int | None = Field(default=None, description="预测时点周期号,None=最后周期")
    k_nn: int = Field(gt=0, default=50)
    h_max: int = Field(gt=0, default=150)
    random_seed: int | None = None
    step: int = Field(gt=0, default=10)


class RULPredictResponse(BaseModel):
    """RUL 概率预测响应(Weibull 拟合 + 离散概率分布)。

    Attributes:
        session_id: 会话 ID
        unit_id: 设备单元编号
        cycle: 实际预测时点
        weibull: Weibull MLE 拟合结果(λ, k, 对数似然, 样本数)
        discrete: 离散 RUL 概率分布 P(RUL=h), h=0..h_max
        n_reference: 参考集样本数
        assumptions: 工程假设说明
    """
    session_id: str
    unit_id: int
    cycle: int
    weibull: WeibullFitResult
    discrete: DiscreteRULResult
    n_reference: int
    assumptions: list[str] = Field(default_factory=list)


# ──────────────────────────────────────────────
# 运行时 AI Agent 模型(意图识别 → 工具调度 → 结果汇总)
# ──────────────────────────────────────────────

class AgentChatMessage(BaseModel):
    """Agent 对话历史中的单条消息。"""

    role: str = Field(description="角色: user / assistant")
    content: str = Field(description="消息内容")


class AgentChatRequest(BaseModel):
    """运行时 AI Agent 对话请求体。

    前端将当前工作台状态(RUL 分布、决策参数等)随请求发送,
    后端注入 AgentContext(不经过 LLM),由后端工具执行真实计算。

    Attributes:
        session_id: 上传数据返回的会话 ID
        query: 用户问题
        unit_id: 当前选择的设备单元(可选)
        cycle: 当前预测时点周期(可选)
        probs: 当前 RUL 离散概率分布 P(h)(来自 /api/rul/predict 响应)
        h_max: 最大离散 RUL(与 probs 长度一致)
        current_params: 当前决策参数 {cm, cd, cp, cc, alpha}
        history: 对话历史(可选,支持多轮对话)
    """
    session_id: str = Field(description="会话 ID")
    query: str = Field(min_length=1, max_length=2000, description="用户问题")
    unit_id: int | None = Field(default=None, description="当前设备单元")
    cycle: int | None = Field(default=None, description="当前预测时点周期")
    probs: list[float] = Field(default_factory=list, description="当前 RUL 离散概率分布")
    h_max: int = Field(default=150, gt=0, description="最大离散 RUL")
    current_params: dict = Field(default_factory=dict, description="当前决策参数")
    history: list[AgentChatMessage] = Field(default_factory=list, description="对话历史")


class ToolCallLog(BaseModel):
    """单次工具调用记录(供前端展示工具调用过程)。"""

    tool: str = Field(description="工具名称")
    args: dict = Field(default_factory=dict, description="工具参数")
    result: dict | None = Field(default=None, description="工具返回结果")
    round: int = Field(default=1, description="调用轮次")


class AgentChatResponse(BaseModel):
    """运行时 AI Agent 对话响应。

    answer 为 LLM 基于工具返回的结构化结果生成的自然语言汇总。
    所有数值均来自后端工具计算,LLM 不参与数值计算。

    Attributes:
        answer: 最终自然语言回复
        tool_calls_log: 工具调用记录(前端可展示调用过程与真实数据)
        model_used: 实际使用的模型名
        n_rounds: 工具调用轮数
    """
    answer: str
    tool_calls_log: list[ToolCallLog] = Field(default_factory=list)
    model_used: str = ""
    n_rounds: int = 0