# 前后端联调验证脚本
# 模拟前端完整操作流程:上传 → 传感器趋势 → RUL 预测 → 决策 → 回测 → CSV 导出
# 用法:python tests/integration_check.py

import io
import sys

sys.path.insert(0, ".")

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

# ───────── 1. 健康检查 ─────────
r = client.get("/api/health")
assert r.status_code == 200, f"健康检查失败: {r.status_code}"
h = r.json()
print(f"[1] 健康检查 OK: {h['service']} v{h['version']}")

# ───────── 2. 生成合成 FD001 CSV 并上传 ─────────
# 5 个单元 × 100~200 周期,14 个选定传感器含退化趋势
import random
rng = random.Random(42)
lines = []
lifespans = [128, 185, 96, 212, 154]
sensor_bases = {"s2": 642, "s3": 1585, "s4": 1400, "s7": 554, "s8": 2388,
                "s9": 9060, "s11": 47, "s12": 522, "s13": 2388, "s14": 8140,
                "s15": 8.44, "s17": 392, "s20": 38, "s21": 23.4}
const_vals = {"s1": 0.0002, "s5": 14.62, "s6": 21.61, "s10": 1.03,
              "s16": 0.02, "s18": 100.0, "s19": 39.04}
for u, lifespan in enumerate(lifespans, 1):
    for cycle in range(1, lifespan + 1):
        row = [str(u), str(cycle), "0.0", "-0.0", "100.0"]
        for si in range(1, 22):
            name = f"s{si}"
            if name in const_vals:
                row.append(f"{const_vals[name]:.4f}")
            elif name in sensor_bases:
                base = sensor_bases[name]
                val = base + 0.3 * cycle * (0.7 + rng.random() * 0.6) + rng.gauss(0, abs(base) * 0.001)
                row.append(f"{val:.4f}")
            else:
                row.append("0.0")
        lines.append(" ".join(row))
csv_text = "\n".join(lines)
csv_bytes = csv_text.encode("utf-8")
print(f"[2] 合成数据: {len(lifespans)} 单元, {len(lines)} 行, {len(csv_bytes)} 字节")

r = client.post("/api/data/upload", files={"file": ("demo_train.csv", io.BytesIO(csv_bytes), "text/csv")})
assert r.status_code == 200, f"上传失败: {r.status_code} {r.text[:200]}"
upload = r.json()
session_id = upload["session_id"]
overview = upload["overview"]
qr = upload["quality_report"]
print(f"[3] 上传成功: session={session_id}, {overview['unit_count']} 单元, "
      f"{overview['total_rows']} 行, is_valid={qr['is_valid']}")

# ───────── 4. 传感器趋势 ─────────
r = client.get(f"/api/data/sensor-trend?session_id={session_id}&unit_id=1")
assert r.status_code == 200, f"传感器趋势失败: {r.status_code} {r.text[:200]}"
trend = r.json()
assert len(trend["cycles"]) == 128, f"周期数不对: {len(trend['cycles'])}"
assert len(trend["sensor_names"]) == 14
assert "s2" in trend["sensor_data"] and len(trend["sensor_data"]["s2"]) == 128
print(f"[4] 传感器趋势 OK: 单元1, {len(trend['cycles'])} 周期, "
      f"{len(trend['sensor_names'])} 传感器, s2首值={trend['sensor_data']['s2'][0]:.2f}")

# ───────── 5. RUL 概率预测 ─────────
r = client.post("/api/rul/predict", json={
    "session_id": session_id, "unit_id": 1, "k_nn": 20, "random_seed": 42,
})
assert r.status_code == 200, f"RUL 预测失败: {r.status_code} {r.text[:300]}"
rul = r.json()
w = rul["weibull"]
d = rul["discrete"]
assert w["lam"] > 0 and w["k"] > 0
assert len(d["probs"]) == 151
assert abs(sum(d["probs"]) - 1.0) < 1e-5
print(f"[5] RUL 预测 OK: λ={w['lam']:.2f}, k={w['k']:.4f}, "
      f"n_ref={rul['n_reference']}, ΣP={sum(d['probs']):.6f}")

# ───────── 6. 维修决策 ─────────
r = client.post("/api/decision/run", json={
    "probs": d["probs"],
    "params": {"cm": 1, "cd": 5, "cp": 50, "cc": 200, "alpha": 0.01, "h_max": 150},
})
assert r.status_code == 200, f"决策失败: {r.status_code} {r.text[:300]}"
dec = r.json()
etoc = dec["strategies"]["ETO-C"]
ieoc = dec["strategies"]["IEO-C"]
assert etoc["optimal_window"] in dec["windows"]
assert len(dec["windows"]) == 26
print(f"[6] 决策 OK: ETO-C z*={etoc['optimal_window']} E[TC]={etoc['expected_total_cost']:.4f}, "
      f"IEO-C z*={ieoc['optimal_window']} E[TC]={ieoc['expected_total_cost']:.4f}, "
      f"窗口差={ieoc['diff_window_vs_eto']}")

