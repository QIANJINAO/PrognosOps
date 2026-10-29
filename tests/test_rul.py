# Weibull 概率预测模块测试
# 覆盖用户要求:
# 1. 输出 lambda 和 k  2. 验证 lambda 和 k 必须为正数  3. 使用明确的 survival function
# 4. 生成 H=150 的离散 RUL 概率  5. 输出前检查概率是否归一化
# 6. 支持固定随机种子  7. 添加单元测试

import numpy as np
import pytest
from scipy.stats import weibull_min

from app.core.rul import (
    RULFitError,
    discretize_weibull,
    estimate_rul_distribution,
    fit_weibull,
    knn_retrieve,
    weibull_survival,
)
from app.domain.models import WeibullFitResult


# ──────────────────────────────────────────────
# 测试辅助
# ──────────────────────────────────────────────

def generate_weibull_samples(lam: float, k: float, n: int, seed: int = 42) -> np.ndarray:
    """生成已知参数的 Weibull 随机样本(用于验证拟合恢复)。"""
    rng = np.random.default_rng(seed)
    return rng.weibull(k, size=n) * lam  # numpy 的 weibull(a) = weibull_min(a, scale=1)


# ──────────────────────────────────────────────
# 测试 1:Weibull MLE 拟合恢复已知参数(要求 1)
# ──────────────────────────────────────────────

def test_fit_recovers_known_parameters():
    """用已知参数(λ=100, k=2)生成的样本,MLE 拟合应近似恢复参数(要求 1)。"""
    true_lam, true_k = 100.0, 2.0
    samples = generate_weibull_samples(true_lam, true_k, n=500, seed=42)

    result = fit_weibull(samples, random_seed=42)

    # 拟合参数应接近真实参数(容差 15%,MLE 在有限样本下的正常偏差)
    assert result.lam == pytest.approx(true_lam, rel=0.15)
    assert result.k == pytest.approx(true_k, rel=0.15)
    assert result.n_samples == 500


def test_fit_outputs_lambda_and_k():
    """拟合结果应包含 lambda 和 k 字段(要求 1)。"""
    samples = generate_weibull_samples(80, 2.5, n=200, seed=7)
    result = fit_weibull(samples, random_seed=7)

    assert hasattr(result, "lam")
    assert hasattr(result, "k")
    assert hasattr(result, "log_likelihood")
    assert hasattr(result, "n_samples")


# ──────────────────────────────────────────────
# 测试 2:lambda 和 k 必须为正数(要求 2)
# ──────────────────────────────────────────────

def test_lambda_and_k_are_positive():
    """拟合结果的 lambda 和 k 必须为正数(要求 2)。"""
    samples = generate_weibull_samples(50, 1.5, n=100, seed=11)
    result = fit_weibull(samples, random_seed=11)

    assert result.lam > 0
    assert result.k > 0


def test_nonpositive_samples_raise_error():
    """含非正值(0 或负数)的样本应抛出 E3001 错误(要求 2)。"""
    samples = np.array([10.0, 20.0, 0.0, 30.0])  # 含 0
    with pytest.raises(RULFitError) as exc_info:
        fit_weibull(samples)
    assert exc_info.value.code == "E3001"
    assert "非正值" in exc_info.value.message


def test_insufficient_samples_raise_error():
    """样本数不足 2 个时应抛出 E3001 错误。"""
    with pytest.raises(RULFitError) as exc_info:
        fit_weibull(np.array([50.0]))
    assert exc_info.value.code == "E3001"
    assert "不足" in exc_info.value.message


# ──────────────────────────────────────────────
# 测试 3:生存函数(要求 3)
# ──────────────────────────────────────────────

