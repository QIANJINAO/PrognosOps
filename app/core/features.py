# 特征工程模块
# 从设备单元的传感器数据中提取 420 维特征向量(30 周期 × 14 传感器)
# 遵循 docs/model_contract.md 中的公式与工程假设
#
# 关键规则:
# - 数据不足 30 个周期时返回错误,不补造数据(用户要求 6/7,假设 A1 已变更)
# - 特征窗口内存在缺失值(NaN)时返回错误,不补造(假设 A-F1)
# - 14 个传感器映射来自配置文件(用户要求 2/5)
# - z-score 归一化,常量维度(σ=0)约定为 0(假设 A-F2)
# - 输出特征配置与数据假设(用户要求 8)

import numpy as np
import pandas as pd

from app.core.config import get_column_roles, get_quality_thresholds
from app.domain.models import (
    FeatureResult,
    NormParams,
    SensorMapping,
)


class FeatureError(Exception):
    """特征提取异常,携带错误码(E2002/E3002)与详细信息。

    Attributes:
        code: 错误码(E2002 单元不存在 / E3002 特征维度/数据异常)
        message: 错误摘要
        detail: 错误详情
    """

    def __init__(self, code: str, message: str, detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message}" + (f": {detail}" if detail else ""))


# ──────────────────────────────────────────────
# 传感器映射构建
# ──────────────────────────────────────────────

def build_sensor_mapping(sensors: list[str], window: int) -> list[SensorMapping]:
    """构建传感器名 → 特征向量索引的映射(用户要求 5:保存传感器映射)。

    特征向量按行优先展平:第 i 周期的 14 个传感器值位于索引 [i*14, (i+1)*14)。
    传感器 s_j 在第 i 周期的值位于索引:i * 14 + j。
    因此同一传感器的值在向量中间隔为 14(stride),首次出现在索引 j。

    Args:
        sensors: 14 个传感器名称列表(来自配置文件)
        window: 特征窗口长度(30)

    Returns:
        传感器映射列表,每个映射记录传感器名、列位置、间隔与首次索引
    """
    n_sensors = len(sensors)
    mapping: list[SensorMapping] = []
    for j, name in enumerate(sensors):
        mapping.append(SensorMapping(
            sensor_name=name,
            column_index=j,
            stride=n_sensors,
            first_index=j,
        ))
    return mapping


# ──────────────────────────────────────────────
# z-score 归一化
# ──────────────────────────────────────────────

def compute_norm_params(df: pd.DataFrame, sensors: list[str], window: int) -> NormParams:
    """从全量数据计算 z-score 归一化参数(假设 A2)。

    当外部未提供归一化参数时的回退方案:
    逐传感器计算全量数据的均值与标准差,再按行优先展平顺序铺展到 420 维
    (每个传感器的统计量在其对应的 30 个维度位置上重复)。

    σ=0 的维度(常量传感器)标准差保留为 0,归一化时约定输出 0(假设 A-F2)。

    Args:
        df: 全量数值化 DataFrame(所有单元所有周期)
        sensors: 14 个传感器名称列表
        window: 特征窗口长度(30)

    Returns:
        NormParams(mean[420], std[420])
    """
    n_sensors = len(sensors)
    # 逐传感器计算全量统计量
    sensor_means = np.array([float(df[s].mean()) for s in sensors])  # (14,)
    sensor_stds = np.array([float(df[s].std()) for s in sensors])    # (14,)

    # 按行优先展平顺序铺展:第 i 周期的第 j 传感器 → 索引 i*14+j
    # 每个传感器的统计量在其 30 个维度位置上重复
    mean_420 = np.tile(sensor_means, window)    # (420,)
    std_420 = np.tile(sensor_stds, window)      # (420,)

    return NormParams(mean=mean_420.tolist(), std=std_420.tolist())


def apply_normalization(
    feature_vector: np.ndarray, norm_params: NormParams,
) -> np.ndarray:
    """对特征向量应用 z-score 归一化(用户要求 4:支持归一化)。

    f_norm[i] = (f[i] - μ[i]) / σ[i]
    σ[i] = 0 时(常量维度),f_norm[i] = 0(假设 A-F2)。

    Args:
        feature_vector: 420 维特征向量
        norm_params: 归一化参数(μ, σ)

    Returns:
        归一化后的 420 维特征向量
    """
    mean = np.array(norm_params.mean)
    std = np.array(norm_params.std)
    # 避免除零:σ=0 的维度输出 0(假设 A-F2)
    safe_std = np.where(std == 0, 1.0, std)
    normalized = (feature_vector - mean) / safe_std
    # σ=0 的维度强制为 0
    normalized = np.where(std == 0, 0.0, normalized)
    return normalized


# ──────────────────────────────────────────────
# 假设说明生成(用户要求 8)
# ──────────────────────────────────────────────

def _generate_feature_assumptions(
    normalized: bool, norm_params_source: str, n_cycles: int,
) -> list[str]:
    """生成特征提取的数据假设说明(用户要求 8:输出特征配置和数据假设)。"""
    assumptions: list[str] = []

    assumptions.append(
        f"【假设 A1-已变更】单元周期数为 {n_cycles}(≥30),不补造任何数据。"
        f"周期不足 30 的单元将在提取时直接返回错误,不执行前向填充。"
    )

    if normalized:
        assumptions.append(
            f"【假设 A2】z-score 归一化参数来源:{norm_params_source}。"
            f"归一化参数随特征结果一并输出,保证特征空间可追溯。"
        )
        assumptions.append(
            f"【假设 A-F2】常量维度(σ=0)归一化后约定为 0,"
            f"数学上等价于(常量−常量)/1 = 0。"
        )
    else:
        assumptions.append(
            f"【假设 A2-未启用】本次提取未执行归一化(normalize=False),"
            f"特征向量保留原始量纲。"
        )

    assumptions.append(
        f"【假设 A-F1】特征窗口(最近 30 周期)内若存在缺失值(NaN),"
        f"提取将直接返回错误,不补造、不插值。"
    )

    return assumptions


