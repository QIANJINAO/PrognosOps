# 数据上传与数据体检模块测试
# 覆盖用户要求的 8 个测试场景:
# 1. 空文件  2. 缺少 unit 列  3. 缺少 cycle 列  4. 缺少传感器列
# 5. 存在缺失值  6. 周期不连续  7. 不足 30 个周期  8. 合法 FD001 数据

import io
import random

import pytest
from fastapi.testclient import TestClient

from app.core.session import clear_sessions
from app.main import app

client = TestClient(app)


# ──────────────────────────────────────────────
# 测试辅助函数
# ──────────────────────────────────────────────

def make_fd001_line(
    unit: int, cycle: int,
    sensor_values: list | None = None,
    setting_values: list | None = None,
    separator: str = " ",
) -> str:
    """生成一行 FD001 格式数据(26 列:unit, cycle, 3 settings, 21 sensors)。"""
    if setting_values is None:
        setting_values = [0.0, 0.0, 100.0]
    if sensor_values is None:
        # 生成有微小变化的传感器值,避免方差为零
        sensor_values = [round(random.uniform(-0.05, 0.05), 6) for _ in range(21)]
    fields = (
        [str(unit), str(cycle)]
        + [str(v) for v in setting_values]
        + [str(v) for v in sensor_values]
    )
    return separator.join(fields)


def upload_csv(content: str, filename: str = "test.csv"):
    """通过 API 上传 CSV 内容,返回响应对象。"""
    return client.post(
        "/api/data/upload",
        files={"file": (filename, io.BytesIO(content.encode("utf-8")), "text/csv")},
    )


@pytest.fixture(autouse=True)
def cleanup_sessions():
    """每个测试前后清理内存会话,避免测试间相互影响。"""
    clear_sessions()
    yield
    clear_sessions()


# ──────────────────────────────────────────────
# 测试 1:空文件
# ──────────────────────────────────────────────

def test_empty_file():
    """上传空文件应返回 400 与 E1001(用户要求 2:检查文件是否为空)。"""
    response = upload_csv("")
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "E1001"
    assert "空" in detail["message"]


# ──────────────────────────────────────────────
# 测试 2:缺少 unit 列
# ──────────────────────────────────────────────

def test_missing_unit_column():
    """有表头但缺少 unit 列(列名为 device)应返回 400 与 E1001,提示缺少 unit。"""
    # 构造有表头的逗号分隔 CSV,unit 列改名为 device
    header = "device,cycle,op_setting1,op_setting2,op_setting3," + ",".join(f"s{i}" for i in range(1, 22))
    row = "1,1,0.0,0.0,100.0," + ",".join("0.01" for _ in range(21))
    content = header + "\n" + row

    response = upload_csv(content)
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "E1001"
    assert "unit" in detail["message"]


# ──────────────────────────────────────────────
# 测试 3:缺少 cycle 列
# ──────────────────────────────────────────────

def test_missing_cycle_column():
    """有表头但缺少 cycle 列(列名为 time)应返回 400 与 E1001,提示缺少 cycle。"""
    header = "unit,time,op_setting1,op_setting2,op_setting3," + ",".join(f"s{i}" for i in range(1, 22))
    row = "1,1,0.0,0.0,100.0," + ",".join("0.01" for _ in range(21))
    content = header + "\n" + row

    response = upload_csv(content)
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "E1001"
    assert "cycle" in detail["message"]


# ──────────────────────────────────────────────
# 测试 4:缺少传感器列
# ──────────────────────────────────────────────

def test_missing_sensor_column():
    """有表头但缺少选定传感器列(仅有 s1~s10)应返回 400 与 E1001,提示缺少传感器。"""
    # 只有 unit, cycle, 3 settings, s1~s10 = 15 列,缺少 s11~s21 中的选定传感器
    header = "unit,cycle,op_setting1,op_setting2,op_setting3," + ",".join(f"s{i}" for i in range(1, 11))
    row = "1,1,0.0,0.0,100.0," + ",".join("0.01" for _ in range(10))
    content = header + "\n" + row

    response = upload_csv(content)
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "E1001"
    assert "传感器" in detail["message"]


# ──────────────────────────────────────────────
# 测试 5:存在缺失值
# ──────────────────────────────────────────────