def test_survival_function_properties():
    """生存函数 S(t) = exp(-(t/λ)^k) 的数学性质(要求 3)。"""
    lam, k = 100.0, 2.0

    # S(0) = exp(0) = 1
    assert weibull_survival(0.0, lam, k) == pytest.approx(1.0)

    # S(+∞) → 0(用大数近似)
    assert weibull_survival(1e6, lam, k) == pytest.approx(0.0, abs=1e-10)

    # S 单调递减
    t_values = np.array([0, 25, 50, 75, 100, 150, 200])
    s_values = weibull_survival(t_values, lam, k)
    assert all(s_values[i] > s_values[i + 1] for i in range(len(s_values) - 1))

    # S(λ) = exp(-1) ≈ 0.3679(Weibull 的特征性质)
    assert weibull_survival(lam, lam, k) == pytest.approx(np.exp(-1.0))


def test_survival_matches_cdf_complement():
    """生存函数应等于 1 - CDF:S(t) = 1 - F(t)。"""
    lam, k = 80.0, 2.5
    t_values = np.array([10, 30, 50, 70, 90, 110])

    s_values = weibull_survival(t_values, lam, k)
    f_values = weibull_min.cdf(t_values, k, loc=0, scale=lam)

    np.testing.assert_allclose(s_values, 1.0 - f_values, rtol=1e-10)


# ──────────────────────────────────────────────
# 测试 4:离散 RUL 概率 H=150(要求 4)
# ──────────────────────────────────────────────

def test_discretize_produces_151_probs():
    """离散化应生成 151 个概率值(h=0..150)(要求 4)。"""
    fit = WeibullFitResult(lam=100.0, k=2.0, log_likelihood=-500.0, n_samples=50)
    result = discretize_weibull(fit)

    assert result.h_max == 150
    assert len(result.probs) == 151
    assert len(result.cdf) == 151


def test_discretize_prob_sum_is_one():
    """离散概率之和必须为 1(要求 5:输出前检查归一化)。"""
    fit = WeibullFitResult(lam=80.0, k=2.5, log_likelihood=-400.0, n_samples=50)
    result = discretize_weibull(fit)

    prob_sum = sum(result.probs)
    assert abs(prob_sum - 1.0) < 1e-6
    assert result.is_normalized is True


def test_discretize_cdf_monotonic_and_ends_at_one():
    """CDF 应单调递增且末项为 1(要求 4/5)。"""
    fit = WeibullFitResult(lam=120.0, k=1.8, log_likelihood=-600.0, n_samples=50)
    result = discretize_weibull(fit)

    cdf = result.cdf
    # 单调递增(允许相等)
    assert all(cdf[i] <= cdf[i + 1] + 1e-12 for i in range(len(cdf) - 1))
    # 末项为 1
    assert cdf[-1] == pytest.approx(1.0, abs=1e-6)
    # 首项 = P(0) ≥ 0
    assert cdf[0] >= 0


def test_discretize_probs_nonnegative():
    """所有离散概率值必须非负。"""
    fit = WeibullFitResult(lam=90.0, k=2.2, log_likelihood=-450.0, n_samples=50)
    result = discretize_weibull(fit)

    assert all(p >= 0 for p in result.probs)


def test_discretize_p0_matches_survival():
    """P(RUL=0) 应等于 1 - S(0.5)(离散化公式验证,要求 3/4)。"""
    lam, k = 100.0, 2.0
    fit = WeibullFitResult(lam=lam, k=k, log_likelihood=-500.0, n_samples=50)
    result = discretize_weibull(fit)

    # P(0) = 1 - S(0.5),但经过截断归一化后需要除以总和
    raw_p0 = 1.0 - weibull_survival(0.5, lam, k)
    # 手算归一化总和(近似验证)
    h_values = np.arange(151)
    lower = np.maximum(h_values - 0.5, 0.0)
    upper = h_values + 0.5
    raw_probs = weibull_survival(lower, lam, k) - weibull_survival(upper, lam, k)
    raw_probs[150] = weibull_survival(149.5, lam, k)
    total = raw_probs.sum()
    expected_p0 = raw_p0 / total

    assert result.probs[0] == pytest.approx(expected_p0, rel=1e-6)


