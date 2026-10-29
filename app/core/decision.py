# 维修决策模块
# 包含:ETO-C/ETO-Q(解析公式)、IEO-C/IEO-Q(MC + REINFORCE 策略梯度)、
#       期望成本/质量曲线、失效概率、regret 接口、failure frequency 接口
# 遵循 docs/model_contract.md 第 7 章的公式与工程假设
#
# 关键规则:
# - 所有关键数值由后端计算,不硬编码论文结果(规则 7/8)
# - 无真实 RUL 时 regret 返回 null(规则 10,用户要求 3)
# - IEO 以 ETO 结果为初始方案,高斯扰动 + MC 估计 + score-function 梯度(用户要求)
# - 不对离散维修窗口强行求导(假设 A-D3)
# - 记录随机种子、训练步数和配置(用户要求 8/9)
# - 支持缓存演示数据结果(用户要求 10)
# - 工程近似写入报告(用户要求 4)

import hashlib

import numpy as np

from app.domain.models import (
    DecisionParams,
    DecisionResult,
    FailureFrequencyResult,
    IEOOptConfig,
    IEOOptTrace,
    RegretResult,
    StrategyResult,
)


class DecisionError(Exception):
    """决策模块异常,携带错误码(E4001)与详细信息。

    Attributes:
        code: 错误码(E4001 决策参数/输入校验失败)
        message: 错误摘要
        detail: 错误详情
    """

    def __init__(self, code: str, message: str, detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message}" + (f": {detail}" if detail else ""))


# ──────────────────────────────────────────────
# 默认常量(用户指定)
# ──────────────────────────────────────────────

DEFAULT_PARAMS = DecisionParams(cm=1, cd=5, cp=50, cc=200, alpha=0.01, h_max=150)
DEFAULT_WINDOWS = list(range(0, 130, 5))  # Z = {0, 5, 10, ..., 125},共 26 个
DEFAULT_IEO_CONFIG = IEOOptConfig()

# 概率归一化校验容差
_PROB_NORM_TOLERANCE = 1e-6

# 决策结果缓存(用户要求 10:支持缓存演示数据结果)
_decision_cache: dict[str, DecisionResult] = {}


def clear_decision_cache() -> None:
    """清空决策结果缓存(仅供测试使用)。"""
    _decision_cache.clear()


# ──────────────────────────────────────────────
# 参数与输入校验(用户要求 5:添加参数校验)
# ──────────────────────────────────────────────

def validate_decision_inputs(
    probs: np.ndarray,
    params: DecisionParams,
    windows: list[int],
) -> np.ndarray:
    """校验决策模块输入:概率向量、参数、候选窗口。

    Args:
        probs: 离散 RUL 概率向量 P(h),h=0..h_max
        params: 决策参数(已由 Pydantic 校验类型约束)
        windows: 候选维修窗口集合 Z

    Returns:
        校验后的概率向量(ndarray)

    Raises:
        DecisionError: E4001(概率非归一/长度不符/窗口非法)
    """
    p = np.asarray(probs, dtype=float)

    # 概率长度校验:必须等于 h_max + 1
    if len(p) != params.h_max + 1:
        raise DecisionError(
            "E4001",
            f"概率向量长度 {len(p)} 与 h_max+1={params.h_max + 1} 不符",
            "概率向量应为 P(h), h=0..h_max,长度 h_max+1",
        )

    # 概率非负校验
    if np.any(p < 0):
        raise DecisionError(
            "E4001",
            "概率向量含负值",
            f"最小值 {float(np.min(p))}",
        )

    # 概率归一化校验(容差 1e-6)
    total = float(np.sum(p))
    if abs(total - 1.0) > _PROB_NORM_TOLERANCE:
        raise DecisionError(
            "E4001",
            f"概率向量未归一化:ΣP(h)={total},期望 1.0(容差 {_PROB_NORM_TOLERANCE})",
        )

    # 窗口校验
    if len(windows) == 0:
        raise DecisionError("E4001", "候选窗口集合 Z 为空")
    if any(w < 0 for w in windows):
        raise DecisionError("E4001", "候选窗口含负值")
    if len(set(windows)) != len(windows):
        raise DecisionError("E4001", "候选窗口含重复值")

    # 业务规则:cc 应大于 cp(否则预防性维护无意义),仅警告不报错
    # 此情况在假设中说明,不阻止计算

    return p


# ──────────────────────────────────────────────
# 核心解析公式(model_contract.md 7.3 节)
# ──────────────────────────────────────────────

