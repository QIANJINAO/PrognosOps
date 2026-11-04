# Weibull 概率预测模块
# 包含:kNN 检索、Weibull MLE 拟合、离散 RUL 概率生成
# 遵循 docs/model_contract.md 中的公式与工程假设
#
# 关键规则:
# - 输出 lambda 和 k,且必须为正数(用户要求 1/2)
# - 显式使用生存函数 S(t) = exp(-(t/λ)^k) 进行离散化(用户要求 3)
# - 生成 H=150 的离散 RUL 概率(用户要求 4)
# - 输出前校验概率归一化,不通过则报错(用户要求 5)
# - 支持固定随机种子保证可复现(用户要求 6)
# - 所有参数由 MLE 从样本拟合,不硬编码任何论文结果(假设 A5)

import logging

import numpy as np
from scipy.stats import weibull_min

from app.domain.models import DiscreteRULResult, WeibullFitResult

logger = logging.getLogger(__name__)


class RULFitError(Exception):
    """RUL 估计异常,携带错误码(E3001)与详细信息。

    Attributes:
        code: 错误码(E3001 Weibull 拟合失败)
        message: 错误摘要
        detail: 错误详情
    """

    def __init__(self, code: str, message: str, detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message}" + (f": {detail}" if detail else ""))


# 归一化校验容差(假设 A-W2)
_NORM_TOLERANCE = 1e-6


# ──────────────────────────────────────────────
# kNN 检索(假设 A3/A4)
# ──────────────────────────────────────────────

def knn_retrieve(
    query_feature: np.ndarray,
    reference_features: np.ndarray,
    reference_ruls: np.ndarray,
    k: int = 50,
) -> np.ndarray:
    """在参考集中检索 k 个最近邻的真实 RUL 值(假设 A3:kNN 基线方法)。

    使用欧氏距离在 420 维特征空间中检索。

    Args:
        query_feature: 查询特征向量 (420,)
        reference_features: 参考集特征矩阵 (n, 420)
        reference_ruls: 参考集真实 RUL 值 (n,)
        k: 近邻数(默认 50,假设 A4)

    Returns:
        k 个最近邻的 RUL 值数组 (k,)

    Raises:
        RULFitError: 参考集为空或 k 超出范围
    """
    if reference_features.shape[0] == 0:
        raise RULFitError("E3001", "参考集为空,无法执行 kNN 检索")
    if k <= 0 or k > reference_features.shape[0]:
        raise RULFitError(
            "E3001",
            f"kNN 近邻数 k={k} 无效",
            f"参考集大小为 {reference_features.shape[0]},k 须在 [1, {reference_features.shape[0]}] 范围内",
        )

    # 欧氏距离(L2)
    distances = np.linalg.norm(reference_features - query_feature, axis=1)
    # 取距离最小的 k 个索引
    nearest_indices = np.argsort(distances)[:k]
    return reference_ruls[nearest_indices]


# ──────────────────────────────────────────────
# Weibull 生存函数(用户要求 3:明确的 survival function)
# ──────────────────────────────────────────────

def weibull_survival(t: float | np.ndarray, lam: float, k: float) -> float | np.ndarray:
    """Weibull 生存函数(用户要求 3:使用明确的 survival function)。

    S(t; k, λ) = exp(-(t / λ)^k),    t ≥ 0

    含义:S(t) = P(T > t),即设备存活超过 t 周期的概率。

    Args:
        t: 时间点(周期数),标量或数组
        lam: 尺度参数 λ(必须 > 0)
        k: 形状参数(必须 > 0)

    Returns:
        生存概率,与 t 同形状
    """
    return np.exp(-np.power(t / lam, k))


# ──────────────────────────────────────────────
# Weibull MLE 拟合(用户要求 1/2/6,假设 A5/A-W1)
# ──────────────────────────────────────────────

