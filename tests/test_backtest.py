# 离线回测模块测试
# 覆盖用户要求:
# 1. 支持带真实RUL标签的FD001数据  2. NLL  3. MAE  4. failure frequency
# 5. regret  6. ETO/IEO差异  7. 失效概率校准  8. 固定随机种子
# 9. 多次重复实验  10. 成本敏感性分析  11. 结构化JSON  12. 导出CSV
# 必须区分:离线数据(可计算真实regret) / 在线数据(regret=null)

import numpy as np
import pandas as pd
import pytest

from app.core.backtest import (
    BacktestError,
    export_backtest_csv,
    run_backtest,
)
from app.core.decision import DEFAULT_PARAMS, DEFAULT_WINDOWS
from app.domain.models import BacktestConfig

# 选定传感器索引(1-based,来自 config/sensors.json)
_SELECTED = {2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 17, 20, 21}


def make_synthetic_fd001(n_units=5, min_cycles=80, max_cycles=150, seed=42):
    """生成合成 FD001 数据:多单元、传感器线性退化+噪声、运行至故障。"""
    rng = np.random.default_rng(seed)
    rows = []
    for u in range(1, n_units + 1):
        n_cycles = int(rng.integers(min_cycles, max_cycles))
        base = float(rng.uniform(80, 120))
        slope = float(rng.uniform(0.1, 0.5))
        for t in range(1, n_cycles + 1):
            row = [u, t, 0.0, 0.0, 0.0]
            for s in range(1, 22):
                if s in _SELECTED:
                    row.append(base + slope * t + rng.normal(0, 0.5))
                else:
                    row.append(float(rng.uniform(-0.01, 0.01)))
            rows.append(row)
    cols = ["unit", "cycle", "op_setting1", "op_setting2", "op_setting3"] + [f"s{i}" for i in range(1, 22)]
    return pd.DataFrame(rows, columns=cols)


def make_light_config(**kwargs):
    """构建轻量回测配置(快速测试用)。"""
    defaults = dict(
        data_mode="offline", step=20, min_cycle=30, k_nn=5,
        n_repeats=1, random_seed=42, include_points=True,
    )
    defaults.update(kwargs)
    return BacktestConfig(**defaults)


@pytest.fixture()
def syn_df():
    """合成 FD001 数据(5 单元)。"""
    return make_synthetic_fd001(n_units=5, seed=42)


@pytest.fixture()
def bt_result(syn_df):
    """基础回测结果(离线模式)。"""
    return run_backtest(syn_df, make_light_config())


# ──────────────────────────────────────────────
# 核心指标测试(用户要求 1/2/3/5)
# ──────────────────────────────────────────────

class TestCoreMetrics:
    """NLL / MAE / regret / 真实 RUL。"""

    def test_offline_has_true_rul(self, bt_result):
        """离线模式:has_true_rul=True,可计算真实 regret(用户要求 1)。"""
        assert bt_result.has_true_rul is True
        assert bt_result.n_points > 0

    def test_nll_computed(self, bt_result):
        """NLL 应为有限负对数似然值(用户要求 2)。"""
        assert bt_result.nll_mean is not None
        assert np.isfinite(bt_result.nll_mean)

    def test_mae_computed(self, bt_result):
        """MAE 应为非负有限值(用户要求 3)。"""
        assert bt_result.mae_mean is not None
        assert bt_result.mae_mean >= 0
        assert np.isfinite(bt_result.mae_mean)

    def test_regret_non_negative(self, bt_result):
        """离线模式:各策略 regret 均值 ≥ 0(用户要求 5)。"""
        for sn, summary in bt_result.strategies.items():
            if summary.regret_mean is not None:
                assert summary.regret_mean >= -1e-10, f"{sn} regret_mean < 0"

    def test_regret_list_matches_points(self, bt_result):
        """regret_list 长度应等于时点数。"""
        for sn, summary in bt_result.strategies.items():
            assert len(summary.regret_list) == bt_result.n_points

    def test_true_rul_positive(self, bt_result):
        """离线模式:各时点 true_rul > 0(决策时点早于故障)。"""
        for p in bt_result.points:
            assert p.true_rul is not None
            assert p.true_rul > 0

    def test_predicted_rul_positive(self, bt_result):
        """预测 RUL 均值(λ·Γ(1+1/k))应为正。"""
        for p in bt_result.points:
            assert p.predicted_rul_mean > 0

    def test_lam_k_positive(self, bt_result):
        """各时点 Weibull 参数 λ/k 应为正。"""
        for p in bt_result.points:
            assert p.lam > 0
            assert p.k > 0