def compute_expected_cost_single(
    probs: np.ndarray, z: int, params: DecisionParams,
) -> float:
    """单次更换期望成本 E[C1(z)](model_contract.md 7.3.1)。

    E[C1(z)] = Σ_h P(h)·(replace_cost(h) + min(h,z)·c_run)
    其中 replace_cost = cc if h < z else cp

    特例:z=0 时 E[C1(0)] = cp(立即预防性更换,无运行成本)。

    Args:
        probs: 概率向量 P(h),h=0..h_max
        z: 候选维修窗口
        params: 决策参数

    Returns:
        E[C1(z)] 期望成本
    """
    c_run = params.cm + params.cd
    h = np.arange(params.h_max + 1)
    run_cost = np.minimum(h, z) * c_run
    replace_cost = np.where(h < z, params.cc, params.cp)
    return float(np.sum(probs * (replace_cost + run_cost)))


def compute_expected_life(probs: np.ndarray, z: int, h_max: int) -> float:
    """到下次更换的期望周期数 E[L(z)](model_contract.md 7.3.2)。

    E[L(z)] = Σ_h P(h)·min(h, z)

    Args:
        probs: 概率向量 P(h)
        z: 候选维修窗口
        h_max: 最大离散 RUL

    Returns:
        E[L(z)] 期望周期数
    """
    h = np.arange(h_max + 1)
    return float(np.sum(probs * np.minimum(h, z)))


def compute_failure_prob(probs: np.ndarray, z: int, h_max: int) -> float:
    """失效概率 P(RUL < z)(model_contract.md 7.3.3)。

    P_fail(z) = Σ_{h=0}^{z-1} P(h)
    特例:z=0 时 P_fail(0) = 0。

    Args:
        probs: 概率向量 P(h)
        z: 候选维修窗口
        h_max: 最大离散 RUL

    Returns:
        P(RUL < z) 失效概率
    """
    if z <= 0:
        return 0.0
    z_eff = min(z, h_max + 1)
    return float(np.sum(probs[:z_eff]))


def compute_expected_quality_single(
    probs: np.ndarray, z: int, params: DecisionParams,
) -> float:
    """单次更换期望质量 E[Q1(z)](model_contract.md 7.3.4,假设 A8)。

    E[Q1(z)] = E[L(z)] − w_f · P_fail(z)
    w_f = (cc − cp) / max(cd, 1)

    Args:
        probs: 概率向量 P(h)
        z: 候选维修窗口
        params: 决策参数

    Returns:
        E[Q1(z)] 期望质量
    """
    w_f = (params.cc - params.cp) / max(params.cd, 1)
    e_life = compute_expected_life(probs, z, params.h_max)
    p_fail = compute_failure_prob(probs, z, params.h_max)
    return e_life - w_f * p_fail


# ──────────────────────────────────────────────
# 窗口离散化辅助(假设 A-D3:不参与求导)
# ──────────────────────────────────────────────

def _snap_to_windows(z: float, windows_arr: np.ndarray) -> int:
    """将连续值 z 映射到最近的候选窗口(假设 A-D3)。

    先裁剪到 [min(Z), max(Z)],再取最近候选。
    此函数为确定性映射,不参与梯度计算。
    """
    z_clipped = float(np.clip(z, windows_arr[0], windows_arr[-1]))
    idx = int(np.argmin(np.abs(windows_arr - z_clipped)))
    return int(windows_arr[idx])


# ──────────────────────────────────────────────
# ETO 策略:解析公式(model_contract.md 7.4 节)
# ──────────────────────────────────────────────

def _compute_curves(
    probs: np.ndarray, windows: list[int], params: DecisionParams,
) -> dict[str, list[float]]:
    """计算全部候选窗口的各曲线值(期望成本/质量/寿命/失效概率/总成本/总质量)。"""
    cost_curve = [compute_expected_cost_single(probs, z, params) for z in windows]
    quality_curve = [compute_expected_quality_single(probs, z, params) for z in windows]
    life_curve = [compute_expected_life(probs, z, params.h_max) for z in windows]
    fail_curve = [compute_failure_prob(probs, z, params.h_max) for z in windows]

    # ETO 两阶段近似(假设 A7):
    # E[TC(z)] = E[C1(z)] + alpha^{E[L(z)]} · V_C,V_C = min E[C1(z')]
    # E[TQ(z)] = E[Q1(z)] + alpha^{E[L(z)]} · V_Q,V_Q = max E[Q1(z')]
    v_c = min(cost_curve)
    v_q = max(quality_curve)
    total_cost_curve = [
        cost_curve[i] + (params.alpha ** life_curve[i]) * v_c
        for i in range(len(windows))
    ]
    total_quality_curve = [
        quality_curve[i] + (params.alpha ** life_curve[i]) * v_q
        for i in range(len(windows))
    ]

    return {
        "cost_curve": cost_curve,
        "quality_curve": quality_curve,
        "life_curve": life_curve,
        "fail_curve": fail_curve,
        "total_cost_curve": total_cost_curve,
        "total_quality_curve": total_quality_curve,
        "v_c": v_c,
        "v_q": v_q,
    }


