# 边界条件与错误处理完整测试(20 项)
# 覆盖:数据验证(1-8)、参数验证(9-12)、概率验证(13)、
#       LLM 验证(14-15)、后端异常(16)、在线 regret(17)、
#       前端防重复提交(18)、导出一致性(19)、移动端适配(20)

import io
import random
from unittest.mock import patch

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.core.session import clear_sessions
from app.main import app

client = TestClient(app)


# ──────────────────────────────────────────────
# 测试辅助
# ──────────────────────────────────────────────

SELECTED_SENSORS = [2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 17, 20, 21]


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
        sensor_values = [round(random.uniform(-0.05, 0.05), 6) for _ in range(21)]
    fields = (
        [str(unit), str(cycle)]
        + [str(v) for v in setting_values]
        + [str(v) for v in sensor_values]
    )
    return separator.join(fields)


def make_degradation_csv(
    n_units: int = 3, min_cycles: int = 80, max_cycles: int = 100, seed: int = 42,
) -> str:
    """生成带退化趋势的合法 FD001 CSV(回测需要足够周期与趋势)。"""
    rng = np.random.default_rng(seed)
    lines = []
    for u in range(1, n_units + 1):
        n_cycles = int(rng.integers(min_cycles, max_cycles))
        base = float(rng.uniform(80, 120))
        slope = float(rng.uniform(0.1, 0.4))
        for t in range(1, n_cycles + 1):
            sensors = []
            for s in range(1, 22):
                if s in SELECTED_SENSORS:
                    val = base + slope * t + float(rng.normal(0, 0.5))
                else:
                    val = float(rng.normal(0, 0.01))
                sensors.append(round(val, 6))
            lines.append(make_fd001_line(u, t, sensor_values=sensors))
    return "\n".join(lines)


def upload_csv(content: str, filename: str = "test.csv"):
    """通过 API 上传 CSV 内容。"""
    return client.post(
        "/api/data/upload",
        files={"file": (filename, io.BytesIO(content.encode("utf-8")), "text/csv")},
    )


def upload_and_get_session(content: str | None = None) -> str:
    """上传合法数据并返回 session_id。"""
    if content is None:
        content = make_degradation_csv()
    resp = upload_csv(content)
    assert resp.status_code == 200, f"上传失败: {resp.text}"
    return resp.json()["session_id"]


@pytest.fixture(autouse=True)
def cleanup_sessions():
    """每个测试前后清理内存会话。"""
    clear_sessions()
    yield
    clear_sessions()


# ══════════════════════════════════════════════
# 1-8: 数据验证边界
# ══════════════════════════════════════════════

