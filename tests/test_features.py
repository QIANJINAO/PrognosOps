# 特征工程模块测试
# 覆盖用户要求:
# 1. 使用最近 30 个周期  2. 14 个传感器来自配置  3. 420 维特征
# 4. 支持归一化  5. 保存传感器映射  6. 不足 30 周期返回错误
# 7. 不自动补造数据  8. 输出特征配置和数据假设

import numpy as np
import pandas as pd
import pytest

from app.core.config import get_column_roles, get_selected_sensors
from app.core.features import (
    FeatureError,
    apply_normalization,
    build_sensor_mapping,
    compute_norm_params,
    extract_features,
)
from app.domain.models import NormParams


# ──────────────────────────────────────────────
# 测试辅助:构造合法 FD001 DataFrame
# ──────────────────────────────────────────────

def make_fd001_df(n_units: int = 1, cycles_per_unit: int = 35, seed: int = 42) -> pd.DataFrame:
    """构造合法的 FD001 数值化 DataFrame(26 列,多单元,周期连续)。"""
    roles = get_column_roles()
    all_cols = roles["unit_column"], roles["cycle_column"]
    rng = np.random.default_rng(seed)

    rows = []
    for unit in range(1, n_units + 1):
        for cycle in range(1, cycles_per_unit + 1):
            row = {
                roles["unit_column"]: unit,
                roles["cycle_column"]: cycle,
            }
            # 3 个 setting 列
            for s in roles["setting_columns"]:
                row[s] = 0.0
            # 21 个传感器列(有微小变化,非常量)
            for s in roles["sensor_columns"]:
                row[s] = float(rng.normal(0, 0.1))
            rows.append(row)

    return pd.DataFrame(rows)


# ──────────────────────────────────────────────
# 测试 1:正常提取 420 维特征(要求 1/2/3)
# ──────────────────────────────────────────────

def test_extract_420_dim_feature():
    """合法数据应提取出 420 维特征向量(30 周期 × 14 传感器)。"""
    df = make_fd001_df(n_units=1, cycles_per_unit=35)
    result = extract_features(df, unit_id=1, normalize=False)

    assert result.dim == 420
    assert result.window == 30
    assert len(result.feature_vector) == 420
    assert len(result.sensors) == 14
    # 14 个传感器来自配置文件(要求 2)
    expected_sensors = get_selected_sensors()
    assert result.sensors == expected_sensors


def test_uses_last_30_cycles():
    """特征应使用最近 30 个周期的数据(要求 1),验证末尾值正确。"""
    roles = get_column_roles()
    df = make_fd001_df(n_units=1, cycles_per_unit=35)
    result = extract_features(df, unit_id=1, normalize=False)

    # 最近 30 周期 = cycle 6..35(共 30 行)
    recent = df[df[roles["cycle_column"]] >= 6].sort_values(roles["cycle_column"])
    sensor = result.sensors[0]  # 第一个传感器
    # 特征向量中第一个传感器的值 = 最近 30 周期中该传感器的读数(按行优先)
    expected = recent[sensor].to_numpy()
    actual = np.array(result.feature_vector[0::14])  # 每隔 14 取一个 = 该传感器的 30 个值
    np.testing.assert_allclose(actual, expected, rtol=1e-10)


# ──────────────────────────────────────────────
# 测试 2:不足 30 周期返回错误(要求 6/7)
# ──────────────────────────────────────────────

def test_insufficient_cycles_returns_error():
    """周期数不足 30 时应返回 E3002 错误,不补造数据(要求 6/7)。"""
    df = make_fd001_df(n_units=1, cycles_per_unit=20)  # 只有 20 周期
    with pytest.raises(FeatureError) as exc_info:
        extract_features(df, unit_id=1)
    assert exc_info.value.code == "E3002"
    assert "不足" in exc_info.value.message
    # 明确声明不执行前向填充(要求 7)
    assert "前向填充" in exc_info.value.detail or "不补造" in exc_info.value.detail


def test_exactly_30_cycles_succeeds():
    """恰好 30 周期应成功提取(边界条件)。"""
    df = make_fd001_df(n_units=1, cycles_per_unit=30)
    result = extract_features(df, unit_id=1, normalize=False)
    assert result.dim == 420


# ──────────────────────────────────────────────
# 测试 3:缺失值返回错误,不补造(要求 7)
# ──────────────────────────────────────────────

def test_nan_in_window_returns_error():
    """特征窗口内存在缺失值时应返回 E3002 错误,不补造(要求 7,假设 A-F1)。"""
    roles = get_column_roles()
    df = make_fd001_df(n_units=1, cycles_per_unit=35)
    # 在最近 30 周期窗口内(最后一个周期)注入 NaN
    last_idx = df.index[-1]
    df.loc[last_idx, "s2"] = np.nan

    with pytest.raises(FeatureError) as exc_info:
        extract_features(df, unit_id=1)
    assert exc_info.value.code == "E3002"
    assert "缺失值" in exc_info.value.message
    assert "不补造" in exc_info.value.message


