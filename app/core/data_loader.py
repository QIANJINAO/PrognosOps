# 数据加载模块
# 负责 CSV 解析、分隔符与表头自动检测、FD001 格式校验
# 格式校验失败抛出 DataLoaderError(含错误码 E1001/E1002)
# 质量检查(缺失值、重复行等)由 quality.py 负责,本模块只做解析与格式校验
# 本模块不静默补造任何缺失数据(用户要求 13),缺失值保留为 NaN 交由质量检查报告

import io
import re
from dataclasses import dataclass

import pandas as pd

from app.core.config import (
    get_all_column_names,
    get_column_roles,
    get_quality_thresholds,
)


class DataLoaderError(Exception):
    """数据加载异常,携带错误码(E1001/E1002)与详细信息。

    Attributes:
        code: 错误码(E1001 格式不符 / E1002 文件过大)
        message: 错误摘要
        detail: 错误详情(补充说明)
    """

    def __init__(self, code: str, message: str, detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message}" + (f": {detail}" if detail else ""))


@dataclass
class ParsedData:
    """CSV 解析结果。

    Attributes:
        df: 数值化 DataFrame(非数值已转 NaN,列名已规范化)
        df_raw: 原始字符串 DataFrame(保留原始值,供质量报告引用)
        file_name: 文件名
        file_size_mb: 文件大小(MB)
        separator: 检测到的分隔符("space" / "comma" / "tab")
        has_header: 原始文件是否含表头
        column_names: 规范化后的列名列表
        non_numeric_cells: 非数值单元格记录 [{"row": 行号, "column": 列名, "value": 原始值}]
    """

    df: pd.DataFrame
    df_raw: pd.DataFrame
    file_name: str
    file_size_mb: float
    separator: str
    has_header: bool
    column_names: list[str]
    non_numeric_cells: list[dict]


# ──────────────────────────────────────────────
# 分隔符与表头检测
# ──────────────────────────────────────────────

def _is_numeric_str(value: str) -> bool:
    """判断字符串是否可解析为数值。"""
    try:
        float(value)
        return True
    except (ValueError, TypeError):
        return False


def detect_separator(content: str) -> str:
    """检测 CSV 内容的分隔符(空格/逗号/制表符)。

    取前 20 行非空行,统计各分隔符出现频率,选最高者。
    FD001 原始格式为空格分隔,但系统也支持逗号分隔的 CSV。

    Returns:
        "space" / "comma" / "tab"
    """
    sample_lines = [line for line in content.strip().split("\n")[:20] if line.strip()]
    if not sample_lines:
        return "space"

    comma_count = sum(line.count(",") for line in sample_lines)
    tab_count = sum(line.count("\t") for line in sample_lines)
    # 纯空格分隔:连续空格视为一个分隔符
    pure_space_count = sum(len(re.findall(r" +", line)) for line in sample_lines)

    if comma_count > 0 and comma_count >= tab_count and comma_count >= pure_space_count:
        return "comma"
    if tab_count > 0 and tab_count > pure_space_count:
        return "tab"
    return "space"


def detect_header(first_line: str, separator: str) -> bool:
    """检测第一行是否为表头。

    判定规则:第一行的任一字段不能解析为数值 → 有表头。
    FD001 原始格式无表头(全部为数值),但有表头的 CSV 也支持。
    """
    sep_pattern = {"comma": r",", "tab": r"\t", "space": r"\s+"}[separator]
    fields = re.split(sep_pattern, first_line.strip())
    fields = [f.strip() for f in fields if f.strip()]
    if not fields:
        return False
    return not all(_is_numeric_str(f) for f in fields)


# ──────────────────────────────────────────────
# 列名规范化与必需列校验
# ──────────────────────────────────────────────

def _normalize_columns(df_raw: pd.DataFrame, has_header: bool) -> list[str]:
    """规范化列名。

    - 无表头:列数必须为 26(FD001 标准),按位置赋标准列名;
    - 有表头:列名与标准列名做大小写不敏感匹配,匹配成功用标准名,
      未匹配的保留原名(允许额外列,但必需列必须存在)。

    Raises:
        DataLoaderError: 无表头时列数不符(E1001)
    """
    standard_names = get_all_column_names()

    if not has_header:
        # 无表头:严格 26 列校验
        if df_raw.shape[1] != len(standard_names):
            raise DataLoaderError(
                "E1001",
                f"列数不符:期望 {len(standard_names)} 列(FD001 标准),实际 {df_raw.shape[1]} 列",
            )
        return list(standard_names)

    # 有表头:大小写不敏感匹配标准列名
    name_map = {name.lower(): name for name in standard_names}
    actual_names = [str(c).strip() for c in df_raw.columns]
    normalized = [name_map.get(a.lower(), a) for a in actual_names]
    return normalized


