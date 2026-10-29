# 离线回测模块
# 包含:多时点决策模拟、NLL/MAE/regret/failure frequency/校准/ETO-IEO差异、
#       成本敏感性分析、多次重复实验、CSV 导出
# 遵循 docs/model_contract.md 第 8 章的指标定义与工程假设
#
# 关键规则:
# - 离线数据可计算真实 regret;在线数据无真实失效时间,regret 恒为 null(规则 10)
# - 不把论文实验结果当作当前结果;数据不足时在报告中明确说明(用户要求)
# - kNN 采用留一单元法防止数据泄露(假设 A-B1)
# - 所有关键数值由后端计算(规则 7/8)

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.special import gamma
from scipy.stats import weibull_min

from app.core.config import get_column_roles, get_quality_thresholds
from app.core.decision import (
    DEFAULT_PARAMS,
    DEFAULT_WINDOWS,
    DecisionError,
    compute_regret,
    run_decision,
)
from app.core.features import FeatureError, compute_norm_params, extract_features
from app.core.rul import RULFitError, discretize_weibull, fit_weibull, knn_retrieve
from app.domain.models import (
    BacktestConfig,
    BacktestPointResult,
    BacktestResult,
    CalibrationBin,
    ETOIEODiffSummary,
    IEOOptConfig,
    RepeatMetrics,
    SensitivityPoint,
    StrategyBacktestSummary,
)

# 四策略名称
_STRATEGY_NAMES = ["ETO-C", "IEO-C", "ETO-Q", "IEO-Q"]


class BacktestError(Exception):
    """回测模块异常,携带错误码(E5001)与详细信息。"""

    def __init__(self, code: str, message: str, detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message}" + (f": {detail}" if detail else ""))


# 回测默认 IEO 配置(比决策模块更轻量,适应多时点批量计算)
_BACKTEST_IEO_CONFIG = IEOOptConfig(
    n_steps=30, batch_size=8, mc_samples=32,
    sigma_init=5.0, sigma_min=0.5, sigma_decay=0.92, lr_mu=0.1,
)

# 敏感性分析用更轻量的 IEO 配置
_SENS_IEO_CONFIG = IEOOptConfig(
    n_steps=20, batch_size=8, mc_samples=32,
    sigma_init=5.0, sigma_min=0.5, sigma_decay=0.92, lr_mu=0.1,
)


@dataclass
class _ReferenceSet:
    """内部参考集:特征矩阵 + 真实 RUL + 所属单元 ID(留一单元法用)。"""
    features: np.ndarray  # (n, 420)
    ruls: np.ndarray      # (n,)
    unit_ids: np.ndarray  # (n,)


@dataclass
class _PointData:
    """内部单时点回测数据(含离散概率,供敏感性分析复用)。"""
    unit_id: int
    cycle: int
    true_rul: int | None
    lam: float
    k: float
    predicted_rul_mean: float
    nll: float | None
    mae_point: float | None
    probs: np.ndarray
    chosen_windows: dict[str, int] = field(default_factory=dict)
    failure_probs: dict[str, float] = field(default_factory=dict)
    objective_values: dict[str, float] = field(default_factory=dict)
    regrets: dict[str, float | None] = field(default_factory=dict)
    diff_windows: dict[str, int] = field(default_factory=dict)
    diff_objectives: dict[str, float] = field(default_factory=dict)


# ──────────────────────────────────────────────
# 参考集构建(假设 A-B1/A-B2)
# ──────────────────────────────────────────────