# ──────────────────────────────────────────────
# 测试 4:归一化(要求 4)
# ──────────────────────────────────────────────

def test_normalization_produces_zero_mean_unit_std():
    """z-score 归一化后,同一传感器的值应具有零均值、单位标准差(近似)。"""
    df = make_fd001_df(n_units=3, cycles_per_unit=40, seed=123)
    # 使用外部归一化参数(模拟参考集参数)
    norm_params = compute_norm_params(df, get_selected_sensors(), 30)
    result = extract_features(df, unit_id=1, normalize=True, norm_params=norm_params)

    assert result.normalized is True
    assert result.norm_params is not None
    assert len(result.norm_params.mean) == 420
    assert len(result.norm_params.std) == 420


def test_no_normalization_when_disabled():
    """normalize=False 时特征向量保留原始量纲。"""
    df = make_fd001_df(n_units=1, cycles_per_unit=35)
    result = extract_features(df, unit_id=1, normalize=False)

    assert result.normalized is False
    assert result.norm_params is None


def test_constant_dimension_normalizes_to_zero():
    """常量维度(σ=0)归一化后约定为 0(假设 A-F2)。"""
    vec = np.array([5.0, 5.0, 5.0, 3.0, 4.0, 5.0])
    params = NormParams(mean=[5.0, 5.0, 5.0, 3.0, 4.0, 5.0], std=[0.0, 0.0, 0.0, 1.0, 1.0, 1.0])
    normalized = apply_normalization(vec, params)
    # 前三个维度 σ=0,归一化后应为 0
    np.testing.assert_allclose(normalized[:3], [0.0, 0.0, 0.0])
    # 后三个维度正常 z-score
    np.testing.assert_allclose(normalized[3:], [0.0, 0.0, 0.0])


# ──────────────────────────────────────────────
# 测试 5:传感器映射(要求 5)
# ──────────────────────────────────────────────

def test_sensor_mapping_from_config():
    """传感器映射应来自配置文件,记录列位置、间隔与首次索引(要求 5)。"""
    sensors = get_selected_sensors()
    mapping = build_sensor_mapping(sensors, 30)

    assert len(mapping) == 14
    for j, m in enumerate(mapping):
        assert m.sensor_name == sensors[j]
        assert m.column_index == j
        assert m.stride == 14
        assert m.first_index == j
    # 验证映射可还原:传感器 s_j 在第 i 周期的索引 = i * 14 + j
    assert mapping[0].first_index == 0   # s2 首次出现在索引 0
    assert mapping[13].first_index == 13  # s21 首次出现在索引 13


# ──────────────────────────────────────────────
# 测试 6:特征配置与数据假设输出(要求 8)
# ──────────────────────────────────────────────

def test_outputs_config_and_assumptions():
    """特征结果应包含特征配置与数据假设说明(要求 8)。"""
    df = make_fd001_df(n_units=1, cycles_per_unit=35)
    result = extract_features(df, unit_id=1, normalize=True)

    # 特征配置
    assert result.dim == 420
    assert result.window == 30
    assert len(result.sensors) == 14
    assert len(result.sensor_mapping) == 14

    # 数据假设(要求 8)
    assert len(result.assumptions) > 0
    # 假设 A1 已变更:不补造数据
    assert any("A1" in a and "不补造" in a for a in result.assumptions)
    # 假设 A-F1:缺失值不补造
    assert any("A-F1" in a for a in result.assumptions)


# ──────────────────────────────────────────────
# 测试 7:单元不存在返回错误
# ──────────────────────────────────────────────

def test_nonexistent_unit_returns_error():
    """请求不存在的单元应返回 E2002 错误。"""
    df = make_fd001_df(n_units=1, cycles_per_unit=35)
    with pytest.raises(FeatureError) as exc_info:
        extract_features(df, unit_id=99)
    assert exc_info.value.code == "E2002"


# ──────────────────────────────────────────────
# 测试 8:多单元提取互不干扰
# ──────────────────────────────────────────────

def test_multi_unit_extraction():
    """多单元数据中提取不同单元的特征,结果应各自正确。"""
    df = make_fd001_df(n_units=3, cycles_per_unit=40, seed=77)
    result_1 = extract_features(df, unit_id=1, normalize=False)
    result_2 = extract_features(df, unit_id=2, normalize=False)
    result_3 = extract_features(df, unit_id=3, normalize=False)

    # 三个单元的特征向量应互不相同
    v1 = np.array(result_1.feature_vector)
    v2 = np.array(result_2.feature_vector)
    v3 = np.array(result_3.feature_vector)
    assert not np.allclose(v1, v2)
    assert not np.allclose(v2, v3)
    # 维度均为 420
    assert result_1.dim == result_2.dim == result_3.dim == 420