def _check_required_columns(column_names: list[str]) -> list[str]:
    """校验必需列是否存在(用户要求 4/5)。

    必需列:unit 列、cycle 列、14 个选定传感器列(来自配置文件)。
    返回缺失的选定传感器列名列表(供质量报告使用,若缺失则已抛异常)。

    Raises:
        DataLoaderError: 缺少 unit 列 / cycle 列 / 选定传感器列(E1001)
    """
    roles = get_column_roles()
    col_set = set(column_names)

    # unit 列(用户要求 5:识别 unit 列)
    unit_col = roles["unit_column"]
    if unit_col not in col_set:
        raise DataLoaderError(
            "E1001",
            f"缺少必需列: {unit_col}(设备单元编号列)",
            "请确保 CSV 包含 unit 列或采用 FD001 标准 26 列格式",
        )

    # cycle 列(用户要求 5:识别 cycle 列)
    cycle_col = roles["cycle_column"]
    if cycle_col not in col_set:
        raise DataLoaderError(
            "E1001",
            f"缺少必需列: {cycle_col}(运行周期列)",
            "请确保 CSV 包含 cycle 列或采用 FD001 标准 26 列格式",
        )

    # 14 个选定传感器列(用户要求 5/12:识别 sensor 列,映射来自配置文件)
    missing_sensors = [s for s in roles["selected_sensors"] if s not in col_set]
    if missing_sensors:
        raise DataLoaderError(
            "E1001",
            f"缺少选定传感器列: {missing_sensors}",
            f"FD001 分析需要以下 14 个传感器(来自配置文件): {roles['selected_sensors']}",
        )

    return missing_sensors


# ──────────────────────────────────────────────
# 非数值检测与数值化
# ──────────────────────────────────────────────

def _to_numeric_with_tracking(df_raw: pd.DataFrame) -> tuple[pd.DataFrame, list[dict]]:
    """将字符串 DataFrame 转为数值 DataFrame,同时记录非数值单元格(用户要求 8)。

    非数值单元格不静默丢弃,记录行号、列名与原始值,供质量报告展示。
    缺失值(空字符串/NaN)保留为 NaN,交由 quality.py 检查,不在此补造。

    Returns:
        (数值化 DataFrame, 非数值单元格记录列表)
    """
    df_numeric = pd.DataFrame(index=df_raw.index)
    non_numeric_cells: list[dict] = []

    for col in df_raw.columns:
        series = df_raw[col]
        # 尝试转为数值,失败变 NaN
        converted = pd.to_numeric(series, errors="coerce")
        df_numeric[col] = converted
        # 非数值 = 原始值非空但转换后为 NaN
        raw_nonempty = series.notna() & (series.astype(str).str.strip() != "")
        bad_mask = raw_nonempty & converted.isna()
        for idx in series[bad_mask].index:
            non_numeric_cells.append({
                "row": int(idx) + 1,  # 1-based 行号,方便用户在文件中定位
                "column": str(col),
                "value": str(series[idx]).strip(),
            })

    return df_numeric, non_numeric_cells


# ──────────────────────────────────────────────
# 主入口:parse_csv
# ──────────────────────────────────────────────

def parse_csv(content: str, file_name: str, file_size: int) -> ParsedData:
    """解析 CSV 内容并校验 FD001 格式。

    完整流程:
    1. 文件大小检查(用户要求 3,超限 E1002)
    2. 空文件检查(用户要求 2,空文件 E1001)
    3. 分隔符自动检测(空格/逗号/制表符)
    4. 表头自动检测
    5. 列名规范化与列数校验(用户要求 4/11,FD001 标准)
    6. 必需列校验(用户要求 5,unit/cycle/sensors)
    7. 非数值检测(用户要求 8,仅记录不修改)

    Args:
        content: 文件文本内容
        file_name: 文件名
        file_size: 文件字节数

    Returns:
        ParsedData 对象

    Raises:
        DataLoaderError: E1001(格式不符)或 E1002(文件过大)
    """
    thresholds = get_quality_thresholds()
    file_size_mb = file_size / (1024 * 1024)

    # 1. 文件大小检查(用户要求 3)
    if file_size_mb > thresholds["max_file_size_mb"]:
        raise DataLoaderError(
            "E1002",
            f"文件大小 {file_size_mb:.2f}MB 超过限制 {thresholds['max_file_size_mb']}MB",
        )

    # 2. 空文件检查(用户要求 2)
    stripped = content.strip()
    if not stripped:
        raise DataLoaderError("E1001", "文件为空,无任何数据内容")

    # 3. 分隔符检测
    separator = detect_separator(content)

    # 4. 表头检测
    first_line = stripped.split("\n")[0]
    has_header = detect_header(first_line, separator)

    # 5. 解析为字符串 DataFrame(保留原始值,便于追踪非数值与缺失)
    sep_pattern = {"comma": r",", "tab": r"\t", "space": r"\s+"}[separator]
    if has_header:
        df_raw = pd.read_csv(
            io.StringIO(content), sep=sep_pattern, engine="python",
            dtype=str, skipinitialspace=True,
        )
    else:
        df_raw = pd.read_csv(
            io.StringIO(content), sep=sep_pattern, engine="python",
            header=None, dtype=str, skipinitialspace=True,
        )

    # 去除全空行(只有分隔符或空白的行)
    df_raw = df_raw.dropna(how="all")

    # 空数据检查(只有表头没有数据行,也视为空文件)
    if df_raw.empty:
        raise DataLoaderError("E1001", "文件无有效数据行(仅含表头或空白行)")

    # 6. 列名规范化(用户要求 4/11)
    column_names = _normalize_columns(df_raw, has_header)
    df_raw.columns = column_names

    # 7. 必需列校验(用户要求 5)
    _check_required_columns(column_names)

    # 8. 非数值检测与数值化(用户要求 8)
    df_numeric, non_numeric_cells = _to_numeric_with_tracking(df_raw)

    return ParsedData(
        df=df_numeric,
        df_raw=df_raw,
        file_name=file_name,
        file_size_mb=round(file_size_mb, 4),
        separator=separator,
        has_header=has_header,
        column_names=column_names,
        non_numeric_cells=non_numeric_cells,
    )