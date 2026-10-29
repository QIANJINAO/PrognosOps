# 质量检查模块
# 对解析后的数据执行全面质量检查,生成结构化 DataQualityReport(用户要求 15)
# 检查项:缺失值(要求 6)、重复行(要求 7)、非数值(要求 8)、
#         周期连续性(要求 9)、最少周期数(要求 10)
# 缺少数据时生成明确的假设说明(用户要求 14),绝不静默补造缺失数据(用户要求 13)

import pandas as pd

from app.core.config import (
    get_column_roles,
    get_constant_sensors,
    get_quality_thresholds,
)
from app.core.data_loader import ParsedData
from app.domain.models import (
    CheckResult,
    ColumnMapping,
    DataQualityReport,
    UnitSummary,
)


# ──────────────────────────────────────────────
# 值级检查
# ──────────────────────────────────────────────

def _check_missing_values(df: pd.DataFrame, thresholds: dict) -> CheckResult:
    """检查缺失值(用户要求 6)。

    统计各列缺失数量与比例,缺失比例超过阈值(默认 20%)的列标记为 critical。
    缺失值不做任何补造(用户要求 13),仅在报告中如实记录。
    """
    total_cells = df.size
    if total_cells == 0:
        return CheckResult(
            name="缺失值检查", passed=True, level="info",
            message="数据为空,无缺失值可检查", details={},
        )

    missing_per_col = df.isna().sum()
    total_missing = int(missing_per_col.sum())
    critical_threshold = thresholds["missing_ratio_critical"]

    # 各列缺失详情
    col_details: dict = {}
    over_threshold_cols: list[str] = []
    for col in df.columns:
        count = int(missing_per_col[col])
        if count > 0:
            ratio = count / len(df)
            col_details[col] = {"count": count, "ratio": round(ratio, 4)}
            if ratio > critical_threshold:
                over_threshold_cols.append(col)

    if total_missing == 0:
        return CheckResult(
            name="缺失值检查", passed=True, level="info",
            message="数据无缺失值", details={},
        )

    level = "critical" if over_threshold_cols else "warning"
    message = f"数据存在 {total_missing} 个缺失值(涉及 {len(col_details)} 列)"
    if over_threshold_cols:
        message += f",其中 {over_threshold_cols} 列缺失比例超过 {critical_threshold:.0%}"

    return CheckResult(
        name="缺失值检查", passed=False, level=level, message=message,
        details={
            "total_missing": total_missing,
            "columns": col_details,
            "over_threshold_columns": over_threshold_cols,
        },
    )


def _check_duplicate_rows(df: pd.DataFrame) -> CheckResult:
    """检查重复行(用户要求 7)。

    完全重复的行(所有列值相同)记为重复,仅提示不自动去重。
    """
    dup_count = int(df.duplicated().sum())
    if dup_count == 0:
        return CheckResult(
            name="重复行检查", passed=True, level="info",
            message="数据无重复行", details={},
        )
    return CheckResult(
        name="重复行检查", passed=False, level="warning",
        message=f"数据存在 {dup_count} 行完全重复(未自动去重,仅提示)",
        details={"duplicate_count": dup_count},
    )


def _check_non_numeric(parsed_data: ParsedData) -> CheckResult:
    """检查非数值数据(用户要求 8)。

    非数值单元格已在解析阶段记录(parsed_data.non_numeric_cells),
    此处汇总为检查结果。非数值数据已转为 NaN,不做补造。
    """
    cells = parsed_data.non_numeric_cells
    if not cells:
        return CheckResult(
            name="非数值数据检查", passed=True, level="info",
            message="数据全部为有效数值", details={},
        )
    # 按列汇总
    col_counts: dict = {}
    for c in cells:
        col_counts[c["column"]] = col_counts.get(c["column"], 0) + 1
    return CheckResult(
        name="非数值数据检查", passed=False, level="error",
        message=f"数据存在 {len(cells)} 个非数值单元格(涉及 {len(col_counts)} 列),已转为缺失值处理,未做补造",
        details={"total": len(cells), "by_column": col_counts, "samples": cells[:20]},
    )


# ──────────────────────────────────────────────
# 单元级检查
# ──────────────────────────────────────────────