# ──────────────────────────────────────────────
# IEO 策略:MC + REINFORCE 策略梯度(model_contract.md 7.4 节)
# ──────────────────────────────────────────────

def _ieo_optimize(
    probs: np.ndarray,
    windows_arr: np.ndarray,
    params: DecisionParams,
    initial_window: int,
    config: IEOOptConfig,
    maximize: bool,
    v_renewal: float,
) -> tuple[int, IEOOptTrace]:
    """IEO 策略梯度优化核心(用户要求 1~9)。

    以 ETO 结果为初始方案(要求 1),高斯扰动采样(要求 3),
    MC 估计总成本/总质量(要求 4),score-function 梯度更新 μ(要求 5),
    baseline 降方差(要求 6),不对离散窗口求导(要求 7,假设 A-D3),
    σ 退火衰减(假设 A-D2),记录种子/步数/配置(要求 8/9)。

    MC 估计使用逐样本折现:E[TC] ≈ mean(C1_i + alpha^{L_i}·V_C),
    比解析公式 alpha^{E[L]}·V_C 更精确(假设 A-D5:Jensen 不等式修正)。

    Args:
        probs: 概率向量 P(h)
        windows_arr: 候选窗口数组
        params: 决策参数
        initial_window: 初始方案(z*_ETO)
        config: 优化配置
        maximize: True 为最大化(质量),False 为最小化(成本)
        v_renewal: 续跑阶段最优值(V_C=min E[C1] 或 V_Q=max E[Q1])

    Returns:
        (最终推荐窗口, 优化过程记录)
    """
    rng = np.random.default_rng(config.random_seed)
    c_run = params.cm + params.cd
    h_arr = np.arange(params.h_max + 1)
    w_f = (params.cc - params.cp) / max(params.cd, 1)

    mu = float(initial_window)
    sigma = float(config.sigma_init)
    baseline: float | None = None
    mu_history: list[float] = []
    baseline_history: list[float] = []

    for _ in range(config.n_steps):
        # 1. 采样连续窗口(高斯扰动,要求 3)
        z_samples = rng.normal(mu, sigma, size=config.batch_size)

        # 2. 离散化:映射到最近候选窗口(假设 A-D3:不参与求导)
        z_disc = np.array([_snap_to_windows(z, windows_arr) for z in z_samples])

        # 3. MC 目标值估计(要求 4):从 P(h) 采样 RUL,计算总成本/总质量
        h_mc = rng.choice(h_arr, size=(config.batch_size, config.mc_samples), p=probs)
        z_b = z_disc[:, np.newaxis]  # (batch, 1) 广播

        # L_i = min(h, z):到下次更换的周期数
        l_mc = np.minimum(h_mc, z_b)

        if not maximize:
            # 总成本:TC = C1 + alpha^L · V_C(假设 A-D1/A-D5)
            # C1 = (cc + h·c_run) if h < z else (cp + z·c_run)
            c1_mc = np.where(
                h_mc < z_b,
                params.cc + h_mc * c_run,
                params.cp + z_b * c_run,
            )
            obj_mc = c1_mc + (params.alpha ** l_mc) * v_renewal
        else:
            # 总质量:TQ = Q1 + alpha^L · V_Q(假设 A-D1/A-D5)
            # Q1 = min(h, z) − w_f·1{h < z}
            q1_mc = l_mc - w_f * (h_mc < z_b).astype(float)
            obj_mc = q1_mc + (params.alpha ** l_mc) * v_renewal

        obj_est = np.mean(obj_mc, axis=1)  # (batch,) 每个窗口的 MC 估计值

        # 4. Baseline 更新(要求 6:降低方差)
        batch_mean = float(np.mean(obj_est))
        if baseline is None:
            baseline = batch_mean
        else:
            d = config.baseline_decay
            baseline = d * baseline + (1 - d) * batch_mean

        # 5. 优势
        advantages = obj_est - baseline

        # 6. Score-function 梯度(要求 5):
        #    g_μ = mean(A_i · (z_i − μ) / σ²)
        #    基于连续高斯样本 z_i 计算,非 snap 后的 z_i_disc(假设 A-D3)
        g_mu = float(np.mean(advantages * (z_samples - mu) / (sigma ** 2)))

        # 7. 参数更新:最小化→梯度下降;最大化→梯度上升
        if maximize:
            mu = mu + config.lr_mu * g_mu
        else:
            mu = mu - config.lr_mu * g_mu
        mu = float(np.clip(mu, windows_arr[0], windows_arr[-1]))

        # 8. σ 退火衰减(假设 A-D2:非梯度更新,保证收敛稳定)
        sigma = max(sigma * config.sigma_decay, config.sigma_min)

        mu_history.append(mu)
        baseline_history.append(baseline)

    # 收敛判定:σ 已降至最小值
    converged = sigma <= config.sigma_min + 1e-8

    final_window = _snap_to_windows(mu, windows_arr)

    trace = IEOOptTrace(
        config=config,
        n_steps_actual=len(mu_history),
        initial_window=initial_window,
        final_mu=mu,
        final_sigma=sigma,
        baseline_history=baseline_history,
        mu_history=mu_history,
        converged=converged,
    )
    return final_window, trace