# ──────────────────────────────────────────────
# 主入口
# ──────────────────────────────────────────────

def extract_features(
    df: pd.DataFrame,
    unit_id: int,
    normalize: bool = True,
    norm_params: NormParams | None = None,
) -> FeatureResult:
    """从指定设备单元提取 420 维特征向量(用户要求 1/2/3/4/6/7)。

    完整流程:
    1. 校验单元存在(E2002)
    2. 取该单元数据,按 cycle 排序
    3. 校验周期数 ≥ 30(E3002,不补造,用户要求 6/7)
    4. 截取最近 30 周期的 14 个传感器读数
    5. 校验窗口内无缺失值(E3002,不补造,假设 A-F1)
    6. 按行优先展平为 420 维向量
    7. 维度校验:必须为 420(E3002)
    8. z-score 归一化(可选,用户要求 4)

    Args:
        df: 数值化 DataFrame(含 unit/cycle/sensor 列)
        unit_id: 目标设备单元编号
        normalize: 是否执行 z-score 归一化(默认 True)
        norm_params: 外部提供的归一化参数(保证特征空间一致);
                     为 None 时从当前特征向量自行计算

    Returns:
        FeatureResult 特征提取结果

    Raises:
        FeatureError: E2002(单元不存在)/ E3002(周期不足/缺失值/维度异常)
    """
    roles = get_column_roles()
    thresholds = get_quality_thresholds()
    unit_col = roles["unit_column"]
    cycle_col = roles["cycle_column"]
    sensors = roles["selected_sensors"]  # 14 个传感器,来自配置文件(用户要求 2)
    window = thresholds["feature_window"]  # 30 周期(用户要求 1)
    n_sensors = len(sensors)
    expected_dim = window * n_sensors  # 420(用户要求 3)

    # 1. 校验单元存在
    unit_data = df[df[unit_col] == unit_id]
    if unit_data.empty:
        raise FeatureError(
            "E2002",
            f"设备单元 {unit_id} 不存在",
            f"数据中可用的单元: {sorted(df[unit_col].unique().tolist())}",
        )

    # 2. 按 cycle 排序
    unit_data = unit_data.sort_values(cycle_col).reset_index(drop=True)
    n_cycles = len(unit_data)

    # 3. 校验周期数 ≥ 30(用户要求 6:不足 30 返回错误,不补造)
    if n_cycles < window:
        raise FeatureError(
            "E3002",
            f"单元 {unit_id} 周期数不足:实际 {n_cycles} 周期,需要 ≥ {window} 周期",
            "依据假设 A1(已变更),不执行前向填充,直接返回错误",
        )

    # 4. 截取最近 30 周期的 14 个传感器读数
    recent = unit_data.tail(window)
    sensor_matrix = recent[sensors].to_numpy(dtype=float)  # shape: (30, 14)

    # 5. 校验窗口内无缺失值(假设 A-F1:不补造)
    nan_count = int(np.isnan(sensor_matrix).sum())
    if nan_count > 0:
        nan_positions = np.argwhere(np.isnan(sensor_matrix))
        samples = [
            f"周期行 {int(r)}, 传感器 {sensors[int(c)]}"
            for r, c in nan_positions[:10]
        ]
        raise FeatureError(
            "E3002",
            f"特征窗口内存在 {nan_count} 个缺失值(NaN),不补造数据",
            f"缺失位置示例: {samples}",
        )

    # 6. 按行优先展平为 420 维向量(用户要求 3)
    feature_vector = sensor_matrix.flatten()  # shape: (420,)

    # 7. 维度校验
    if feature_vector.shape[0] != expected_dim:
        raise FeatureError(
            "E3002",
            f"特征维度异常:期望 {expected_dim} 维,实际 {feature_vector.shape[0]} 维",
        )

    # 8. z-score 归一化(用户要求 4)
    normalized = False
    result_norm_params = None
    norm_params_source = "未启用"

    if normalize:
        if norm_params is not None:
            # 使用外部提供的归一化参数(保证特征空间一致,假设 A2)
            result_norm_params = norm_params
            norm_params_source = "外部提供(保证特征空间一致性)"
        else:
            # 从全量数据计算归一化参数(回退方案)
            result_norm_params = compute_norm_params(df, sensors, window)
            norm_params_source = "全量数据逐传感器计算"
        feature_vector = apply_normalization(feature_vector, result_norm_params)
        normalized = True

    # 9. 构建传感器映射(用户要求 5)
    sensor_mapping = build_sensor_mapping(sensors, window)

    # 10. 生成假设说明(用户要求 8)
    assumptions = _generate_feature_assumptions(
        normalized, norm_params_source, n_cycles,
    )

    return FeatureResult(
        unit_id=unit_id,
        feature_vector=feature_vector.tolist(),
        dim=expected_dim,
        window=window,
        sensors=list(sensors),
        sensor_mapping=sensor_mapping,
        normalized=normalized,
        norm_params=result_norm_params,
        assumptions=assumptions,
    )