def _build_reference_set(
    df: pd.DataFrame, config: BacktestConfig, norm_params,
    unit_max_cycles: dict, unit_col: str, cycle_col: str,
    sensors: list[str], window_size: int,
) -> _ReferenceSet:
    """构建参考集:对每个单元每隔 step 周期提取特征 + 真实 RUL(假设 A-B1/A-B2)。"""
    features_list, ruls_list, unit_ids_list = [], [], []

    for unit_id, max_cycle in unit_max_cycles.items():
        for t in range(config.min_cycle, max_cycle + 1, config.step):
            if t < window_size:
                continue
            df_upto = df[(df[unit_col] == unit_id) & (df[cycle_col] <= t)]
            if len(df_upto) < window_size:
                continue
            try:
                feat = extract_features(df_upto, unit_id, normalize=True, norm_params=norm_params)
                features_list.append(feat.feature_vector)
                # 参考集 RUL 始终使用 max_cycle − t:
                # 离线模式为真实 RUL;在线模式为近似值(假设 A-B9),
                # 仅用于 kNN 检索与 Weibull 拟合,不影响测试点的 regret/NLL/MAE 评估
                ruls_list.append(max_cycle - t)
                unit_ids_list.append(unit_id)
            except FeatureError:
                continue

    if not features_list:
        return _ReferenceSet(features=np.empty((0, 0)), ruls=np.empty(0), unit_ids=np.empty(0))

    return _ReferenceSet(
        features=np.array(features_list, dtype=float),
        ruls=np.array(ruls_list, dtype=float),
        unit_ids=np.array(unit_ids_list),
    )


# ──────────────────────────────────────────────
# 单次重复实验:多时点决策模拟
# ──────────────────────────────────────────────

def _run_single_repeat(
    df: pd.DataFrame, config: BacktestConfig, norm_params,
    ref_set: _ReferenceSet, unit_max_cycles: dict,
    test_units: list, unit_col: str, cycle_col: str,
    window_size: int, params, windows, ieo_config,
    has_true_rul: bool, seed: int | None,
) -> list[_PointData]:
    """执行单次重复实验:遍历全部回测时点,提取特征→kNN→Weibull→决策→指标。"""
    point_data_list: list[_PointData] = []

    # 传播随机种子到 IEO 配置(用户要求 8:固定种子时回测结果可复现)
    # 若 ieo_config 已有独立种子则尊重原值,否则使用本次重复的种子
    if seed is not None and ieo_config.random_seed is None:
        ieo_config = ieo_config.model_copy(update={"random_seed": seed})

    for unit_id in test_units:
        max_cycle = unit_max_cycles[unit_id]
        for t in range(config.min_cycle, max_cycle + 1, config.step):
            if t < window_size:
                continue
            try:
                # 1. 提取查询特征(截至周期 t 的最近 30 周期)
                df_upto = df[(df[unit_col] == unit_id) & (df[cycle_col] <= t)]
                if len(df_upto) < window_size:
                    continue
                feat = extract_features(df_upto, unit_id, normalize=True, norm_params=norm_params)
                query = np.array(feat.feature_vector, dtype=float)

                # 2. kNN 检索(留一单元法,假设 A-B1:排除同单元样本)
                mask = ref_set.unit_ids != unit_id
                ref_feat = ref_set.features[mask]
                ref_rul = ref_set.ruls[mask]
                if len(ref_rul) < 2:
                    continue  # 参考样本不足,跳过
                k_eff = min(config.k_nn, len(ref_rul))
                rul_samples = knn_retrieve(query, ref_feat, ref_rul, k=k_eff)

                # 3. Weibull MLE 拟合 + 离散化
                wf = fit_weibull(rul_samples, random_seed=seed)
                dr = discretize_weibull(wf, h_max=config.h_max)
                probs = np.array(dr.probs, dtype=float)

                # 4. 预测 RUL 均值(假设 A-B4:Weibull 均值 λ·Γ(1+1/k))
                pred_rul = float(wf.lam * gamma(1.0 + 1.0 / wf.k))

                # 5. 真实 RUL(仅离线模式)
                true_rul = int(max_cycle - t) if has_true_rul else None

                # 6. NLL(假设 A-B3:-log f(true_rul; k, λ))
                nll = None
                if has_true_rul and true_rul is not None and true_rul > 0:
                    nll = -float(weibull_min.logpdf(true_rul, wf.k, loc=0, scale=wf.lam))

                # 7. MAE 点值
                mae_point = abs(pred_rul - true_rul) if has_true_rul and true_rul is not None else None

                # 8. 四策略决策
                decision = run_decision(
                    probs, params=params, windows=windows,
                    ieo_config=ieo_config, use_cache=False,
                )

                # 9. 逐策略提取结果 + regret
                pd_ = _PointData(
                    unit_id=unit_id, cycle=t, true_rul=true_rul,
                    lam=wf.lam, k=wf.k, predicted_rul_mean=pred_rul,
                    nll=nll, mae_point=mae_point, probs=probs,
                )
                for sn in _STRATEGY_NAMES:
                    sr = decision.strategies[sn]
                    pd_.chosen_windows[sn] = sr.optimal_window
                    pd_.failure_probs[sn] = sr.failure_prob
                    pd_.objective_values[sn] = sr.objective_value
                    if has_true_rul and true_rul is not None:
                        rr = compute_regret(true_rul, sr.optimal_window, windows, params, sn)
                        pd_.regrets[sn] = rr.regret
                    else:
                        pd_.regrets[sn] = None

                # IEO-ETO 差额
                pd_.diff_windows = {
                    "C": pd_.chosen_windows["IEO-C"] - pd_.chosen_windows["ETO-C"],
                    "Q": pd_.chosen_windows["IEO-Q"] - pd_.chosen_windows["ETO-Q"],
                }
                pd_.diff_objectives = {
                    "C": pd_.objective_values["IEO-C"] - pd_.objective_values["ETO-C"],
                    "Q": pd_.objective_values["IEO-Q"] - pd_.objective_values["ETO-Q"],
                }
                point_data_list.append(pd_)

            except (FeatureError, RULFitError, DecisionError):
                continue  # 单点失败不中断整体回测

    return point_data_list