# ──────────────────────────────────────────────
# Regret 接口(规则 10,用户要求 3/9)
# ──────────────────────────────────────────────

def compute_regret(
    true_rul: int | None,
    chosen_window: int,
    windows: list[int],
    params: DecisionParams,
    strategy: str = "",
) -> RegretResult:
    """计算 regret(规则 10:无真实 RUL 时返回 null)。

    给定真实 RUL r* 与策略所选窗口 ẑ:
    1. C_real(ẑ) = (cc + r*·c_run) 若 r* < ẑ;否则 (cp + ẑ·c_run)
    2. C_opt = min_{z∈Z} C_real(z)
    3. Regret = C_real(ẑ) − C_opt ≥ 0

    Args:
        true_rul: 真实 RUL 值(None 时 regret 为 null)
        chosen_window: 策略所选维修窗口 ẑ
        windows: 候选窗口集合 Z
        params: 决策参数
        strategy: 策略名称(记录用)

    Returns:
        RegretResult(regret 为 None 当 true_rul 为 None)
    """
    if true_rul is None:
        # 无真实 RUL 标签:regret 返回 null(规则 10,用户要求 3)
        return RegretResult(
            strategy=strategy,
            true_rul=None,
            chosen_window=chosen_window,
            actual_cost=None,
            optimal_cost=None,
            regret=None,
        )

    c_run = params.cm + params.cd
    r_star = int(true_rul)

    # 真实成本 C_real(ẑ)
    if r_star < chosen_window:
        actual_cost = params.cc + r_star * c_run
    else:
        actual_cost = params.cp + chosen_window * c_run

    # 完美信息最优成本 C_opt = min_{z∈Z} C_real(z)
    def _real_cost(z: int) -> float:
        if r_star < z:
            return params.cc + r_star * c_run
        return params.cp + z * c_run

    optimal_cost = min(_real_cost(z) for z in windows)

    regret = actual_cost - optimal_cost

    return RegretResult(
        strategy=strategy,
        true_rul=r_star,
        chosen_window=chosen_window,
        actual_cost=float(actual_cost),
        optimal_cost=float(optimal_cost),
        regret=float(regret),
    )


# ──────────────────────────────────────────────
# 失效频率接口(用户要求 10)
# ──────────────────────────────────────────────

def compute_failure_frequency(
    probs: np.ndarray, windows: list[int], h_max: int,
) -> FailureFrequencyResult:
    """失效频率接口:对全部候选窗口输出 P(RUL < z) 曲线(用户要求 10)。

    Args:
        probs: 概率向量 P(h)
        windows: 候选窗口集合 Z
        h_max: 最大离散 RUL

    Returns:
        FailureFrequencyResult(windows, failure_probs, h_max)
    """
    failure_probs = [compute_failure_prob(probs, z, h_max) for z in windows]
    return FailureFrequencyResult(
        windows=list(windows),
        failure_probs=failure_probs,
        h_max=h_max,
    )