class TestDataValidation:
    """数据上传与质量检查边界测试。"""

    def test_01_empty_file(self):
        """1. 空文件 → 400 + E1001。"""
        resp = upload_csv("")
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["code"] == "E1001"
        assert "空" in detail["message"]

    def test_02_invalid_file_format(self):
        """2. 错误文件格式(二进制乱码/非 CSV)→ 400 + E1001。"""
        # 传入无法解析为合法 FD001 的内容
        garbage = "这是乱码不是CSV\x00\x01\x02"
        resp = upload_csv(garbage, "bad.bin")
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["code"] == "E1001"

    def test_03_missing_unit_column(self):
        """3. 缺少 unit 列 → 400 + E1001。"""
        header = "device,cycle,op_setting1,op_setting2,op_setting3," + \
            ",".join(f"s{i}" for i in range(1, 22))
        row = "1,1,0.0,0.0,100.0," + ",".join("0.01" for _ in range(21))
        resp = upload_csv(header + "\n" + row)
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["code"] == "E1001"
        assert "unit" in detail["message"].lower()

    def test_04_missing_cycle_column(self):
        """4. 缺少 cycle 列 → 400 + E1001。"""
        header = "unit,time,op_setting1,op_setting2,op_setting3," + \
            ",".join(f"s{i}" for i in range(1, 22))
        row = "1,1,0.0,0.0,100.0," + ",".join("0.01" for _ in range(21))
        resp = upload_csv(header + "\n" + row)
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["code"] == "E1001"
        assert "cycle" in detail["message"].lower()

    def test_05_missing_sensor_column(self):
        """5. 缺少选定传感器列 → 400 + E1001。"""
        # 只提供 unit/cycle/settings,不提供任何传感器
        header = "unit,cycle,op_setting1,op_setting2,op_setting3"
        row = "1,1,0.0,0.0,100.0"
        resp = upload_csv(header + "\n" + row)
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["code"] == "E1001"
        assert "传感器" in detail["message"] or "sensor" in detail["message"].lower()

    def test_06_missing_values(self):
        """6. 缺失值 → 上传成功,质量报告标记缺失值警告。"""
        lines = []
        for t in range(1, 41):
            sensors = [round(random.uniform(-0.05, 0.05), 6) for _ in range(21)]
            if t == 10:
                sensors[1] = None  # 制造一个缺失值
            lines.append(make_fd001_line(1, t, sensor_values=[
                s if s is not None else "" for s in sensors
            ]))
        resp = upload_csv("\n".join(lines))
        assert resp.status_code == 200
        qr = resp.json()["quality_report"]
        missing_check = next(
            (c for c in qr["checks"] if c["name"] == "缺失值检查"), None
        )
        assert missing_check is not None
        assert missing_check["passed"] is False
        assert missing_check["details"]["total_missing"] > 0

    def test_07_duplicate_rows(self):
        """7. 重复行 → 上传成功,质量报告标记重复行警告。"""
        lines = []
        for t in range(1, 41):
            sensors = [round(random.uniform(-0.05, 0.05), 6) for _ in range(21)]
            lines.append(make_fd001_line(1, t, sensor_values=sensors))
        # 复制第 5 行追加到末尾(完全重复)
        lines.append(lines[4])
        resp = upload_csv("\n".join(lines))
        assert resp.status_code == 200
        qr = resp.json()["quality_report"]
        dup_check = next(
            (c for c in qr["checks"] if c["name"] == "重复行检查"), None
        )
        assert dup_check is not None
        assert dup_check["passed"] is False
        assert dup_check["details"]["duplicate_count"] >= 1

    def test_08_discontinuous_cycles(self):
        """8. 周期不连续 → 上传成功,质量报告标记不连续警告。"""
        lines = []
        for t in range(1, 41):
            if t == 15 or t == 16:
                continue  # 跳过周期 15、16 制造不连续
            sensors = [round(random.uniform(-0.05, 0.05), 6) for _ in range(21)]
            lines.append(make_fd001_line(1, t, sensor_values=sensors))
        resp = upload_csv("\n".join(lines))
        assert resp.status_code == 200
        qr = resp.json()["quality_report"]
        cont_check = next(
            (c for c in qr["checks"] if c["name"] == "周期连续性检查"), None
        )
        assert cont_check is not None
        assert cont_check["passed"] is False
        assert len(cont_check["details"]["discontinuous_units"]) > 0


# ══════════════════════════════════════════════
# 9-12: 参数验证边界
# ══════════════════════════════════════════════