# ──────────────────────────────────────────────
# 单次重复实验指标聚合
# ──────────────────────────────────────────────

def _aggregate_repeat_metrics(
    points: list[_PointData], repeat_idx: int, seed: int | None, has_true_rul: bool,
) -> RepeatMetrics:
    """聚合单次重复实验的汇总指标。"""
    nlls = [p.nll for p in points if p.nll is not None]
    maes = [p.mae_point for p in points if p.mae_point is not None]

    regret_mean_by_strategy: dict[str, float | None] = {}
    failure_freq_by_strategy: dict[str, float | None] = {}

    for sn in _STRATEGY_NAMES:
        if has_true_rul:
            regrets = [p.regrets[sn] for p in points if p.regrets.get(sn) is not None]
            regret_mean_by_strategy[sn] = float(np.mean(regrets)) if regrets else None
            failures = sum(
                1 for p in points
                if p.true_rul is not None and p.true_rul < p.chosen_windows.get(sn, 0)
            )
            failure_freq_by_strategy[sn] = failures / len(points) if points else None
        else:
            regret_mean_by_strategy[sn] = None
            failure_freq_by_strategy[sn] = None

    return RepeatMetrics(
        repeat_index=repeat_idx,
        random_seed_used=seed,
        nll_mean=float(np.mean(nlls)) if nlls else None,
        mae_mean=float(np.mean(maes)) if maes else None,
        regret_mean_by_strategy=regret_mean_by_strategy,
        failure_freq_by_strategy=failure_freq_by_strategy,
    )


# ──────────────────────────────────────────────
# 失效概率校准(假设 A-B5:等宽分箱)
# ──────────────────────────────────────────────

def _compute_calibration(
    points: list[_PointData], strategy: str, n_bins: int, has_true_rul: bool,
) -> tuple[list[CalibrationBin], float | None]:
    """计算失效概率校准分箱与 ECE(假设 A-B5)。"""
    if not has_true_rul or not points:
        return [], None

    # 收集 (预测失效概率, 观测失效指示) 对
    pairs = []
    for p in points:
        pred = p.failure_probs.get(strategy, 0.0)
        obs = 1.0 if (p.true_rul is not None and p.true_rul < p.chosen_windows.get(strategy, 0)) else 0.0
        pairs.append((pred, obs))

    n_total = len(pairs)
    bins: list[CalibrationBin] = []
    ece = 0.0

    for i in range(n_bins):
        low = i / n_bins
        high = (i + 1) / n_bins
        # 末箱含上界
        in_bin = [(pr, o) for pr, o in pairs if (low <= pr < high) or (i == n_bins - 1 and pr == high)]
        n_i = len(in_bin)
        if n_i == 0:
            bins.append(CalibrationBin(bin_index=i, bin_low=low, bin_high=high,
                                       n_points=0, mean_predicted=0.0, observed_freq=0.0))
            continue
        mean_pred = float(np.mean([pr for pr, _ in in_bin]))
        obs_freq = float(np.mean([o for _, o in in_bin]))
        bins.append(CalibrationBin(bin_index=i, bin_low=low, bin_high=high,
                                   n_points=n_i, mean_predicted=mean_pred, observed_freq=obs_freq))
        ece += (n_i / n_total) * abs(mean_pred - obs_freq)

    return bins, float(ece)