# ───────── 7. 离线回测 ─────────
r = client.post("/api/backtest/run", json={
    "session_id": session_id,
    "config": {
        "data_mode": "offline", "step": 20, "min_cycle": 30,
        "k_nn": 20, "n_repeats": 1, "random_seed": 42,
        "include_points": False,
    },
})
assert r.status_code == 200, f"回测失败: {r.status_code} {r.text[:300]}"
bt = r.json()
print(f"[7] 回测 OK: {bt['n_points']} 时点, {bt['n_units']} 单元, "
      f"has_true_rul={bt['has_true_rul']}, NLL={bt['nll_mean']:.4f}, MAE={bt['mae_mean']:.2f}")
for sn, s in bt["strategies"].items():
    print(f"    {sn}: regret_mean={s['regret_mean']}, ECE={s['ece']}")

# ───────── 8. CSV 导出 ─────────
r = client.post("/api/backtest/export-csv", json={
    "session_id": session_id,
    "config": {"data_mode": "offline", "step": 20, "min_cycle": 30, "k_nn": 20, "random_seed": 42},
})
assert r.status_code == 200, f"CSV 导出失败: {r.status_code}"
csv_out = r.text
header = csv_out.split("\n")[0]
assert "unit_id" in header and "strategy" in header and "regret" in header
n_lines = len([l for l in csv_out.strip().split("\n") if l])
print(f"[8] CSV 导出 OK: {n_lines} 行, 表头={header}")

# ───────── 9. 静态文件可访问性 ─────────
for path in ["/static/index.html", "/static/css/style.css", "/static/js/api.js",
             "/static/js/charts.js", "/static/js/demo-data.js", "/static/js/app.js"]:
    r = client.get(path)
    assert r.status_code == 200, f"静态文件不可访问: {path} → {r.status_code}"
print(f"[9] 静态文件 OK: 6 个文件全部可访问(index.html + css + 4 个 js)")

# ───────── 10. 错误处理 ─────────
r = client.get("/api/data/sensor-trend?session_id=sess_nonexist&unit_id=1")
assert r.status_code == 404, f"不存在会话应返回404: {r.status_code}"
r = client.post("/api/rul/predict", json={"session_id": session_id, "unit_id": 999})
assert r.status_code == 404, f"不存在单元应返回404: {r.status_code}"
print(f"[10] 错误处理 OK: 不存在会话/单元均返回 404")

# ───────── 11. AI Agent 端点(未配置模型时明确报错,不假装成功) ─────────
r = client.post("/api/agent/chat", json={"session_id": session_id, "query": "数据质量怎么样?"})
if r.status_code == 400:
    detail = r.json()["detail"]
    assert detail["code"] == "E4002", f"未配置模型应返回 E4002: {detail.get('code')}"
    print(f"[11] Agent 未配置 OK: 返回 400 E4002(不假装成功),提示设置 MODEL_API_KEY")
else:
    # 已配置模型的环境:验证正常响应结构
    assert r.status_code == 200, f"Agent 调用失败: {r.status_code} {r.text[:300]}"
    agent_body = r.json()
    assert "answer" in agent_body and "tool_calls_log" in agent_body
    print(f"[11] Agent 在线 OK: model={agent_body['model_used']}, "
          f"工具调用 {agent_body['n_rounds']} 轮, answer 前50字={agent_body['answer'][:50]}")

# ───────── 12. Agent 工具直接执行(验证后端计算,不经过 LLM) ─────────
from app.agent.tools import AgentContext, execute_tool
ctx = AgentContext(
    session_id=session_id,
    probs=rul["discrete"]["probs"],
    h_max=rul["discrete"]["h_max"],
    unit_id=1,
    cycle=rul["cycle"],
    current_params=dec["params"],
)
# 12a. inspect_data
inspect_result = execute_tool("inspect_data", ctx, {})
assert inspect_result["unit_count"] == 5 and inspect_result["is_valid"] is True
# 12b. recompute_decision(停机损失翻倍)
recompute_result = execute_tool("recompute_decision", ctx, {"cd": 10})
assert recompute_result["changed_params"] == {"cd": 10}
assert "ETO-C" in recompute_result["decision"]["strategies"]
print(f"[12] Agent 工具 OK: inspect_data 返回 {inspect_result['unit_count']} 单元; "
      f"recompute_decision(cd=10) ETO-C z*={recompute_result['decision']['strategies']['ETO-C']['optimal_window']}")

print("\n═══ 前后端联调全部通过 ═══")