# ──────────────────────────────────────────────
# Failure Frequency 与校准测试(用户要求 4/7)
# ──────────────────────────────────────────────

class TestFrequencyAndCalibration:
    """failure frequency / 失效概率校准。"""

    def test_failure_frequency_computed(self, bt_result):
        """离线模式:各策略 failure_frequency 应已计算(用户要求 4)。"""
        for sn, summary in bt_result.strategies.items():
            assert summary.failure_frequency is not None
            assert 0.0 <= summary.failure_frequency <= 1.0

    def test_mean_failure_prob_in_range(self, bt_result):
        """平均预测失效概率应在 [0, 1] 范围内。"""
        for sn, summary in bt_result.strategies.items():
            assert 0.0 <= summary.mean_failure_prob <= 1.0

    def test_calibration_bins_present(self, bt_result):
        """离线模式:校准分箱应存在(用户要求 7)。"""
        for sn, summary in bt_result.strategies.items():
            assert len(summary.calibration_bins) > 0
            assert summary.ece is not None
            assert summary.ece >= 0

    def test_calibration_bin_sums(self, bt_result):
        """校准分箱的点数总和应等于时点数。"""
        for sn, summary in bt_result.strategies.items():
            total = sum(b.n_points for b in summary.calibration_bins)
            assert total == bt_result.n_points

    def test_calibration_observed_freq_range(self, bt_result):
        """校准分箱的 observed_freq 应在 [0, 1] 范围内。"""
        for sn, summary in bt_result.strategies.items():
            for b in summary.calibration_bins:
                if b.n_points > 0:
                    assert 0.0 <= b.observed_freq <= 1.0


# ──────────────────────────────────────────────
# ETO/IEO 差异测试(用户要求 6)
# ──────────────────────────────────────────────

class TestETOIEODiff:
    """ETO 与 IEO 的差异汇总。"""

    def test_diff_keys_present(self, bt_result):
        """eto_ieo_diff 应包含 C 和 Q 两个目标(用户要求 6)。"""
        assert "C" in bt_result.eto_ieo_diff
        assert "Q" in bt_result.eto_ieo_diff

    def test_diff_counts_sum(self, bt_result):
        """IEO 优于/劣于/相同 ETO 的计数之和应等于时点数。"""
        for target, diff in bt_result.eto_ieo_diff.items():
            total = diff.n_ieo_better + diff.n_ieo_worse + diff.n_ieo_same
            assert total == bt_result.n_points, f"target={target}"

    def test_window_diff_stats(self, bt_result):
        """窗口差额统计应已计算。"""
        for target, diff in bt_result.eto_ieo_diff.items():
            assert np.isfinite(diff.window_diff_mean)


# ──────────────────────────────────────────────
# 随机种子/重复实验/敏感性测试(用户要求 8/9/10)
# ──────────────────────────────────────────────

class TestSeedRepeatsSensitivity:
    """固定种子 / 多次重复 / 成本敏感性。"""

    def test_fixed_seed_reproducible(self, syn_df):
        """固定随机种子时回测结果可复现(用户要求 8)。"""
        r1 = run_backtest(syn_df, make_light_config(random_seed=42))
        r2 = run_backtest(syn_df, make_light_config(random_seed=42))
        assert r1.nll_mean == pytest.approx(r2.nll_mean)
        assert r1.mae_mean == pytest.approx(r2.mae_mean)
        for sn in r1.strategies:
            assert r1.strategies[sn].regret_mean == pytest.approx(
                r2.strategies[sn].regret_mean
            )

    def test_multiple_repeats(self, syn_df):
        """多次重复实验应产生多条 repeat_metrics(用户要求 9)。"""
        config = make_light_config(n_repeats=3, random_seed=42)
        result = run_backtest(syn_df, config)
        assert len(result.repeat_metrics) == 3
        for rm in result.repeat_metrics:
            assert rm.nll_mean is not None
        # 各次重复的 repeat_index 应为 0, 1, 2
        assert [rm.repeat_index for rm in result.repeat_metrics] == [0, 1, 2]

    def test_repeat_seeds_increment(self, syn_df):
        """第 i 次重复应使用 seed+i 作为随机种子。"""
        config = make_light_config(n_repeats=3, random_seed=100)
        result = run_backtest(syn_df, config)
        seeds = [rm.random_seed_used for rm in result.repeat_metrics]
        assert seeds == [100, 101, 102]

    def test_sensitivity_analysis(self, syn_df):
        """成本敏感性分析应产生各参数取值的 regret 均值(用户要求 10)。"""
        config = make_light_config(
            sensitivity_param="cc",
            sensitivity_values=[100.0, 200.0, 400.0],
        )
        result = run_backtest(syn_df, config)
        assert len(result.sensitivity) == 3
        for sp in result.sensitivity:
            assert sp.param_name == "cc"
            assert sp.param_value in [100.0, 200.0, 400.0]
            for sn in ["ETO-C", "IEO-C", "ETO-Q", "IEO-Q"]:
                assert sn in sp.regret_mean_by_strategy

    def test_sensitivity_invalid_param_raises(self, syn_df):
        """无效的敏感性参数名应报 E5001。"""
        config = make_light_config(
            sensitivity_param="invalid_param",
            sensitivity_values=[1.0],
        )
        with pytest.raises(BacktestError, match="E5001"):
            run_backtest(syn_df, config)