# ──────────────────────────────────────────────
# 策略回测汇总
# ──────────────────────────────────────────────

def _build_strategy_summaries(
    points: list[_PointData], config: BacktestConfig, has_true_rul: bool,
) -> dict[str, StrategyBacktestSummary]:
    """构建四策略的回测汇总(regret/failure frequency/校准)。"""
    summaries: dict[str, StrategyBacktestSummary] = {}
    n_points = len(points)

    for sn in _STRATEGY_NAMES:
        if has_true_rul:
            regrets = [p.regrets.get(sn) for p in points]
            valid = [r for r in regrets if r is not None]
            regret_mean = float(np.mean(valid)) if valid else None
            regret_median = float(np.median(valid)) if valid else None
            regret_std = float(np.std(valid)) if valid else None
            failures = sum(1 for p in points
                          if p.true_rul is not None and p.true_rul < p.chosen_windows.get(sn, 0))
            failure_freq = failures / n_points if n_points > 0 else None
        else:
            regrets = [None] * n_points
            regret_mean = regret_median = regret_std = None
            failure_freq = None

        mean_fp = float(np.mean([p.failure_probs.get(sn, 0.0) for p in points])) if points else 0.0
        cal_bins, ece = _compute_calibration(points, sn, config.n_calibration_bins, has_true_rul)

        summaries[sn] = StrategyBacktestSummary(
            strategy=sn, n_points=n_points,
            regret_mean=regret_mean, regret_median=regret_median, regret_std=regret_std,
            regret_list=regrets, failure_frequency=failure_freq,
            mean_failure_prob=mean_fp, calibration_bins=cal_bins, ece=ece,
        )

    return summaries


# ──────────────────────────────────────────────
# ETO 与 IEO 差异汇总(用户要求 6)
# ──────────────────────────────────────────────

def _compute_eto_ieo_diff(
    points: list[_PointData], has_true_rul: bool,
) -> dict[str, ETOIEODiffSummary]:
    """汇总 ETO 与 IEO 的窗口差额、目标值差额与改进计数。"""
    result: dict[str, ETOIEODiffSummary] = {}

    for target in ["C", "Q"]:
        w_diffs = [p.diff_windows.get(target, 0) for p in points]
        o_diffs = [p.diff_objectives.get(target, 0.0) for p in points]

        n_better = n_worse = n_same = 0
        if has_true_rul:
            for p in points:
                r_eto = p.regrets.get(f"ETO-{target}")
                r_ieo = p.regrets.get(f"IEO-{target}")
                if r_eto is not None and r_ieo is not None:
                    if r_ieo < r_eto - 1e-10:
                        n_better += 1
                    elif r_ieo > r_eto + 1e-10:
                        n_worse += 1
                    else:
                        n_same += 1

        result[target] = ETOIEODiffSummary(
            target=target,
            window_diff_mean=float(np.mean(w_diffs)) if w_diffs else 0.0,
            window_diff_std=float(np.std(w_diffs)) if w_diffs else 0.0,
            objective_diff_mean=float(np.mean(o_diffs)) if o_diffs else 0.0,
            objective_diff_std=float(np.std(o_diffs)) if o_diffs else 0.0,
            n_ieo_better=n_better, n_ieo_worse=n_worse, n_ieo_same=n_same,
        )

    return result


# ──────────────────────────────────────────────
# 成本敏感性分析(假设 A-B6:固定 RUL 分布,仅变化成本参数)
# ──────────────────────────────────────────────