def test_missing_values():
    """数据中存在缺失值,质量报告应标记缺失值检查不通过,并生成假设说明(用户要求 6/13/14)。"""
    # 逗号分隔有表头,第 10 行的 s2 为空
    header = "unit,cycle,op_setting1,op_setting2,op_setting3," + ",".join(f"s{i}" for i in range(1, 22))
    rows = []
    for cycle in range(1, 36):
        values = [1, cycle, 0.0, 0.0, 100.0] + [0.01] * 21
        if cycle == 10:
            values[6] = ""  # s2 缺失(索引:unit=0, cycle=1, settings=2~4, s1=5, s2=6)
        rows.append(",".join(str(v) for v in values))
    content = header + "\n" + "\n".join(rows)

    response = upload_csv(content)
    assert response.status_code == 200
    report = response.json()["quality_report"]

    # 缺失值检查不通过
    missing_check = next(c for c in report["checks"] if c["name"] == "缺失值检查")
    assert not missing_check["passed"]
    assert missing_check["details"]["total_missing"] > 0

    # 生成缺失值假设说明(用户要求 14:缺少数据时生成明确假设说明)
    assert any("缺失值" in a for a in report["assumptions"])
    # 假设说明中明确声明未做补造(用户要求 13:不静默补造)
    assert any("未" in a and "补造" in a for a in report["assumptions"])


# ──────────────────────────────────────────────
# 测试 6:周期不连续
# ──────────────────────────────────────────────

def test_discontinuous_cycles():
    """某单元周期序列有跳跃,质量报告应标记周期连续性检查不通过(用户要求 9)。"""
    # unit=1, cycle 1~35 但跳过周期 4
    cycles = [c for c in range(1, 36) if c != 4]
    lines = [make_fd001_line(1, c) for c in cycles]
    content = "\n".join(lines)

    response = upload_csv(content)
    assert response.status_code == 200
    report = response.json()["quality_report"]

    # 周期连续性检查不通过
    continuity_check = next(c for c in report["checks"] if c["name"] == "周期连续性检查")
    assert not continuity_check["passed"]
    assert 1 in continuity_check["details"]["discontinuous_units"]

    # 单元摘要中记录缺失周期号
    unit = next(u for u in report["units"] if u["unit_id"] == 1)
    assert 4 in unit["missing_cycles"]
    assert unit["cycle_continuous"] is False

    # 生成周期不连续假设说明(用户要求 14)
    assert any("周期不连续" in a for a in report["assumptions"])


# ──────────────────────────────────────────────
# 测试 7:不足 30 个周期
# ──────────────────────────────────────────────

def test_insufficient_cycles():
    """某单元周期数不足 30,质量报告应标记最少周期数检查不通过,并引用假设 A1(用户要求 10/14)。"""
    # unit=1, 只有 20 个周期
    lines = [make_fd001_line(1, c) for c in range(1, 21)]
    content = "\n".join(lines)

    response = upload_csv(content)
    assert response.status_code == 200
    report = response.json()["quality_report"]

    # 最少周期数检查不通过
    min_check = next(c for c in report["checks"] if c["name"] == "最少周期数检查")
    assert not min_check["passed"]
    assert 1 in min_check["details"]["insufficient_units"]

    # 生成周期不足假设说明,引用工程假设 A1(用户要求 14)
    assert any("周期不足" in a and "A1" in a for a in report["assumptions"])


# ──────────────────────────────────────────────
# 测试 8:合法 FD001 数据
# ──────────────────────────────────────────────

def test_valid_fd001_data():
    """合法 FD001 数据应全部检查通过,返回会话 ID 与完整质量报告(用户要求 11/15)。"""
    # unit=1, cycle 1~35,无表头,空格分隔,26 列,完整连续
    lines = [make_fd001_line(1, c) for c in range(1, 36)]
    content = "\n".join(lines)

    response = upload_csv(content)
    assert response.status_code == 200
    data = response.json()

    # 会话创建成功
    assert data["session_id"].startswith("sess_")

    # 数据概览正确
    overview = data["overview"]
    assert overview["total_rows"] == 35
    assert overview["unit_count"] == 1
    assert overview["columns"] == 26
    assert overview["separator"] == "space"
    assert overview["units"][0]["unit_id"] == 1
    assert overview["units"][0]["cycles"] == 35

    # 质量报告:全部通过,无严重问题
    report = data["quality_report"]
    assert report["is_valid"] is True
    assert report["has_critical"] is False
    assert report["file_empty"] is False
    assert report["total_rows"] == 35
    assert report["unit_count"] == 1

    # 各检查项均通过
    for check in report["checks"]:
        assert check["passed"], f"检查项 {check['name']} 未通过: {check['message']}"

    # 数据完整时无假设说明(用户要求 13:不静默补造)
    assert len(report["assumptions"]) == 0

    # 列识别正确(用户要求 5:识别 unit/cycle/setting/sensor 列)
    mapping = report["column_mapping"]
    assert mapping["unit_column"] == "unit"
    assert mapping["cycle_column"] == "cycle"
    assert len(mapping["setting_columns"]) == 3
    assert len(mapping["sensor_columns"]) == 21
    # 14 个选定传感器来自配置文件(用户要求 12)
    assert len(mapping["selected_sensors"]) == 14
    assert "s2" in mapping["selected_sensors"]
    assert "s21" in mapping["selected_sensors"]
    assert mapping["missing_sensors"] == []