class TestParameterValidation:
    """决策参数与数据量边界测试。"""

    def test_09_insufficient_cycles_for_rul(self):
        """9. 数据不足 30 个周期 → RUL 预测返回 422 + E3002。"""
        # 上传只有 20 个周期的数据
        lines = []
        for t in range(1, 21):
            sensors = [round(random.uniform(-0.05, 0.05), 6) for _ in range(21)]
            lines.append(make_fd001_line(1, t, sensor_values=sensors))
        for t in range(1, 21):
            sensors = [round(random.uniform(-0.05, 0.05), 6) for _ in range(21)]
            lines.append(make_fd001_line(2, t, sensor_values=sensors))
        session_id = upload_and_get_session("\n".join(lines))
        resp = client.post("/api/rul/predict", json={
            "session_id": session_id,
            "unit_id": 1,
            "cycle": 20,
        })
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert detail["code"] == "E3002"
        assert "不足" in detail["message"]

    def test_10_invalid_cost_params(self):
        """10. 非法成本参数(cm≤0 / cp≤0 / cc≤0)→ 422。"""
        probs = [0.01] * 150 + [0.0]  # 合法归一化概率(151 维)
        total = sum(probs)
        probs = [p / total for p in probs]
        # cm = 0(必须 > 0)
        resp = client.post("/api/decision/run", json={
            "probs": probs,
            "params": {"cm": 0, "cd": 5, "cp": 50, "cc": 200, "alpha": 0.01, "h_max": 150},
        })
        assert resp.status_code == 422
        # cp = -1(必须 > 0)
        resp = client.post("/api/decision/run", json={
            "probs": probs,
            "params": {"cm": 1, "cd": 5, "cp": -1, "cc": 200, "alpha": 0.01, "h_max": 150},
        })
        assert resp.status_code == 422

    def test_11_alpha_out_of_range(self):
        """11. alpha 不在 (0, 1] 范围内 → 422。"""
        probs = [0.01] * 150 + [0.0]
        total = sum(probs)
        probs = [p / total for p in probs]
        # alpha = 0(必须 > 0)
        resp = client.post("/api/decision/run", json={
            "probs": probs,
            "params": {"cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 0, "h_max": 150},
        })
        assert resp.status_code == 422
        # alpha = 1.5(必须 ≤ 1)
        resp = client.post("/api/decision/run", json={
            "probs": probs,
            "params": {"cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 1.5, "h_max": 150},
        })
        assert resp.status_code == 422

    def test_12_invalid_windows(self):
        """12. 非法维修窗口(空集/负值)→ 422 + E4001。"""
        probs = [0.01] * 150 + [0.0]
        total = sum(probs)
        probs = [p / total for p in probs]
        # 空窗口集合
        resp = client.post("/api/decision/run", json={
            "probs": probs,
            "windows": [],
        })
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "E4001"
        # 含负值的窗口
        resp = client.post("/api/decision/run", json={
            "probs": probs,
            "windows": [-5, 0, 5],
        })
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "E4001"


# ══════════════════════════════════════════════
# 13: 概率归一化验证
# ══════════════════════════════════════════════

class TestProbabilityValidation:
    """概率向量边界测试。"""

    def test_13_unnormalized_probs(self):
        """13. 概率没有归一化(ΣP≠1)→ 422 + E4001。"""
        # 构造和为 2.0 的概率向量
        probs = [0.02] * 100 + [0.0] * 51  # Σ = 2.0
        resp = client.post("/api/decision/run", json={
            "probs": probs,
        })
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert detail["code"] == "E4001"
        assert "归一化" in detail["message"]


# ══════════════════════════════════════════════
# 14-15: LLM 网关验证
# ══════════════════════════════════════════════

class TestLLMGateway:
    """大模型网关边界测试。"""

    def test_14_api_not_configured(self):
        """14. 模型 API 未配置 → 400 + E4002,不假装成功。"""
        with patch.dict("os.environ", {
            "MODEL_API_KEY": "", "MODEL_BASE_URL": "", "MODEL_NAME": "",
        }, clear=False):
            # 需要确保这些变量为空
            import os
            for k in ("MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_NAME",
                       "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"):
                os.environ.pop(k, None)
            resp = client.post("/api/agent/chat", json={
                "session_id": "",
                "query": "测试未配置",
                "probs": [],
                "h_max": 150,
            })
            assert resp.status_code == 400
            detail = resp.json()["detail"]
            assert detail["code"] == "E4002"
            assert "配置" in detail["message"]

    def test_15_api_timeout(self):
        """15. 模型 API 超时 → 502 + E4003。"""
        import httpx
        from app.core.llm_gateway import chat_completion, ChatMessage

        with patch.dict("os.environ", {
            "MODEL_BASE_URL": "https://api.deepseek.com",
            "MODEL_API_KEY": "sk-fake-key-for-timeout-test",
            "MODEL_NAME": "deepseek-chat",
            "MODEL_TIMEOUT": "1",
        }):
            # mock httpx.Client 抛出超时异常
            with patch("httpx.Client") as mock_client_cls:
                mock_client_cls.return_value.__enter__.return_value.post.side_effect = (
                    httpx.TimeoutException("Connection timed out")
                )
                with pytest.raises(Exception) as exc_info:
                    chat_completion([ChatMessage(role="user", content="hi")])
                assert exc_info.value.code == "E4003"
                assert "超时" in exc_info.value.message


# ══════════════════════════════════════════════
# 16: 后端异常处理
# ══════════════════════════════════════════════

class TestBackendException:
    """后端内部异常处理测试。"""

    def test_16_internal_error_returns_500(self):
        """16. 后端异常(决策模块内部错误)→ 500,不返回堆栈泄露。

        注意:Starlette ServerErrorMiddleware 在发送 500 响应后总会重新抛出异常
        (设计行为,用于服务端日志),因此测试用 raise_server_exceptions=False
        的客户端来验证实际返回给用户的响应体。
        """
        probs = [0.01] * 150 + [0.0]
        total = sum(probs)
        probs = [p / total for p in probs]
        # 使用不重新抛出异常的客户端,验证实际返回给用户的 500 响应
        quiet_client = TestClient(app, raise_server_exceptions=False)
        with patch("app.api.routes.run_decision") as mock_run:
            mock_run.side_effect = RuntimeError("模拟内部错误")
            resp = quiet_client.post("/api/decision/run", json={"probs": probs})
            assert resp.status_code == 500
            body = resp.json()
            assert body["code"] == "E9999"
            # 不应在响应中泄露堆栈信息或原始错误消息
            assert "Traceback" not in resp.text
            assert "模拟内部错误" not in resp.text


# ══════════════════════════════════════════════
# 17: 在线模式 regret 为 null
# ══════════════════════════════════════════════

class TestOnlineRegretNull:
    """在线数据 regret 恒为 null(规则 10)。"""

    def test_17_online_regret_is_null(self):
        """17. 在线模式(data_mode=online)→ 所有策略 regret_mean 为 null。"""
        session_id = upload_and_get_session()
        resp = client.post("/api/backtest/run", json={
            "session_id": session_id,
            "config": {
                "data_mode": "online",
                "step": 20,
                "min_cycle": 30,
                "n_repeats": 1,
                "random_seed": 42,
                "include_points": False,
            },
        })
        assert resp.status_code == 200, f"回测失败: {resp.text}"
        result = resp.json()
        for sn in ["ETO-C", "IEO-C", "ETO-Q", "IEO-Q"]:
            strategy = result["strategies"][sn]
            assert strategy["regret_mean"] is None, \
                f"在线模式 {sn} 的 regret_mean 应为 null,实际为 {strategy['regret_mean']}"
            assert strategy["regret_median"] is None
            assert strategy["failure_frequency"] is None


# ══════════════════════════════════════════════
# 18: 前端防重复提交
# ══════════════════════════════════════════════

class TestFrontendDuplicateSubmit:
    """前端防重复提交机制测试(静态分析 JS 源码)。"""

    def test_18_frontend_prevents_duplicate_submit(self):
        """18. 前端重复提交防护:所有异步按钮在请求期间禁用。"""
        import os
        api_js_path = os.path.join(os.path.dirname(__file__), "..", "app", "static", "js", "api.js")
        app_js_path = os.path.join(os.path.dirname(__file__), "..", "app", "static", "js", "app.js")

        with open(api_js_path, encoding="utf-8") as f:
            api_js = f.read()
        with open(app_js_path, encoding="utf-8") as f:
            app_js = f.read()

        # withLoading 工具函数:进入时禁用按钮,完成后恢复
        assert "if (btn.disabled) return" in api_js, \
            "withLoading 缺少防重复提交守卫(if btn.disabled return)"
        assert "btn.disabled = true" in api_js, "withLoading 未在请求前禁用按钮"
        assert "btn.disabled = false" in api_js, "withLoading 未在完成后恢复按钮"

        # Agent 提交按钮:手动禁用/恢复
        assert "btn.disabled = true" in app_js, "submitQuery 未在请求前禁用按钮"
        assert "btn.disabled = false" in app_js, "submitQuery 未在完成后恢复按钮"

        # 上传区域:请求期间禁用交互
        assert "dropZoneDisabled(true)" in app_js, "上传期间未禁用拖放区域"
        assert "dropZoneDisabled(false)" in app_js, "上传完成后未恢复拖放区域"


# ══════════════════════════════════════════════
# 19: 导出数据与页面数据一致
# ══════════════════════════════════════════════

class TestExportConsistency:
    """导出 CSV 与 API 返回数据一致性测试。"""

    def test_19_export_csv_matches_api(self):
        """19. 导出 CSV 数据与 API 返回的回测结果一致。"""
        session_id = upload_and_get_session()
        config = {
            "data_mode": "offline",
            "step": 20,
            "min_cycle": 30,
            "n_repeats": 1,
            "random_seed": 42,
            "include_points": True,
        }
        # 1. API 获取回测 JSON
        resp_json = client.post("/api/backtest/run", json={
            "session_id": session_id, "config": config,
        })
        assert resp_json.status_code == 200
        api_result = resp_json.json()

        # 2. API 获取 CSV 导出
        resp_csv = client.post("/api/backtest/export-csv", json={
            "session_id": session_id, "config": config,
        })
        assert resp_csv.status_code == 200
        csv_text = resp_csv.text
        csv_lines = csv_text.strip().split("\n")
        header = csv_lines[0].split(",")
        assert "strategy" in header, "CSV 缺少 strategy 列"
        assert "chosen_window" in header, "CSV 缺少 chosen_window 列"
        assert "regret" in header, "CSV 缺少 regret 列"

        # 3. 验证 CSV 行数 = API 时点数 × 策略数
        n_points = len(api_result.get("points", []))
        n_strategies = 4
        n_data_rows = len(csv_lines) - 1  # 减去表头
        assert n_data_rows == n_points * n_strategies, \
            f"CSV 数据行数({n_data_rows})≠ 时点数({n_points})×策略数({n_strategies})"

        # 4. 验证 CSV 中每个策略的 chosen_window 与 API 汇总一致
        # 取 ETO-C 策略的窗口值进行抽样比对
        strategy_col = header.index("strategy")
        window_col = header.index("chosen_window")
        unit_col = header.index("unit_id")
        cycle_col = header.index("cycle")
        eto_c_windows_csv = {}
        for line in csv_lines[1:]:
            fields = line.split(",")
            if fields[strategy_col] == "ETO-C":
                key = (int(fields[unit_col]), int(fields[cycle_col]))
                eto_c_windows_csv[key] = int(fields[window_col])

        # 与 API points 中的 ETO-C 窗口比对
        for pt in api_result.get("points", []):
            key = (pt["unit_id"], pt["cycle"])
            if key in eto_c_windows_csv:
                api_window = pt["chosen_windows"]["ETO-C"]
                assert eto_c_windows_csv[key] == api_window, \
                    f"CSV 窗口({eto_c_windows_csv[key]})与 API 窗口({api_window})不一致" \
                    f"(unit={key[0]}, cycle={key[1]})"


# ══════════════════════════════════════════════
# 20: 手机端页面不溢出
# ══════════════════════════════════════════════

class TestMobileViewport:
    """移动端页面适配测试(静态分析 HTML/CSS)。"""

    def test_20_mobile_no_overflow(self):
        """20. 手机端页面不溢出:viewport 元标签 + 响应式 CSS + 防溢出规则。"""
        import os
        html_path = os.path.join(os.path.dirname(__file__), "..", "app", "static", "index.html")
        css_path = os.path.join(os.path.dirname(__file__), "..", "app", "static", "css", "style.css")

        with open(html_path, encoding="utf-8") as f:
            html = f.read()
        with open(css_path, encoding="utf-8") as f:
            css = f.read()

        # 1. viewport 元标签存在(移动端适配基础)
        assert 'name="viewport"' in html, "index.html 缺少 viewport 元标签"
        assert "width=device-width" in html, "viewport 未设置 width=device-width"
        assert "initial-scale=1.0" in html, "viewport 未设置 initial-scale=1.0"

        # 2. 响应式媒体查询存在
        assert "@media (max-width: 640px)" in css, \
            "style.css 缺少移动端媒体查询(@media max-width: 640px)"

        # 3. 全局防溢出:box-sizing: border-box
        assert "box-sizing: border-box" in css, \
            "缺少全局 box-sizing: border-box(防止 padding 撑破容器)"

        # 4. 表格/代码块防溢出:overflow-x: auto
        assert "overflow-x: auto" in css, \
            "缺少 overflow-x: auto(宽表格/代码块在窄屏可横向滚动而非撑破页面)"

        # 5. 长文本换行:word-break 或 white-space 处理
        assert "word-break" in css or "overflow-wrap" in css, \
            "缺少长文本换行规则(word-break/overflow-wrap)"

        # 6. 页面根容器无固定宽度(应使用 max-width 而非 width)
        # 检查不存在 body { width: 1200px } 这类固定宽度
        import re
        fixed_width = re.search(r"body\s*\{[^}]*width\s*:\s*\d{4,}px", css)
        assert fixed_width is None, "body 存在固定大宽度,会导致移动端横向溢出"