def _run_sensitivity(
    points: list[_PointData], config: BacktestConfig, params, windows, has_true_rul: bool,
) -> list[SensitivityPoint]:
    """成本敏感性分析:变化单个成本参数,重新决策并计算 regret 均值(假设 A-B6)。"""
    if not config.sensitivity_param or not config.sensitivity_values:
        return []

    valid_params = {"cm", "cd", "cp", "cc", "alpha"}
    if config.sensitivity_param not in valid_params:
        raise BacktestError(
            "E5001",
            f"无效的敏感性参数: {config.sensitivity_param}",
            f"有效参数: {sorted(valid_params)}",
        )

    sens_ieo = _SENS_IEO_CONFIG.model_copy(
        update={"random_seed": config.random_seed}
    )
    results: list[SensitivityPoint] = []

    for value in config.sensitivity_values:
        modified = params.model_copy(update={config.sensitivity_param: value})
        regrets_by_strategy: dict[str, list[float]] = {sn: [] for sn in _STRATEGY_NAMES}

        for p in points:
            try:
                decision = run_decision(
                    p.probs, params=modified, windows=windows,
                    ieo_config=sens_ieo, use_cache=False,
                )
                if has_true_rul and p.true_rul is not None:
                    for sn in _STRATEGY_NAMES:
                        z_star = decision.strategies[sn].optimal_window
                        rr = compute_regret(p.true_rul, z_star, windows, modified, sn)
                        if rr.regret is not None:
                            regrets_by_strategy[sn].append(rr.regret)
            except DecisionError:
                continue

        regret_mean = {
            sn: float(np.mean(regrets)) if regrets else None
            for sn, regrets in regrets_by_strategy.items()
        }
        results.append(SensitivityPoint(
            param_name=config.sensitivity_param,
            param_value=value,
            regret_mean_by_strategy=regret_mean,
        ))

    return results


# ──────────────────────────────────────────────
# 辅助:点结果转换 / 假设说明 / 数据充分性
# ──────────────────────────────────────────────

def _to_point_result(p: _PointData, has_true_rul: bool) -> BacktestPointResult:
    """将内部 _PointData 转换为 API 输出的 BacktestPointResult。"""
    return BacktestPointResult(
        unit_id=p.unit_id, cycle=p.cycle,
        true_rul=p.true_rul, has_true_rul=has_true_rul,
        lam=p.lam, k=p.k, predicted_rul_mean=p.predicted_rul_mean,
        nll=p.nll, mae_point=p.mae_point,
        chosen_windows=dict(p.chosen_windows),
        failure_probs=dict(p.failure_probs),
        objective_values=dict(p.objective_values),
        regrets=dict(p.regrets),
    )


def _backtest_assumptions(config: BacktestConfig, has_true_rul: bool) -> list[str]:
    """生成回测模块的工程假设说明列表。"""
    assumptions = [
        "【假设说明-A10】回测限定含真实故障时间的训练集数据;在线数据无真实标签,regret 恒为 null。",
        "【假设说明-A-B1】kNN 参考集采用留一单元法(leave-one-unit-out):检索时排除与查询单元相同的样本,防止数据泄露。",
        "【假设说明-A-B2】参考集时点采样步长与回测时点步长一致(均为 step),保证参考集覆盖各退化阶段。",
        "【假设说明-A-B3】NLL 使用 Weibull PDF 在真实 RUL 处的负对数,衡量分布估计质量;true_rul ≤ 0 时跳过该点。",
        "【假设说明-A-B4】MAE 的点预测取 Weibull 均值 λ·Γ(1+1/k),而非中位数或众数。",
        "【假设说明-A-B5】校准分箱采用等宽分箱(宽度 1/K),空箱不参与 ECE 计算。",
        "【假设说明-A-B6】敏感性分析固定 RUL 分布(不重新拟合),仅变化成本参数重新决策。",
        "【假设说明-A-B7】多次重复实验的随机性来源于 Weibull MLE 优化初值与 IEO 蒙特卡洛采样;kNN 检索本身确定性。",
        "【假设说明-A-B8】当前演示/测试数据规模可能不足以复现论文实验,结果仅用于算法验证;数据充分性说明见 data_sufficiency_note。",
    ]
    if not has_true_rul:
        assumptions.append(
            "【假设说明-在线模式】当前为在线数据模式,无真实失效时间标签,"
            "regret/NLL/MAE/校准均为 null。"
        )
        assumptions.append(
            "【假设说明-A-B9】在线模式参考集 RUL 使用数据最大周期(max_cycle)作为"
            "失效时间的近似,仅用于 kNN 检索与 Weibull 拟合,不影响测试点的评估指标。"
        )
    return assumptions