def fit_weibull(
    rul_samples: np.ndarray,
    random_seed: int | None = None,
) -> WeibullFitResult:
    """对 RUL 样本执行 Weibull 极大似然拟合(用户要求 1/2/6)。

    使用 scipy.stats.weibull_min.fit(samples, floc=0) 拟合双参数 Weibull
    (位置参数固定为 0,假设 A-W1)。固定随机种子时,先设置 numpy 随机状态
    保证优化过程的可复现性(用户要求 6)。

    Args:
        rul_samples: 正值 RUL 样本数组(来自 kNN 检索或直接标签)
        random_seed: 随机种子(None 表示不固定,用户要求 6)

    Returns:
        WeibullFitResult(lam, k, log_likelihood, n_samples)

    Raises:
        RULFitError: E3001(含负值/样本不足/有效正样本不足/拟合失败/似然非有限)
    """
    samples = np.asarray(rul_samples, dtype=float)

    # 四类样本统计(S00:负值判断先于样本数校验,-inf 按负值报错)
    finite_mask = np.isfinite(samples)
    negative_mask = samples < 0          # 含 -inf;NaN 比较为 False,安全
    zero_mask = finite_mask & (samples == 0)
    positive_mask = finite_mask & (samples > 0)

    n_total = int(samples.size)
    n_non_finite = int(np.sum(~finite_mask))  # NaN / +inf / -inf
    n_negative = int(np.sum(negative_mask))   # 有限负值 + -inf
    n_zero = int(np.sum(zero_mask))
    n_positive = int(np.sum(positive_mask))

    valid_samples = samples[positive_mask]

    # 分支 1:存在负值必须报负值错误(先于样本数校验,避免 [-5.0] 误报"样本不足")
    if n_negative > 0:
        neg_idx = np.where(negative_mask)[0][:10]
        neg_vals = samples[neg_idx].tolist()
        raise RULFitError(
            "E3001",
            f"Weibull 拟合样本含负值: {neg_vals}(共 {n_negative} 个)",
            "RUL 样本不应出现负值,请核查预测周期、标签计算或候选样本生成逻辑",
        )

    # 分支 2:样本总数不足
    if n_total < 2:
        raise RULFitError(
            "E3001",
            f"Weibull 拟合样本不足:至少需要 2 个样本,实际 {n_total} 个",
        )

    # 分支 3:非有限值(NaN/+inf)记录日志后排除继续(-inf 已在分支 1 报错)
    if n_non_finite > 0:
        logger.warning(
            "Weibull 拟合输入含 %d 个非有限值(NaN/Inf),已排除后继续拟合",
            n_non_finite,
        )

    # 分支 4:有效正样本不足
    if n_positive < 2:
        raise RULFitError(
            "E3001",
            f"Weibull 拟合有效 RUL 样本不足:正值 {n_positive} 个,零值 {n_zero} 个,非有限值 {n_non_finite} 个",
            "Weibull 分布的支撑集为 (0, +∞),至少需要 2 个有效正样本才能拟合",
        )

    # 固定随机种子(用户要求 6:支持固定随机种子;保持在所有校验之后、拟合调用之前)
    if random_seed is not None:
        np.random.seed(random_seed)

    # MLE 拟合:双参数 Weibull,位置参数固定为 0(假设 A-W1);只用有效正样本
    try:
        shape_k, loc, scale_lam = weibull_min.fit(valid_samples, floc=0)
    except Exception:
        logger.exception("Weibull MLE 拟合数值计算失败(有效样本 %d 个)", n_positive)
        raise RULFitError(
            "E3001",
            "Weibull MLE 拟合数值计算失败",
            "拟合过程出现数值异常,请检查样本分布或调整候选样本;详细原因见服务日志。",
        )

    # 参数正性校验(用户要求 2:lambda 和 k 必须为正数)
    if not (scale_lam > 0 and shape_k > 0):
        raise RULFitError(
            "E3001",
            f"Weibull 拟合参数非正: λ={scale_lam}, k={shape_k}",
            "λ 和 k 必须为正数,拟合结果不满足此约束",
        )

    # 计算对数似然值(只用有效正样本,防止 -inf 进入响应与 JSON 序列化)
    log_likelihood = float(np.sum(
        weibull_min.logpdf(valid_samples, shape_k, loc=0, scale=scale_lam)
    ))

    if not np.isfinite(log_likelihood):
        logger.error(
            "Weibull 对数似然为非有限值: λ=%s, k=%s, n_positive=%d",
            scale_lam, shape_k, n_positive,
        )
        raise RULFitError(
            "E3001",
            "Weibull 对数似然为非有限值,拟合结果不可用",
            "样本分布或拟合参数异常,请调整候选样本;详细原因见服务日志。",
        )

    return WeibullFitResult(
        lam=float(scale_lam),
        k=float(shape_k),
        log_likelihood=log_likelihood,
        n_samples=n_positive,
        n_zero=n_zero,
        n_negative=n_negative,      # 成功路径必为 0,负值已在分支 1 报错
        n_non_finite=n_non_finite,  # 成功路径为 NaN/+inf 数量
    )


# ──────────────────────────────────────────────
# 离散化(用户要求 4/5,假设 A6/A-W2)
# ──────────────────────────────────────────────