# ──────────────────────────────────────────────
# 测试 5:归一化校验(要求 5)
# ──────────────────────────────────────────────

def test_is_normalized_flag_is_true():
    """输出结果的 is_normalized 必须为 True(校验通过后才输出,要求 5)。"""
    fit = WeibullFitResult(lam=70.0, k=3.0, log_likelihood=-300.0, n_samples=50)
    result = discretize_weibull(fit)
    assert result.is_normalized is True


# ──────────────────────────────────────────────
# 测试 6:固定随机种子(要求 6)
# ──────────────────────────────────────────────

def test_random_seed_reproducibility():
    """相同种子下拟合结果应完全一致(要求 6:支持固定随机种子)。"""
    samples = generate_weibull_samples(90, 2.0, n=100, seed=99)

    result_1 = fit_weibull(samples, random_seed=42)
    result_2 = fit_weibull(samples, random_seed=42)

    assert result_1.lam == result_2.lam
    assert result_1.k == result_2.k
    assert result_1.log_likelihood == result_2.log_likelihood


# ──────────────────────────────────────────────
# 测试 7:kNN 检索
# ──────────────────────────────────────────────

def test_knn_returns_k_nearest():
    """kNN 检索应返回 k 个最近邻的 RUL 值。"""
    # 构造简单参考集:3 个参考点,查询点与第 1 个最近
    ref_features = np.array([
        [1.0] + [0.0] * 419,   # 距查询点最近
        [100.0] + [0.0] * 419,  # 远
        [50.0] + [0.0] * 419,   # 中等
    ])
    ref_ruls = np.array([10.0, 200.0, 50.0])
    query = np.array([0.0] * 420)

    result = knn_retrieve(query, ref_features, ref_ruls, k=2)
    assert len(result) == 2
    # 最近的两个是索引 0(RUL=10)和索引 2(RUL=50)
    assert 10.0 in result
    assert 50.0 in result


def test_knn_empty_reference_raises_error():
    """空参考集应抛出 E3001 错误。"""
    with pytest.raises(RULFitError) as exc_info:
        knn_retrieve(
            np.zeros(420),
            np.empty((0, 420)),
            np.empty(0),
            k=5,
        )
    assert exc_info.value.code == "E3001"


def test_knn_invalid_k_raises_error():
    """k 超出参考集大小应抛出 E3001 错误。"""
    ref_features = np.zeros((3, 420))
    ref_ruls = np.array([10.0, 20.0, 30.0])

    with pytest.raises(RULFitError):
        knn_retrieve(np.zeros(420), ref_features, ref_ruls, k=10)


# ──────────────────────────────────────────────
# 测试 8:完整流程 estimate_rul_distribution
# ──────────────────────────────────────────────

def test_estimate_rul_distribution_full_pipeline():
    """完整流程:kNN → Weibull 拟合 → 离散化,输出应满足全部约束。"""
    # 构造合成参考集:60 个样本,420 维特征,RUL 来自 Weibull(λ=80, k=2)
    rng = np.random.default_rng(42)
    ref_features = rng.normal(0, 1, size=(60, 420))
    ref_ruls = generate_weibull_samples(80.0, 2.0, n=60, seed=42)
    query = rng.normal(0, 1, size=420)

    weibull_fit, discrete_rul = estimate_rul_distribution(
        query, ref_features, ref_ruls, k=50, h_max=150, random_seed=42,
    )

    # Weibull 拟合结果(要求 1/2)
    assert weibull_fit.lam > 0
    assert weibull_fit.k > 0
    assert weibull_fit.n_samples == 50

    # 离散概率(要求 4/5)
    assert len(discrete_rul.probs) == 151
    assert abs(sum(discrete_rul.probs) - 1.0) < 1e-6
    assert discrete_rul.is_normalized is True
    assert discrete_rul.cdf[-1] == pytest.approx(1.0, abs=1e-6)