def _generate_sufficiency_note(n_units: int, n_points: int) -> str:
    """生成数据充分性说明(用户要求:数据不足时明确说明,不把论文结果当作当前结果)。"""
    notes = ["本回测结果由 PrognosOps 后端算法基于当前输入数据计算,非论文实验结果。"]
    if n_units < 20:
        notes.append(
            f"当前数据仅含 {n_units} 个单元,不足以复现论文级实验规模"
            f"(FD001 训练集含 100 个单元),结果仅用于算法验证。"
        )
    if n_points < 30:
        notes.append(
            f"当前回测时点数为 {n_points},统计指标(均值/中位数/校准)可能不稳定。"
        )
    return " ".join(notes)


# ──────────────────────────────────────────────
# 主入口:run_backtest
# ──────────────────────────────────────────────

def run_backtest(
    df: pd.DataFrame, config: BacktestConfig | None = None,
) -> BacktestResult:
    """离线回测主入口(用户要求 1~12)。

    流程:
    1. 校验配置与数据模式(offline 可计算真实 regret;online regret=null)
    2. 计算各单元最大周期(真实 RUL 来源)与归一化参数
    3. 构建参考集(留一单元法,假设 A-B1)
    4. 多次重复实验:多时点决策模拟,计算 NLL/MAE/regret/failure frequency
    5. 汇总:策略汇总、ETO/IEO 差异、校准、敏感性分析
    6. 生成假设说明与数据充分性说明

    Args:
        df: FD001 格式 DataFrame(含 unit/cycle/sensor 列)
        config: 回测配置(缺省使用默认值)

    Returns:
        BacktestResult(结构化 JSON,用户要求 11)

    Raises:
        BacktestError: E5001(配置/数据校验失败)
    """
    if config is None:
        config = BacktestConfig()

    # 数据模式校验
    if config.data_mode not in ("offline", "online"):
        raise BacktestError(
            "E5001", f"无效的数据模式: {config.data_mode}", "有效值: offline / online",
        )
    has_true_rul = config.data_mode == "offline"

    # 决策参数与窗口
    params = config.decision_params or DEFAULT_PARAMS
    windows = config.windows or DEFAULT_WINDOWS
    ieo_config = config.ieo_config or _BACKTEST_IEO_CONFIG

    # 列名与窗口
    roles = get_column_roles()
    unit_col = roles["unit_column"]
    cycle_col = roles["cycle_column"]
    sensors = roles["selected_sensors"]
    window_size = get_quality_thresholds()["feature_window"]

    # 各单元最大周期(真实 RUL 来源)
    unit_max_cycles = df.groupby(unit_col)[cycle_col].max().to_dict()
    if not unit_max_cycles:
        raise BacktestError("E5001", "数据中无有效单元")

    # 回测单元
    if config.unit_ids:
        test_units = sorted(u for u in config.unit_ids if u in unit_max_cycles)
        if not test_units:
            raise BacktestError("E5001", "指定的回测单元均不存在于数据中")
    else:
        test_units = sorted(unit_max_cycles.keys())

    # 归一化参数(全量数据计算,假设 A2)
    norm_params = compute_norm_params(df, sensors, window_size)

    # 构建参考集(假设 A-B1/A-B2)
    ref_set = _build_reference_set(
        df, config, norm_params, unit_max_cycles,
        unit_col, cycle_col, sensors, window_size,
    )
    if len(ref_set.ruls) == 0:
        raise BacktestError("E5001", "参考集为空,无法执行回测(数据不足以提取任何参考特征)")

    # 多次重复实验(用户要求 9)
    all_repeat_metrics: list[RepeatMetrics] = []
    first_repeat_points: list[_PointData] = []

    for repeat_idx in range(config.n_repeats):
        seed = (config.random_seed + repeat_idx) if config.random_seed is not None else None
        points = _run_single_repeat(
            df, config, norm_params, ref_set, unit_max_cycles,
            test_units, unit_col, cycle_col, window_size,
            params, windows, ieo_config, has_true_rul, seed,
        )
        rm = _aggregate_repeat_metrics(points, repeat_idx, seed, has_true_rul)
        all_repeat_metrics.append(rm)
        if repeat_idx == 0:
            first_repeat_points = points

    if not first_repeat_points:
        raise BacktestError("E5001", "回测未产生任何有效时点(数据不足以执行多时点决策模拟)")

    n_points = len(first_repeat_points)

    # 策略汇总(用户要求 4/5/7:failure frequency/regret/校准)
    strategy_summaries = _build_strategy_summaries(first_repeat_points, config, has_true_rul)

    # ETO/IEO 差异(用户要求 6)
    eto_ieo_diff = _compute_eto_ieo_diff(first_repeat_points, has_true_rul)

    # 成本敏感性分析(用户要求 10)
    sensitivity = _run_sensitivity(first_repeat_points, config, params, windows, has_true_rul)

    # NLL/MAE 汇总(用户要求 2/3)
    if has_true_rul:
        nlls = [p.nll for p in first_repeat_points if p.nll is not None]
        maes = [p.mae_point for p in first_repeat_points if p.mae_point is not None]
        nll_mean = float(np.mean(nlls)) if nlls else None
        mae_mean = float(np.mean(maes)) if maes else None
        if config.n_repeats > 1:
            rep_nlls = [rm.nll_mean for rm in all_repeat_metrics if rm.nll_mean is not None]
            rep_maes = [rm.mae_mean for rm in all_repeat_metrics if rm.mae_mean is not None]
            nll_std = float(np.std(rep_nlls)) if len(rep_nlls) > 1 else None
            mae_std = float(np.std(rep_maes)) if len(rep_maes) > 1 else None
        else:
            nll_std = mae_std = None
    else:
        nll_mean = nll_std = mae_mean = mae_std = None

    # 逐时点详情(用户要求 11)
    points_out = [
        _to_point_result(p, has_true_rul) for p in first_repeat_points
    ] if config.include_points else []

    return BacktestResult(
        config=config,
        n_points=n_points,
        n_units=len(test_units),
        has_true_rul=has_true_rul,
        nll_mean=nll_mean, nll_std=nll_std,
        mae_mean=mae_mean, mae_std=mae_std,
        strategies=strategy_summaries,
        eto_ieo_diff=eto_ieo_diff,
        sensitivity=sensitivity,
        points=points_out,
        repeat_metrics=all_repeat_metrics,
        assumptions=_backtest_assumptions(config, has_true_rul),
        data_sufficiency_note=_generate_sufficiency_note(len(test_units), n_points),
    )