# ──────────────────────────────────────────────
# 工程假设说明(用户要求 4:工程近似写入报告)
# ──────────────────────────────────────────────

def _decision_assumptions(params: DecisionParams) -> list[str]:
    """生成决策模块的工程假设说明列表(用户要求 4)。"""
    assumptions = [
        "【假设说明-A7】ETO 采用'单次更换 + 折现后续最优'两阶段近似无限期更新过程,非精确迭代求解。",
        f"【假设说明-A8】质量 Q 定义为期望正常运行周期数减去故障惩罚,"
        f"故障质量惩罚权重 w_f = (cc−cp)/max(cd,1) = ({params.cc}−{params.cp})/max({params.cd},1) "
        f"为工程约定,将成本结构映射到质量尺度。",
        "【假设说明-A9】四策略定义:ETO 为解析两阶段公式;IEO 为蒙特卡洛 + 策略梯度优化,以 ETO 结果初始化。",
        "【假设说明-A-D1】IEO 的 MC 成本估计使用与解析公式相同的单次更换成本模型 C1(z,h),保证目标一致。",
        "【假设说明-A-D2】IEO 的 σ 采用退火式衰减(非 score-function 梯度更新),μ 采用 score-function 梯度更新,保证收敛稳定性。",
        "【假设说明-A-D3】离散窗口映射 snap(z) 不参与求导:score-function 梯度基于连续高斯样本计算,而非 snap 后的离散窗口。",
        "【假设说明-A-D4】IEO 优化结果可能与 ETO 相同(解析公式已是最优时),差额 Δz=0 属正常。",
        "【假设说明-A-D5】alpha^{E[L]} 采用解析期望的幂(非 E[alpha^L]),受 Jensen 不等式影响,与 MC 估计可能存在微小差异。",
    ]
    if params.cc <= params.cp:
        assumptions.append(
            f"【假设说明-警告】cc={params.cc} ≤ cp={params.cp}:纠正性更换成本不高于预防性更换,"
            "预防性维护失去成本优势,策略可能退化为延迟更换。"
        )
    return assumptions


# ──────────────────────────────────────────────
# 缓存(用户要求 10:支持缓存演示数据结果)
# ──────────────────────────────────────────────

def _cache_key(
    probs: np.ndarray, params: DecisionParams, config: IEOOptConfig,
) -> str:
    """生成决策结果缓存键(基于概率向量 + 参数 + 配置的哈希)。"""
    parts = [
        np.array2string(np.asarray(probs, dtype=float), precision=10, max_line_width=10000),
        params.model_dump_json(),
        config.model_dump_json(),
    ]
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()


# ──────────────────────────────────────────────
# 主入口:run_decision
# ──────────────────────────────────────────────

