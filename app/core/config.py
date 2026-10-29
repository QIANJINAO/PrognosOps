# 配置加载模块
# 从 config/sensors.json 读取 FD001 数据集的列定义与传感器映射
# 14 个选定传感器的映射必须来自本配置文件(用户要求 12),不得硬编码在业务代码中

import json
import os
from functools import lru_cache
from typing import Any


# 配置文件路径:项目根目录下的 config/sensors.json
_CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config")
_SENSORS_CONFIG_PATH = os.path.join(_CONFIG_DIR, "sensors.json")


@lru_cache(maxsize=1)
def load_sensors_config() -> dict[str, Any]:
    """加载传感器配置文件并缓存。

    返回完整的配置字典,包含 fd001 数据集的列定义、
    选定传感器列表、常量传感器列表等。
    配置文件缺失时抛出 FileNotFoundError,不提供默认值兜底
    (配置是数据校验的基础,必须显式存在)。
    """
    if not os.path.exists(_SENSORS_CONFIG_PATH):
        raise FileNotFoundError(
            f"传感器配置文件不存在: {_SENSORS_CONFIG_PATH},"
            f"请确保 config/sensors.json 已创建"
        )
    with open(_SENSORS_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def get_fd001_config() -> dict[str, Any]:
    """获取 FD001 数据集配置段。"""
    config = load_sensors_config()
    if "fd001" not in config:
        raise KeyError("配置文件中缺少 'fd001' 配置段")
    return config["fd001"]


def get_selected_sensors() -> list[str]:
    """获取 14 个选定传感器名称列表(来自配置文件)。"""
    return list(get_fd001_config()["selected_sensors"])


def get_constant_sensors() -> list[str]:
    """获取常量传感器名称列表(FD001 中方差为零的传感器,属预期现象)。"""
    return list(get_fd001_config()["constant_sensors"])


def get_all_column_names() -> list[str]:
    """获取 FD001 标准格式的全部 26 列列名(按列序排列)。"""
    return list(get_fd001_config()["all_column_names"])


def get_column_roles() -> dict[str, Any]:
    """获取列角色映射(unit 列、cycle 列、setting 列、sensor 列)。

    返回字典包含:
    - unit_column: 设备单元编号列名
    - cycle_column: 运行周期列名
    - setting_columns: 操作设定列名列表
    - sensor_columns: 全部 21 个传感器列名列表
    - selected_sensors: 14 个选定传感器列名列表
    """
    cfg = get_fd001_config()
    all_names = cfg["all_column_names"]
    setting_cols = set(cfg["setting_columns"])
    # 传感器列 = 全部列去掉 unit、cycle 和 setting 列
    sensor_cols = [c for c in all_names if c not in (cfg["unit_column"], cfg["cycle_column"]) and c not in setting_cols]
    return {
        "unit_column": cfg["unit_column"],
        "cycle_column": cfg["cycle_column"],
        "setting_columns": list(cfg["setting_columns"]),
        "sensor_columns": sensor_cols,
        "selected_sensors": list(cfg["selected_sensors"]),
    }


def get_quality_thresholds() -> dict[str, Any]:
    """获取数据质量检查的阈值参数。"""
    cfg = get_fd001_config()
    return {
        "min_cycles": cfg["min_cycles"],
        "feature_window": cfg["feature_window"],
        "max_file_size_mb": cfg["max_file_size_mb"],
        "missing_ratio_critical": 0.20,   # 缺失比例超过 20% 判定为严重
        "constant_variance_eps": 1e-8,    # 方差低于此值判定为常量列
    }