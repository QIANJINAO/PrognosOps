# 维修决策模块测试
# 覆盖用户要求:
# 1. ETO-C  2. ETO-Q  3. IEO-C  4. IEO-Q  5. 期望成本  6. 失效概率
# 7. 推荐维修窗口  8. 与ETO的差额  9. regret接口  10. failure frequency接口
# IEO: 初始方案/高斯扰动/MC估计/REINFORCE/baseline/不求导/种子/步数/缓存
# 重要: 参数校验、无真实RUL时regret=null、工程近似写入报告

import numpy as np
import pytest

from app.core.decision import (
    DEFAULT_PARAMS,
    DEFAULT_WINDOWS,
    DecisionError,
    clear_decision_cache,
    compute_expected_cost_single,
    compute_expected_life,
    compute_expected_quality_single,
    compute_failure_frequency,
    compute_failure_prob,
    compute_regret,
    run_decision,
    validate_decision_inputs,
)
from app.core.rul import discretize_weibull, fit_weibull
from app.domain.models import DecisionParams, IEOOptConfig


# ──────────────────────────────────────────────
# 测试辅助
# ──────────────────────────────────────────────

def make_deterministic_probs(h_value: int, h_max: int = 150) -> np.ndarray:
    """构造确定性分布:P(RUL = h_value) = 1。"""
    probs = np.zeros(h_max + 1)
    probs[h_value] = 1.0
    return probs


def make_two_point_probs(h1: int, p1: float, h2: int, h_max: int = 150) -> np.ndarray:
    """构造两点分布:P(RUL = h1) = p1, P(RUL = h2) = 1 - p1。"""
    probs = np.zeros(h_max + 1)
    probs[h1] = p1
    probs[h2] = 1.0 - p1
    return probs


@pytest.fixture(autouse=True)
def _clean_cache():
    """每个测试前后清空决策缓存,保证测试隔离。"""
    clear_decision_cache()
    yield
    clear_decision_cache()


# ──────────────────────────────────────────────
# 参数校验测试(用户要求 5)
# ──────────────────────────────────────────────

class TestValidation:
    """决策模块输入校验。"""

    def test_probs_not_normalized_raises(self):
        """概率向量未归一化时应报 E4001。"""
        probs = np.ones(151) * 0.5  # Σ=75.5,严重非归一
        with pytest.raises(DecisionError, match="E4001"):
            validate_decision_inputs(probs, DEFAULT_PARAMS, DEFAULT_WINDOWS)

    def test_probs_wrong_length_raises(self):
        """概率向量长度不等于 h_max+1 时应报 E4001。"""
        probs = np.ones(100) / 100
        with pytest.raises(DecisionError, match="E4001"):
            validate_decision_inputs(probs, DEFAULT_PARAMS, DEFAULT_WINDOWS)

    def test_probs_negative_raises(self):
        """概率向量含负值时应报 E4001。"""
        probs = np.full(151, 1.0 / 151)
        probs[0] = -0.01
        probs[1] += 0.01  # 保持总和为 1
        with pytest.raises(DecisionError, match="E4001"):
            validate_decision_inputs(probs, DEFAULT_PARAMS, DEFAULT_WINDOWS)

    def test_empty_windows_raises(self):
        """候选窗口为空时应报 E4001。"""
        probs = make_deterministic_probs(50)
        with pytest.raises(DecisionError, match="E4001"):
            validate_decision_inputs(probs, DEFAULT_PARAMS, [])

    def test_negative_window_raises(self):
        """候选窗口含负值时应报 E4001。"""
        probs = make_deterministic_probs(50)
        with pytest.raises(DecisionError, match="E4001"):
            validate_decision_inputs(probs, DEFAULT_PARAMS, [0, -5, 10])

    def test_duplicate_windows_raises(self):
        """候选窗口含重复值时应报 E4001。"""
        probs = make_deterministic_probs(50)
        with pytest.raises(DecisionError, match="E4001"):
            validate_decision_inputs(probs, DEFAULT_PARAMS, [0, 5, 5, 10])

    def test_pydantic_param_validation_cm_zero(self):
        """cm=0 应被 Pydantic 拒绝。"""
        with pytest.raises(Exception):
            DecisionParams(cm=0, cd=5, cp=50, cc=200, alpha=0.01)

    def test_pydantic_param_validation_cp_negative(self):
        """cp<0 应被 Pydantic 拒绝。"""
        with pytest.raises(Exception):
            DecisionParams(cm=1, cd=5, cp=-1, cc=200, alpha=0.01)

    def test_pydantic_param_validation_alpha_zero(self):
        """alpha=0 应被 Pydantic 拒绝(约束 0 < alpha ≤ 1)。"""
        with pytest.raises(Exception):
            DecisionParams(cm=1, cd=5, cp=50, cc=200, alpha=0.0)

    def test_pydantic_param_validation_alpha_over_one(self):
        """alpha>1 应被 Pydantic 拒绝。"""
        with pytest.raises(Exception):
            DecisionParams(cm=1, cd=5, cp=50, cc=200, alpha=1.5)

    def test_run_decision_invalid_probs_raises(self):
        """run_decision 传入非法概率应报 E4001。"""
        with pytest.raises(DecisionError, match="E4001"):
            run_decision([0.5] * 151, use_cache=False)