def run_decision(
    probs: np.ndarray | list[float],
    params: DecisionParams | None = None,
    windows: list[int] | None = None,
    ieo_config: IEOOptConfig | None = None,
    use_cache: bool = True,
) -> DecisionResult:
    """维修决策主入口:计算四策略 + 全部曲线 + 假设说明(用户要求 1~8)。

    流程:
    1. 校验输入(概率归一化/长度/窗口合法性)
    2. 解析计算 E[C1(z)]、E[Q1(z)]、E[L(z)]、P_fail(z) 曲线
    3. ETO-C:argmin E[TC(z)](两阶段近似,假设 A7)
    4. ETO-Q:argmax E[TQ(z)](两阶段近似,假设 A7)
    5. IEO-C:以 ETO-C 为初始方案,MC + REINFORCE 优化 E[C1(z)]
    6. IEO-Q:以 ETO-Q 为初始方案,MC + REINFORCE 优化 E[Q1(z)]
    7. 汇总四策略结果、与 ETO 差额、IEO 优化记录、假设说明

    Args:
        probs: 离散 RUL 概率向量 P(h),h=0..h_max
        params: 决策参数(默认 cm=1, cd=5, cp=50, cc=200, alpha=0.01, H=150)
        windows: 候选窗口集合(默认 Z={0,5,...,125})
        ieo_config: IEO 优化配置(默认 n_steps=50, batch=16, mc=64)
        use_cache: 是否使用缓存(演示数据推荐开启,用户要求 10)

    Returns:
        DecisionResult(四策略 + 曲线 + IEO 记录 + 假设)

    Raises:
        DecisionError: E4001(输入校验失败)
    """
    if params is None:
        params = DEFAULT_PARAMS
    if windows is None:
        windows = DEFAULT_WINDOWS
    if ieo_config is None:
        ieo_config = DEFAULT_IEO_CONFIG

    # 缓存查找(用户要求 10)
    if use_cache:
        key = _cache_key(np.asarray(probs, dtype=float), params, ieo_config)
        if key in _decision_cache:
            return _decision_cache[key]

    # 输入校验(用户要求 5)
    p = validate_decision_inputs(probs, params, windows)
    windows_arr = np.asarray(windows, dtype=float)

    # 计算全部曲线
    curves = _compute_curves(p, windows, params)

    # ── ETO-C:argmin E[TC(z)] ──
    etc_idx = int(np.argmin(curves["total_cost_curve"]))
    eto_c_window = windows[etc_idx]

    # ── ETO-Q:argmax E[TQ(z)] ──
    etq_idx = int(np.argmax(curves["total_quality_curve"]))
    eto_q_window = windows[etq_idx]

    # ── IEO-C:MC + REINFORCE,以 ETO-C 为初始方案,优化 E[TC(z)] ──
    ieo_c_window, ieo_c_trace = _ieo_optimize(
        p, windows_arr, params, eto_c_window, ieo_config,
        maximize=False, v_renewal=curves["v_c"],
    )

    # ── IEO-Q:MC + REINFORCE,以 ETO-Q 为初始方案,优化 E[TQ(z)] ──
    ieo_q_window, ieo_q_trace = _ieo_optimize(
        p, windows_arr, params, eto_q_window, ieo_config,
        maximize=True, v_renewal=curves["v_q"],
    )

    # ── 构建四策略结果 ──
    def _strategy_result(
        name: str, z_star: int, is_cost: bool, is_eto: bool,
        eto_window: int,
    ) -> StrategyResult:
        """构建单个策略的完整结果。

        目标值:成本策略取 E[TC(z*)](期望总成本),质量策略取 E[TQ(z*)](期望总质量),
        与 ETO/IEO 优化的目标一致。
        """
        idx = windows.index(z_star)
        e_cost = curves["cost_curve"][idx]
        e_tcost = curves["total_cost_curve"][idx]
        e_qual = curves["quality_curve"][idx]
        e_tqual = curves["total_quality_curve"][idx]
        e_life = curves["life_curve"][idx]
        p_fail = curves["fail_curve"][idx]

        # 目标值:成本策略取期望总成本,质量策略取期望总质量
        obj = e_tcost if is_cost else e_tqual

        # 与 ETO 的差额(用户要求 8):仅 IEO 策略计算
        if is_eto:
            diff_z = 0
            diff_obj = 0.0
        else:
            diff_z = z_star - eto_window
            # IEO-C 差额为总成本差(负=改进);IEO-Q 差额为总质量差(正=改进)
            eto_idx = windows.index(eto_window)
            eto_total = curves["total_cost_curve"][eto_idx] if is_cost else curves["total_quality_curve"][eto_idx]
            diff_obj = obj - eto_total

        return StrategyResult(
            strategy=name,
            optimal_window=z_star,
            objective_value=obj,
            expected_cost=e_cost,
            expected_total_cost=e_tcost,
            expected_quality=e_qual,
            expected_total_quality=e_tqual,
            failure_prob=p_fail,
            expected_life=e_life,
            diff_window_vs_eto=diff_z,
            diff_objective_vs_eto=diff_obj,
        )

    strategies = {
        "ETO-C": _strategy_result("ETO-C", eto_c_window, True, True, eto_c_window),
        "IEO-C": _strategy_result("IEO-C", ieo_c_window, True, False, eto_c_window),
        "ETO-Q": _strategy_result("ETO-Q", eto_q_window, False, True, eto_q_window),
        "IEO-Q": _strategy_result("IEO-Q", ieo_q_window, False, False, eto_q_window),
    }

    result = DecisionResult(
        params=params,
        windows=list(windows),
        cost_curve=curves["cost_curve"],
        total_cost_curve=curves["total_cost_curve"],
        quality_curve=curves["quality_curve"],
        total_quality_curve=curves["total_quality_curve"],
        failure_prob_curve=curves["fail_curve"],
        expected_life_curve=curves["life_curve"],
        strategies=strategies,
        ieo_traces={"IEO-C": ieo_c_trace, "IEO-Q": ieo_q_trace},
        assumptions=_decision_assumptions(params),
    )

    # 写入缓存(用户要求 10)
    if use_cache:
        _decision_cache[key] = result

    return result