# ──────────────────────────────────────────────
# 结构化 JSON 与 CSV 导出测试(用户要求 11/12)
# ──────────────────────────────────────────────

class TestOutputFormats:
    """结构化 JSON / CSV 导出。"""

    def test_result_serializable(self, bt_result):
        """回测结果应可 JSON 序列化(用户要求 11)。"""
        json_str = bt_result.model_dump_json()
        assert "strategies" in json_str
        assert "ETO-C" in json_str
        assert "nll_mean" in json_str
        assert "data_sufficiency_note" in json_str

    def test_csv_export(self, bt_result):
        """CSV 导出应包含表头与数据行(用户要求 12)。"""
        csv_str = export_backtest_csv(bt_result)
        lines = csv_str.strip().split("\n")
        assert lines[0].startswith("unit_id,cycle,true_rul")
        assert "strategy" in lines[0]
        assert "regret" in lines[0]
        # 数据行数 = 时点数 × 4 策略
        assert len(lines) == 1 + bt_result.n_points * 4

    def test_csv_export_online_mode(self, syn_df):
        """在线模式 CSV 导出:regret 列应为空。"""
        config = make_light_config(data_mode="online")
        result = run_backtest(syn_df, config)
        csv_str = export_backtest_csv(result)
        lines = csv_str.strip().split("\n")
        # 检查数据行中 regret 列(最后一列)为空
        data_line = lines[1]
        fields = data_line.split(",")
        assert fields[-1] == ""  # regret 为空


# ──────────────────────────────────────────────
# 在线模式测试(regret 恒为 null)
# ──────────────────────────────────────────────

class TestOnlineMode:
    """在线数据:无真实失效时间,regret 返回 null。"""

    def test_online_regret_null(self, syn_df):
        """在线模式:所有策略 regret 均为 null(规则 10)。"""
        config = make_light_config(data_mode="online")
        result = run_backtest(syn_df, config)
        assert result.has_true_rul is False
        for sn, summary in result.strategies.items():
            assert summary.regret_mean is None
            assert summary.regret_median is None
            assert all(r is None for r in summary.regret_list)

    def test_online_nll_mae_null(self, syn_df):
        """在线模式:NLL/MAE 均为 null。"""
        config = make_light_config(data_mode="online")
        result = run_backtest(syn_df, config)
        assert result.nll_mean is None
        assert result.mae_mean is None

    def test_online_calibration_empty(self, syn_df):
        """在线模式:校准分箱为空,ECE 为 null。"""
        config = make_light_config(data_mode="online")
        result = run_backtest(syn_df, config)
        for sn, summary in result.strategies.items():
            assert summary.calibration_bins == []
            assert summary.ece is None

    def test_online_failure_freq_null(self, syn_df):
        """在线模式:failure_frequency 为 null。"""
        config = make_light_config(data_mode="online")
        result = run_backtest(syn_df, config)
        for sn, summary in result.strategies.items():
            assert summary.failure_frequency is None

    def test_online_true_rul_null(self, syn_df):
        """在线模式:各时点 true_rul 为 null。"""
        config = make_light_config(data_mode="online")
        result = run_backtest(syn_df, config)
        for p in result.points:
            assert p.true_rul is None
            assert p.has_true_rul is False

    def test_online_assumption_note(self, syn_df):
        """在线模式:假设说明应包含在线模式说明。"""
        config = make_light_config(data_mode="online")
        result = run_backtest(syn_df, config)
        text = " ".join(result.assumptions)
        assert "在线" in text