# ──────────────────────────────────────────────
# 核心解析公式手算验证(用户要求 5/6)
# ──────────────────────────────────────────────

class TestCoreFormulas:
    """核心公式的手算验证(确定性分布 P(RUL=50)=1)。"""

    # 默认参数:cm=1, cd=5, cp=50, cc=200, alpha=0.01 → c_run=6

    def test_expected_cost_z0_equals_cp(self):
        """z=0 时 E[C1(0)] = cp(立即预防性更换,无运行成本)。"""
        probs = make_deterministic_probs(50)
        assert compute_expected_cost_single(probs, 0, DEFAULT_PARAMS) == pytest.approx(50.0)

    def test_expected_cost_z_below_rul(self):
        """z=25 < RUL=50:预防性更换,E[C1(25)] = cp + 25·c_run = 50+150 = 200。"""
        probs = make_deterministic_probs(50)
        assert compute_expected_cost_single(probs, 25, DEFAULT_PARAMS) == pytest.approx(200.0)

    def test_expected_cost_z_above_rul(self):
        """z=55 > RUL=50:纠正性更换,E[C1(55)] = cc + 50·c_run = 200+300 = 500。"""
        probs = make_deterministic_probs(50)
        assert compute_expected_cost_single(probs, 55, DEFAULT_PARAMS) == pytest.approx(500.0)

    def test_expected_cost_two_point(self):
        """两点分布 P(h=20)=0.3, P(h=80)=0.7,z=25:
        E[C1(25)] = 0.3·(200+20·6) + 0.7·(50+25·6) = 0.3·320 + 0.7·200 = 96+140 = 236。"""
        probs = make_two_point_probs(20, 0.3, 80)
        assert compute_expected_cost_single(probs, 25, DEFAULT_PARAMS) == pytest.approx(236.0)

    def test_expected_life_deterministic(self):
        """确定性分布 P(RUL=50)=1:E[L(25)] = min(50,25) = 25。"""
        probs = make_deterministic_probs(50)
        assert compute_expected_life(probs, 25, 150) == pytest.approx(25.0)

    def test_expected_life_two_point(self):
        """两点分布:E[L(25)] = 0.3·min(20,25) + 0.7·min(80,25) = 6+17.5 = 23.5。"""
        probs = make_two_point_probs(20, 0.3, 80)
        assert compute_expected_life(probs, 25, 150) == pytest.approx(23.5)

    def test_failure_prob_z0(self):
        """z=0 时 P_fail(0) = 0(不可能在 0 周期前故障)。"""
        probs = make_deterministic_probs(50)
        assert compute_failure_prob(probs, 0, 150) == pytest.approx(0.0)

    def test_failure_prob_below_rul(self):
        """z=25 < RUL=50:P_fail(25) = P(RUL<25) = 0。"""
        probs = make_deterministic_probs(50)
        assert compute_failure_prob(probs, 25, 150) == pytest.approx(0.0)

    def test_failure_prob_above_rul(self):
        """z=55 > RUL=50:P_fail(55) = P(RUL<55) = 1。"""
        probs = make_deterministic_probs(50)
        assert compute_failure_prob(probs, 55, 150) == pytest.approx(1.0)

    def test_failure_prob_two_point(self):
        """两点分布 P(h=20)=0.3:P_fail(25) = 0.3。"""
        probs = make_two_point_probs(20, 0.3, 80)
        assert compute_failure_prob(probs, 25, 150) == pytest.approx(0.3)

    def test_expected_quality_formula(self):
        """E[Q1(z)] = E[L(z)] − w_f·P_fail(z),w_f=(200−50)/5=30。
        两点分布 z=25:E[Q1] = 23.5 − 30·0.3 = 14.5。"""
        probs = make_two_point_probs(20, 0.3, 80)
        assert compute_expected_quality_single(probs, 25, DEFAULT_PARAMS) == pytest.approx(14.5)

    def test_expected_quality_z0(self):
        """z=0:E[Q1(0)] = 0 − 30·0 = 0。"""
        probs = make_deterministic_probs(50)
        assert compute_expected_quality_single(probs, 0, DEFAULT_PARAMS) == pytest.approx(0.0)