def _analyze_units(
    df: pd.DataFrame, unit_col: str, cycle_col: str, min_cycles: int,
) -> tuple[list[UnitSummary], list[int], list[int]]:
    """分析各设备单元的周期连续性与周期数。

    Returns:
        (各单元摘要列表, 周期不连续的单元 ID 列表, 周期数不足的单元 ID 列表)
    """
    units_summary: list[UnitSummary] = []
    discontinuous_units: list[int] = []
    insufficient_units: list[int] = []

    for unit_id, group in df.groupby(unit_col):
        # 去重后的周期号序列(排除缺失的 cycle 值)
        cycles = sorted(group[cycle_col].dropna().astype(int).unique())
        cycle_count = len(cycles)
        cycle_min = int(cycles[0]) if cycles else 0
        cycle_max = int(cycles[-1]) if cycles else 0

        # 周期连续性:期望从 cycle_min 到 cycle_max 的完整整数序列
        expected = set(range(cycle_min, cycle_max + 1))
        actual = set(cycles)
        missing = sorted(expected - actual)
        is_continuous = len(missing) == 0

        meets_min = cycle_count >= min_cycles

        if not is_continuous:
            discontinuous_units.append(int(unit_id))
        if not meets_min:
            insufficient_units.append(int(unit_id))

        units_summary.append(UnitSummary(
            unit_id=int(unit_id),
            cycle_count=cycle_count,
            cycle_min=cycle_min,
            cycle_max=cycle_max,
            cycle_continuous=is_continuous,
            missing_cycles=missing,
            meets_min_cycles=meets_min,
        ))

    return units_summary, discontinuous_units, insufficient_units


def _make_continuity_check(
    discontinuous_units: list[int], units_summary: list[UnitSummary],
) -> CheckResult:
    """生成周期连续性检查结果(用户要求 9)。"""
    if not discontinuous_units:
        return CheckResult(
            name="周期连续性检查", passed=True, level="info",
            message="所有单元的周期序列连续无跳跃", details={},
        )
    total_missing = sum(
        len(u.missing_cycles) for u in units_summary if not u.cycle_continuous
    )
    return CheckResult(
        name="周期连续性检查", passed=False, level="warning",
        message=(
            f"{len(discontinuous_units)} 个单元的周期序列不连续(共缺失 {total_missing} 个周期),"
            f"缺失周期未做补造"
        ),
        details={
            "discontinuous_units": discontinuous_units,
            "total_missing_cycles": total_missing,
        },
    )


def _make_min_cycles_check(
    insufficient_units: list[int], min_cycles: int,
) -> CheckResult:
    """生成最少周期数检查结果(用户要求 10)。"""
    if not insufficient_units:
        return CheckResult(
            name="最少周期数检查", passed=True, level="info",
            message=f"所有单元的周期数均 ≥ {min_cycles}", details={},
        )
    return CheckResult(
        name="最少周期数检查", passed=False, level="warning",
        message=f"{len(insufficient_units)} 个单元的周期数不足 {min_cycles}",
        details={"insufficient_units": insufficient_units, "min_required": min_cycles},
    )


# ──────────────────────────────────────────────
# 假设说明生成(用户要求 14)
# ──────────────────────────────────────────────

def _generate_assumptions(
    checks: list[CheckResult],
    units_summary: list[UnitSummary],
    discontinuous_units: list[int],
    insufficient_units: list[int],
    thresholds: dict,
) -> list[str]:
    """缺少数据时生成明确的假设说明(用户要求 14)。

    每条假设说明明确指出:发现了什么问题、未做什么处理(不补造)、
    后续分析将如何处理(引用工程假设编号)。
    """
    assumptions: list[str] = []
    min_cycles = thresholds["min_cycles"]

    # 缺失值假设说明
    missing_check = next((c for c in checks if c.name == "缺失值检查"), None)
    if missing_check and not missing_check.passed:
        total = missing_check.details.get("total_missing", 0)
        assumptions.append(
            f"【假设说明-缺失值】数据存在 {total} 个缺失值,系统未对缺失值做任何补造或插值。"
            f"后续特征提取与 RUL 估计将跳过含缺失值的记录,分析结果可能受此影响。"
        )

    # 非数值数据假设说明
    non_numeric_check = next((c for c in checks if c.name == "非数值数据检查"), None)
    if non_numeric_check and not non_numeric_check.passed:
        total = non_numeric_check.details.get("total", 0)
        assumptions.append(
            f"【假设说明-非数值】数据存在 {total} 个非数值单元格,已转为缺失值处理,未做补造。"
            f"建议检查原始数据中这些单元格的来源。"
        )

    # 周期不连续假设说明
    if discontinuous_units:
        total_missing = sum(
            len(u.missing_cycles) for u in units_summary if not u.cycle_continuous
        )
        assumptions.append(
            f"【假设说明-周期不连续】{len(discontinuous_units)} 个设备单元"
            f"(如单元 {discontinuous_units[:5]})的周期序列存在跳跃,共缺失 {total_missing} 个周期。"
            f"缺失周期数据未做补造,后续特征提取将仅使用实际存在的周期数据。"
        )

    # 周期数不足假设说明(引用工程假设 A1)
    if insufficient_units:
        assumptions.append(
            f"【假设说明-周期不足】{len(insufficient_units)} 个设备单元"
            f"(如单元 {insufficient_units[:5]})的周期数不足 {min_cycles}。"
            f"依据工程假设 A1,后续特征提取时将用最早可用周期的读数前向填充至 {min_cycles} 行。"
            f"此处仅记录该假设,数据本身未做任何修改或补造。"
        )

    # 重复行假设说明
    dup_check = next((c for c in checks if c.name == "重复行检查"), None)
    if dup_check and not dup_check.passed:
        count = dup_check.details.get("duplicate_count", 0)
        assumptions.append(
            f"【假设说明-重复行】数据存在 {count} 行完全重复,系统未自动去重。"
            f"重复行可能影响统计结果的准确性,建议检查数据采集过程。"
        )

    return assumptions