# ──────────────────────────────────────────────
# 配置校验与边界测试
# ──────────────────────────────────────────────

class TestValidation:
    """回测配置校验与边界情况。"""

    def test_invalid_data_mode_raises(self, syn_df):
        """无效数据模式应报 E5001。"""
        config = make_light_config(data_mode="invalid")
        with pytest.raises(BacktestError, match="E5001"):
            run_backtest(syn_df, config)

    def test_nonexistent_unit_raises(self, syn_df):
        """指定的回测单元均不存在时应报 E5001。"""
        config = make_light_config(unit_ids=[999, 1000])
        with pytest.raises(BacktestError, match="E5001"):
            run_backtest(syn_df, config)

    def test_subset_units(self, syn_df):
        """指定部分单元回测应只包含这些单元的时点。"""
        config = make_light_config(unit_ids=[1, 2])
        result = run_backtest(syn_df, config)
        unit_set = set(p.unit_id for p in result.points)
        assert unit_set == {1, 2}

    def test_include_points_false(self, syn_df):
        """include_points=False 时 points 应为空。"""
        config = make_light_config(include_points=False)
        result = run_backtest(syn_df, config)
        assert result.points == []
        assert result.n_points > 0  # 但 n_points 仍正确

    def test_data_sufficiency_note_present(self, bt_result):
        """数据充分性说明应存在且非空。"""
        assert len(bt_result.data_sufficiency_note) > 0
        assert "非论文实验结果" in bt_result.data_sufficiency_note

    def test_data_sufficiency_small_dataset_warning(self, syn_df):
        """小数据集(单元数<20)应在说明中包含规模不足提示。"""
        result = run_backtest(syn_df, make_light_config())
        assert "不足以复现论文级实验规模" in result.data_sufficiency_note

    def test_assumptions_present(self, bt_result):
        """回测结果应包含工程假设说明。"""
        assert len(bt_result.assumptions) > 0
        text = " ".join(bt_result.assumptions)
        assert "A-B1" in text  # 留一单元法
        assert "A10" in text   # regret 规则


# ──────────────────────────────────────────────
# API 端点测试
# ──────────────────────────────────────────────

class TestBacktestAPI:
    """回测 API 端点集成测试。"""

    def _upload_and_get_session(self, client, df):
        """上传合成数据并返回 session_id。"""
        csv_text = df.to_csv(index=False)
        resp = client.post(
            "/api/data/upload",
            files={"file": ("test.csv", csv_text, "text/csv")},
        )
        assert resp.status_code == 200
        return resp.json()["session_id"]

    def test_backtest_run_api(self):
        """POST /api/backtest/run 应返回完整回测结果。"""
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        df = make_synthetic_fd001(n_units=3, seed=7)
        sid = self._upload_and_get_session(client, df)
        resp = client.post("/api/backtest/run", json={
            "session_id": sid,
            "config": {
                "data_mode": "offline", "step": 25, "min_cycle": 30,
                "k_nn": 3, "n_repeats": 1, "random_seed": 42,
            },
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["has_true_rul"] is True
        assert data["n_points"] > 0
        assert "ETO-C" in data["strategies"]

    def test_backtest_run_online_api(self):
        """在线模式 API:regret 应为 null。"""
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        df = make_synthetic_fd001(n_units=3, seed=7)
        sid = self._upload_and_get_session(client, df)
        resp = client.post("/api/backtest/run", json={
            "session_id": sid,
            "config": {"data_mode": "online", "step": 25, "k_nn": 3},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["has_true_rul"] is False
        assert data["strategies"]["ETO-C"]["regret_mean"] is None

    def test_backtest_export_csv_api(self):
        """POST /api/backtest/export-csv 应返回 CSV 文本。"""
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        df = make_synthetic_fd001(n_units=3, seed=7)
        sid = self._upload_and_get_session(client, df)
        resp = client.post("/api/backtest/export-csv", json={
            "session_id": sid,
            "config": {"data_mode": "offline", "step": 25, "k_nn": 3},
        })
        assert resp.status_code == 200
        assert "unit_id,cycle" in resp.text

    def test_backtest_session_not_found(self):
        """不存在的 session_id 应返回 404。"""
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app)
        resp = client.post("/api/backtest/run", json={
            "session_id": "sess_nonexistent",
            "config": {},
        })
        assert resp.status_code == 404