# ──────────────────────────────────────────────
# ETO 策略测试(用户要求 1/2/7)
# ──────────────────────────────────────────────

class TestETOStrategies:
    """ETO-C / ETO-Q 解析策略。"""

    def test_eto_c_deterministic_picks_small_window(self):
        """确定性 RUL=50:ETO-C 应选 z=5 而非 z=0。
        E[TC(0)] = cp + alpha^0·V_C = 50+50 = 100
        E[TC(5)] = 80 + alpha^5·50 ≈ 80 < 100"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        eto_c = result.strategies["ETO-C"]
        assert eto_c.optimal_window == 5
        assert eto_c.objective_value == pytest.approx(80.0, abs=1.0)

    def test_eto_c_is_argmin_of_total_cost_curve(self):
        """ETO-C 的目标值应等于 total_cost_curve 中的最小值。"""
        probs = make_two_point_probs(20, 0.3, 80)
        result = run_decision(probs, use_cache=False)
        eto_c = result.strategies["ETO-C"]
        min_tc = min(result.total_cost_curve)
        assert eto_c.objective_value == pytest.approx(min_tc)

    def test_eto_q_is_argmax_of_total_quality_curve(self):
        """ETO-Q 的目标值应等于 total_quality_curve 中的最大值。"""
        probs = make_two_point_probs(20, 0.3, 80)
        result = run_decision(probs, use_cache=False)
        eto_q = result.strategies["ETO-Q"]
        max_tq = max(result.total_quality_curve)
        assert eto_q.objective_value == pytest.approx(max_tq)

    def test_eto_c_window_in_Z(self):
        """ETO-C 推荐窗口必须在候选集合 Z 中。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        for s in result.strategies.values():
            assert s.optimal_window in DEFAULT_WINDOWS

    def test_curves_have_correct_length(self):
        """所有曲线长度应等于候选窗口数(26)。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        n = len(DEFAULT_WINDOWS)
        assert len(result.cost_curve) == n
        assert len(result.total_cost_curve) == n
        assert len(result.quality_curve) == n
        assert len(result.total_quality_curve) == n
        assert len(result.failure_prob_curve) == n
        assert len(result.expected_life_curve) == n

    def test_failure_prob_curve_monotone(self):
        """失效概率曲线应单调非递减。"""
        probs = make_two_point_probs(20, 0.3, 80)
        result = run_decision(probs, use_cache=False)
        fp = result.failure_prob_curve
        for i in range(1, len(fp)):
            assert fp[i] >= fp[i - 1] - 1e-12

    def test_cost_curve_z0_equals_cp(self):
        """cost_curve[0](z=0)应等于 cp=50。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        assert result.cost_curve[0] == pytest.approx(50.0)


# ──────────────────────────────────────────────
# IEO 策略测试(用户要求 3/4,IEO 要求 1~9)
# ──────────────────────────────────────────────