# ──────────────────────────────────────────────
# 主入口
# ──────────────────────────────────────────────

def run_quality_checks(parsed_data: ParsedData) -> DataQualityReport:
    """对解析后的数据执行全面质量检查,生成结构化 DataQualityReport。

    检查项与用户要求的对应:
    - 列名与格式检查(要求 4/11,FD001 标准)
    - 列识别(要求 5,unit/cycle/setting/sensor)
    - 缺失值检查(要求 6)
    - 重复行检查(要求 7)
    - 非数值数据检查(要求 8)
    - 周期连续性检查(要求 9)
    - 最少周期数检查(要求 10)

    Args:
        parsed_data: parse_csv 返回的解析结果

    Returns:
        DataQualityReport 结构化质量报告
    """
    df = parsed_data.df
    thresholds = get_quality_thresholds()
    roles = get_column_roles()
    unit_col = roles["unit_column"]
    cycle_col = roles["cycle_column"]

    checks: list[CheckResult] = []

    # ── 列识别结果(用户要求 5/12:传感器映射来自配置文件)──
    column_mapping = ColumnMapping(
        unit_column=unit_col,
        cycle_column=cycle_col,
        setting_columns=roles["setting_columns"],
        sensor_columns=roles["sensor_columns"],
        selected_sensors=roles["selected_sensors"],
        missing_sensors=[],  # 解析阶段已校验必需列,此处为空
        constant_sensors=get_constant_sensors(),
        all_columns=parsed_data.column_names,
    )

    # ── 列名与格式检查(解析阶段已通过,记录结果)──
    checks.append(CheckResult(
        name="列名与格式检查", passed=True, level="info",
        message=(
            f"FD001 格式校验通过:{df.shape[1]} 列,"
            f"分隔符 {parsed_data.separator},"
            f"{'含' if parsed_data.has_header else '无'}表头"
        ),
        details={
            "separator": parsed_data.separator,
            "has_header": parsed_data.has_header,
            "column_count": df.shape[1],
        },
    ))

    # ── 值级检查 ──
    checks.append(_check_missing_values(df, thresholds))
    checks.append(_check_duplicate_rows(df))
    checks.append(_check_non_numeric(parsed_data))

    # ── 单元级检查 ──
    units_summary, discontinuous_units, insufficient_units = _analyze_units(
        df, unit_col, cycle_col, thresholds["min_cycles"],
    )
    checks.append(_make_continuity_check(discontinuous_units, units_summary))
    checks.append(_make_min_cycles_check(insufficient_units, thresholds["min_cycles"]))

    # ── 假设说明(用户要求 14)──
    assumptions = _generate_assumptions(
        checks, units_summary, discontinuous_units, insufficient_units, thresholds,
    )

    # ── 总体判定 ──
    has_critical = any(c.level == "critical" for c in checks)
    has_error = any(c.level == "error" for c in checks)
    is_valid = not has_critical and not has_error

    return DataQualityReport(
        file_name=parsed_data.file_name,
        file_size_mb=parsed_data.file_size_mb,
        file_empty=False,  # 解析阶段已排除空文件
        total_rows=len(df),
        total_columns=df.shape[1],
        unit_count=len(units_summary),
        column_mapping=column_mapping,
        checks=checks,
        units=units_summary,
        assumptions=assumptions,
        is_valid=is_valid,
        has_critical=has_critical,
    )