def discretize_weibull(
    weibull_fit: WeibullFitResult,
    h_max: int = 150,
) -> DiscreteRULResult:
    """将连续 Weibull 分布离散化为 P(RUL = h),h = 0..h_max(用户要求 4)。

    使用生存函数 S(t) = exp(-(t/λ)^k) 计算区间概率(用户要求 3,假设 A6):
    - P(RUL = h) = S(h - 0.5) - S(h + 0.5),h = 1..h_max-1
    - P(RUL = 0) = 1 - S(0.5)
    - P(RUL = h_max) = S(h_max - 0.5)(尾部吸收)

    然后在 [0, h_max] 上截断归一化,保证概率和为 1。
    输出前强制校验归一化(用户要求 5,假设 A-W2),不通过则报错。

    Args:
        weibull_fit: Weibull MLE 拟合结果
        h_max: 最大离散 RUL(默认 150)

    Returns:
        DiscreteRULResult(probs, cdf, h_max, is_normalized)

    Raises:
        RULFitError: E3001(归一化校验失败)
    """
    lam = weibull_fit.lam
    k = weibull_fit.k

    # 构造 h = 0, 1, ..., h_max
    h_values = np.arange(h_max + 1)  # (h_max+1,)

    # 计算各区间边界的生存函数值
    # h=0 的下边界为 0(S(0)=1),h=h_max 的上边界为 +∞(S(+∞)=0)
    lower_edges = np.maximum(h_values - 0.5, 0.0)  # (h_max+1,) 下边界
    upper_edges = h_values + 0.5                     # (h_max+1,) 上边界

    s_lower = weibull_survival(lower_edges, lam, k)  # S(h-0.5)
    s_upper = weibull_survival(upper_edges, lam, k)  # S(h+0.5)

    # P(RUL = h) = S(h-0.5) - S(h+0.5)
    # h=h_max 时 S(h_max+0.5) ≈ 0(尾部),但为精确起见用 S(h_max-0.5) 作为 P(h_max)
    probs = s_lower - s_upper
    # h = h_max:尾部概率 = S(h_max - 0.5) - S(+∞) = S(h_max - 0.5) - 0
    probs[h_max] = s_lower[h_max]  # S(h_max - 0.5)

    # 截断归一化:在 [0, h_max] 上归一,保证概率和为 1
    total = float(np.sum(probs))
    if total <= 0:
        raise RULFitError(
            "E3001",
            f"离散化概率总和为 {total}(非正),无法归一化",
            f"可能原因:λ={lam} 或 k={k} 极端取值导致数值下溢",
        )
    probs = probs / total

    # 输出前归一化校验(用户要求 5,假设 A-W2)
    prob_sum = float(np.sum(probs))
    if abs(prob_sum - 1.0) > _NORM_TOLERANCE:
        raise RULFitError(
            "E3001",
            f"离散化概率归一化校验失败:ΣP(h) = {prob_sum},期望 1.0(容差 {_NORM_TOLERANCE})",
            "概率未归一化,拒绝输出",
        )

    # 累计概率(CDF)
    cdf = np.cumsum(probs)

    # CDF 末项校验(应为 1.0)
    if abs(float(cdf[-1]) - 1.0) > _NORM_TOLERANCE:
        raise RULFitError(
            "E3001",
            f"CDF 末项校验失败:CDF({h_max}) = {cdf[-1]},期望 1.0",
        )

    return DiscreteRULResult(
        probs=probs.tolist(),
        cdf=cdf.tolist(),
        h_max=h_max,
        is_normalized=True,
    )


# ──────────────────────────────────────────────
# 便捷入口:estimate_rul_distribution
# ──────────────────────────────────────────────

def estimate_rul_distribution(
    query_feature: np.ndarray,
    reference_features: np.ndarray,
    reference_ruls: np.ndarray,
    k: int = 50,
    h_max: int = 150,
    random_seed: int | None = None,
) -> tuple[WeibullFitResult, DiscreteRULResult]:
    """完整 RUL 估计流程:kNN 检索 → Weibull MLE 拟合 → 离散化。

    Args:
        query_feature: 查询特征向量 (420,)
        reference_features: 参考集特征矩阵 (n, 420)
        reference_ruls: 参考集真实 RUL 值 (n,)
        k: kNN 近邻数(默认 50)
        h_max: 最大离散 RUL(默认 150)
        random_seed: 随机种子(可选)

    Returns:
        (WeibullFitResult, DiscreteRULResult)
    """
    # 1. kNN 检索(假设 A3/A4)
    rul_samples = knn_retrieve(query_feature, reference_features, reference_ruls, k)

    # 2. Weibull MLE 拟合(假设 A5)
    weibull_fit = fit_weibull(rul_samples, random_seed=random_seed)

    # 3. 离散化(假设 A6/A-W2)
    discrete_rul = discretize_weibull(weibull_fit, h_max=h_max)

    return weibull_fit, discrete_rul