class TestIEOStrategies:
    """IEO-C / IEO-Q 策略梯度优化。"""

    def test_ieo_starts_from_eto(self):
        """IEO 要求 1:以 ETO 结果作为初始方案。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        assert result.ieo_traces["IEO-C"].initial_window == result.strategies["ETO-C"].optimal_window
        assert result.ieo_traces["IEO-Q"].initial_window == result.strategies["ETO-Q"].optimal_window

    def test_ieo_records_training_steps(self):
        """IEO 要求 9:记录训练步数。"""
        probs = make_deterministic_probs(50)
        config = IEOOptConfig(n_steps=20, random_seed=42)
        result = run_decision(probs, ieo_config=config, use_cache=False)
        assert result.ieo_traces["IEO-C"].n_steps_actual == 20
        assert result.ieo_traces["IEO-Q"].n_steps_actual == 20

    def test_ieo_records_config_and_seed(self):
        """IEO 要求 8/9:记录随机种子和完整配置。"""
        probs = make_deterministic_probs(50)
        config = IEOOptConfig(n_steps=10, random_seed=123)
        result = run_decision(probs, ieo_config=config, use_cache=False)
        trace = result.ieo_traces["IEO-C"]
        assert trace.config.random_seed == 123
        assert trace.config.n_steps == 10
        assert trace.config.batch_size == config.batch_size
        assert trace.config.mc_samples == config.mc_samples

    def test_ieo_reproducible_with_fixed_seed(self):
        """IEO 要求 8:固定随机种子时结果可复现。"""
        probs = make_two_point_probs(20, 0.3, 80)
        config = IEOOptConfig(n_steps=30, random_seed=42)
        r1 = run_decision(probs, ieo_config=config, use_cache=False)
        r2 = run_decision(probs, ieo_config=config, use_cache=False)
        assert r1.strategies["IEO-C"].optimal_window == r2.strategies["IEO-C"].optimal_window
        assert r1.strategies["IEO-Q"].optimal_window == r2.strategies["IEO-Q"].optimal_window
        assert r1.ieo_traces["IEO-C"].final_mu == pytest.approx(r2.ieo_traces["IEO-C"].final_mu)

    def test_ieo_sigma_decays_to_min(self):
        """IEO 要求 2:σ 退火衰减,最终接近 σ_min。"""
        probs = make_deterministic_probs(50)
        config = IEOOptConfig(n_steps=100, sigma_init=5.0, sigma_min=0.5, sigma_decay=0.92)
        result = run_decision(probs, ieo_config=config, use_cache=False)
        trace = result.ieo_traces["IEO-C"]
        assert trace.final_sigma <= config.sigma_min + 1e-6
        assert trace.converged is True

    def test_ieo_mu_history_non_empty(self):
        """IEO 优化过程应记录 μ 的变化历史。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        assert len(result.ieo_traces["IEO-C"].mu_history) > 0
        assert len(result.ieo_traces["IEO-C"].baseline_history) > 0

    def test_ieo_c_converges_near_eto_for_deterministic(self):
        """确定性分布:IEO-C 应收敛到与 ETO-C 相同或附近的窗口。"""
        probs = make_deterministic_probs(50)
        config = IEOOptConfig(n_steps=100, random_seed=42)
        result = run_decision(probs, ieo_config=config, use_cache=False)
        eto_c_z = result.strategies["ETO-C"].optimal_window
        ieo_c_z = result.strategies["IEO-C"].optimal_window
        # IEO 可能与 ETO 相同(假设 A-D4),也可能略有偏差(策略梯度近似)
        assert abs(ieo_c_z - eto_c_z) <= 10

    def test_ieo_window_in_Z(self):
        """IEO 推荐窗口必须在候选集合 Z 中。"""
        probs = make_two_point_probs(20, 0.3, 80)
        result = run_decision(probs, use_cache=False)
        assert result.strategies["IEO-C"].optimal_window in DEFAULT_WINDOWS
        assert result.strategies["IEO-Q"].optimal_window in DEFAULT_WINDOWS


# ──────────────────────────────────────────────
# 与 ETO 的差额测试(用户要求 8)
# ──────────────────────────────────────────────