# ──────────────────────────────────────────────
# CSV 导出(用户要求 12)
# ──────────────────────────────────────────────

def export_backtest_csv(result: BacktestResult) -> str:
    """将回测结果导出为 CSV 字符串(用户要求 12)。

    每行对应一个回测时点 × 一个策略,列格式遵循 model_contract.md 8.6 节。
    """
    header = (
        "unit_id,cycle,true_rul,has_true_rul,lam,k,predicted_rul_mean,"
        "nll,mae_point,strategy,chosen_window,failure_prob,objective_value,regret"
    )
    lines = [header]

    for p in result.points:
        tr = str(p.true_rul) if p.true_rul is not None else ""
        nll_s = f"{p.nll:.6f}" if p.nll is not None else ""
        mae_s = f"{p.mae_point:.6f}" if p.mae_point is not None else ""
        for sn in _STRATEGY_NAMES:
            chosen = p.chosen_windows.get(sn, 0)
            fp = p.failure_probs.get(sn, 0.0)
            ov = p.objective_values.get(sn, 0.0)
            rg = p.regrets.get(sn)
            rg_s = f"{rg:.6f}" if rg is not None else ""
            lines.append(
                f"{p.unit_id},{p.cycle},{tr},{p.has_true_rul},"
                f"{p.lam:.6f},{p.k:.6f},{p.predicted_rul_mean:.6f},"
                f"{nll_s},{mae_s},{sn},{chosen},{fp:.6f},{ov:.6f},{rg_s}"
            )

    return "\n".join(lines)