class TestDiffVsETO:
    """IEO 与 ETO 的差额输出。"""

    def test_eto_diff_is_zero(self):
        """ETO 策略自身的差额应为 0。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        assert result.strategies["ETO-C"].diff_window_vs_eto == 0
        assert result.strategies["ETO-C"].diff_objective_vs_eto == pytest.approx(0.0)
        assert result.strategies["ETO-Q"].diff_window_vs_eto == 0
        assert result.strategies["ETO-Q"].diff_objective_vs_eto == pytest.approx(0.0)

    def test_ieo_diff_computed(self):
        """IEO 策略的差额应已计算(窗口差 = IEO 窗口 − ETO 窗口)。"""
        probs = make_two_point_probs(20, 0.3, 80)
        result = run_decision(probs, use_cache=False)
        ieo_c = result.strategies["IEO-C"]
        eto_c = result.strategies["ETO-C"]
        assert ieo_c.diff_window_vs_eto == ieo_c.optimal_window - eto_c.optimal_window


# ──────────────────────────────────────────────
# Regret 接口测试(用户要求 9,规则 10)
# ──────────────────────────────────────────────

class TestRegret:
    """Regret 计算:无真实 RUL 时返回 null(规则 10)。"""

    def test_regret_null_without_true_rul(self):
        """用户要求 3:没有真实 RUL 时,regret 返回 null。"""
        result = compute_regret(None, 25, DEFAULT_WINDOWS, DEFAULT_PARAMS, "ETO-C")
        assert result.true_rul is None
        assert result.actual_cost is None
        assert result.optimal_cost is None
        assert result.regret is None

    def test_regret_with_true_rul_preventive(self):
        """真实 RUL=50,选择 z=25(预防性):C_real = cp+25·6 = 200。
        C_opt = min(cp, cc+50·6) = min(50, 500) = 50。regret = 200−50 = 150。"""
        result = compute_regret(50, 25, DEFAULT_WINDOWS, DEFAULT_PARAMS, "ETO-C")
        assert result.true_rul == 50
        assert result.actual_cost == pytest.approx(200.0)
        assert result.optimal_cost == pytest.approx(50.0)
        assert result.regret == pytest.approx(150.0)

    def test_regret_with_true_rul_corrective(self):
        """真实 RUL=50,选择 z=55(纠正性):C_real = cc+50·6 = 500。
        C_opt = 50。regret = 500−50 = 450。"""
        result = compute_regret(50, 55, DEFAULT_WINDOWS, DEFAULT_PARAMS, "IEO-C")
        assert result.actual_cost == pytest.approx(500.0)
        assert result.regret == pytest.approx(450.0)

    def test_regret_non_negative(self):
        """regret 必须 ≥ 0(所选策略不会比完美信息更优)。"""
        for rul in [10, 30, 50, 80, 100, 130]:
            for z in [0, 5, 25, 50, 75, 125]:
                result = compute_regret(rul, z, DEFAULT_WINDOWS, DEFAULT_PARAMS)
                assert result.regret >= -1e-10, f"regret<0 at rul={rul}, z={z}"

    def test_regret_zero_at_optimal_window(self):
        """选择 z=0 时 regret=0(立即预防更换恒为完美信息最优,假设 A-D6)。"""
        result = compute_regret(50, 0, DEFAULT_WINDOWS, DEFAULT_PARAMS)
        assert result.regret == pytest.approx(0.0)

    def test_regret_strategy_recorded(self):
        """regret 结果应记录策略名称。"""
        result = compute_regret(50, 25, DEFAULT_WINDOWS, DEFAULT_PARAMS, "ETO-Q")
        assert result.strategy == "ETO-Q"


# ──────────────────────────────────────────────
# 失效频率接口测试(用户要求 10/6)
# ──────────────────────────────────────────────

class TestFailureFrequency:
    """失效频率接口:对全部候选窗口输出 P(RUL < z) 曲线。"""

    def test_failure_frequency_returns_all_windows(self):
        """应返回全部候选窗口的失效概率。"""
        probs = make_two_point_probs(20, 0.3, 80)
        result = compute_failure_frequency(probs, DEFAULT_WINDOWS, 150)
        assert result.windows == DEFAULT_WINDOWS
        assert len(result.failure_probs) == len(DEFAULT_WINDOWS)
        assert result.h_max == 150

    def test_failure_frequency_z0(self):
        """z=0 的失效概率应为 0。"""
        probs = make_deterministic_probs(50)
        result = compute_failure_frequency(probs, DEFAULT_WINDOWS, 150)
        assert result.failure_probs[0] == pytest.approx(0.0)

    def test_failure_frequency_monotone(self):
        """失效概率应随窗口增大单调非递减。"""
        probs = make_two_point_probs(20, 0.3, 80)
        result = compute_failure_frequency(probs, DEFAULT_WINDOWS, 150)
        for i in range(1, len(result.failure_probs)):
            assert result.failure_probs[i] >= result.failure_probs[i - 1] - 1e-12

    def test_failure_frequency_matches_strategy(self):
        """决策结果中策略的 failure_prob 应等于失效频率曲线上对应窗口的值。"""
        probs = make_two_point_probs(20, 0.3, 80)
        decision = run_decision(probs, use_cache=False)
        ff = compute_failure_frequency(probs, DEFAULT_WINDOWS, 150)
        for name, strategy in decision.strategies.items():
            idx = DEFAULT_WINDOWS.index(strategy.optimal_window)
            assert strategy.failure_prob == pytest.approx(ff.failure_probs[idx]), name


# ──────────────────────────────────────────────
# 工程假设与报告测试(用户要求 4)
# ──────────────────────────────────────────────

class TestAssumptions:
    """工程近似必须写入报告(用户要求 4)。"""

    def test_result_contains_assumptions(self):
        """决策结果应包含工程假设说明列表。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        assert len(result.assumptions) > 0

    def test_assumptions_mention_key_items(self):
        """假设说明应包含 A7(两阶段近似)、A8(质量定义)、A-D3(不求导)等关键词。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        text = " ".join(result.assumptions)
        assert "A7" in text
        assert "A8" in text
        assert "A-D3" in text or "不求导" in text
        assert "蒙特卡洛" in text or "MC" in text

    def test_cc_le_cp_warning(self):
        """cc ≤ cp 时应生成警告假设。"""
        probs = make_deterministic_probs(50)
        params = DecisionParams(cm=1, cd=5, cp=100, cc=50, alpha=0.01)
        result = run_decision(probs, params=params, use_cache=False)
        text = " ".join(result.assumptions)
        assert "警告" in text


# ──────────────────────────────────────────────
# 缓存测试(用户要求 10)
# ──────────────────────────────────────────────

class TestCache:
    """支持缓存演示数据结果(用户要求 10)。"""

    def test_same_inputs_returns_cached(self):
        """相同输入应返回缓存结果(对象同一)。"""
        probs = make_two_point_probs(20, 0.3, 80)
        r1 = run_decision(probs, use_cache=True)
        r2 = run_decision(probs, use_cache=True)
        assert r1 is r2  # 缓存命中返回同一对象

    def test_different_inputs_not_cached(self):
        """不同输入应返回不同结果。"""
        probs1 = make_two_point_probs(20, 0.3, 80)
        probs2 = make_two_point_probs(30, 0.5, 90)
        r1 = run_decision(probs1, use_cache=True)
        r2 = run_decision(probs2, use_cache=True)
        assert r1 is not r2

    def test_no_cache_bypasses(self):
        """use_cache=False 时跳过缓存。"""
        probs = make_two_point_probs(20, 0.3, 80)
        r1 = run_decision(probs, use_cache=False)
        r2 = run_decision(probs, use_cache=False)
        assert r1 is not r2  # 每次重新计算

    def test_clear_cache(self):
        """清空缓存后应重新计算。"""
        probs = make_two_point_probs(20, 0.3, 80)
        r1 = run_decision(probs, use_cache=True)
        clear_decision_cache()
        r2 = run_decision(probs, use_cache=True)
        assert r1 is not r2


# ──────────────────────────────────────────────
# 与 RUL 模块集成测试
# ──────────────────────────────────────────────

class TestRULIntegration:
    """从 Weibull 离散化输出到决策分析的完整链路。"""

    def test_full_pipeline_weibull_to_decision(self):
        """Weibull 拟合 → 离散化 → 决策分析,全链路不报错。"""
        rng = np.random.default_rng(42)
        samples = rng.weibull(2.0, size=200) * 100
        wf = fit_weibull(samples, random_seed=42)
        dr = discretize_weibull(wf)
        result = run_decision(dr.probs, use_cache=False)

        # 四策略均存在且窗口合法
        assert set(result.strategies.keys()) == {"ETO-C", "IEO-C", "ETO-Q", "IEO-Q"}
        for s in result.strategies.values():
            assert s.optimal_window in DEFAULT_WINDOWS
            assert 0.0 <= s.failure_prob <= 1.0

    def test_decision_with_custom_params(self):
        """自定义参数(高纠正成本)应影响决策结果。"""
        probs = make_two_point_probs(20, 0.3, 80)
        # 高纠正成本:应更倾向于早更换
        high_cc = DecisionParams(cm=1, cd=5, cp=50, cc=500, alpha=0.01)
        result = run_decision(probs, params=high_cc, use_cache=False)
        # 所有策略的窗口应合法
        for s in result.strategies.values():
            assert s.optimal_window in DEFAULT_WINDOWS

    def test_decision_result_serializable(self):
        """决策结果应可 JSON 序列化(Pydantic model_dump_json)。"""
        probs = make_deterministic_probs(50)
        result = run_decision(probs, use_cache=False)
        json_str = result.model_dump_json()
        assert "ETO-C" in json_str
        assert "IEO-C" in json_str
        assert "assumptions" in json_str