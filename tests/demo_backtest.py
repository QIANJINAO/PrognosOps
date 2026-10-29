# 最小演示:离线回测结果(临时脚本,演示后可删除)
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pandas as pd
import numpy as np

from app.core.backtest import run_backtest, export_backtest_csv
from app.domain.models import BacktestConfig

_SELECTED = {2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 17, 20, 21}

# 生成合成 FD001 数据(5 单元,运行至故障)
rng = np.random.default_rng(42)
rows = []
for u in range(1, 6):
    nc = int(rng.integers(80, 150))
    base = float(rng.uniform(80, 120))
    slope = float(rng.uniform(0.1, 0.5))
    for t in range(1, nc + 1):
        row = [u, t, 0.0, 0.0, 0.0]
        for s in range(1, 22):
            if s in _SELECTED:
                row.append(base + slope * t + rng.normal(0, 0.5))
            else:
                row.append(float(rng.uniform(-0.01, 0.01)))
        rows.append(row)
cols = ["unit", "cycle", "op_setting1", "op_setting2", "op_setting3"] + [f"s{i}" for i in range(1, 22)]
df = pd.DataFrame(rows, columns=cols)

# 离线回测(含成本敏感性分析)
config = BacktestConfig(
    data_mode="offline", step=20, min_cycle=30, k_nn=5,
    n_repeats=1, random_seed=42,
    sensitivity_param="cc", sensitivity_values=[100.0, 200.0, 400.0],
)
r = run_backtest(df, config)

print("=== PrognosOps 离线回测最小演示 ===")
print(f"单元数: {r.n_units}  时点数: {r.n_points}  有真实RUL: {r.has_true_rul}")
print(f"NLL均值: {r.nll_mean:.4f}  MAE均值: {r.mae_mean:.4f}")
print()
print("策略       | regret均值 | 失效频率 | 平均预测失效概率 | ECE")
for sn in ["ETO-C", "IEO-C", "ETO-Q", "IEO-Q"]:
    s = r.strategies[sn]
    rm = f"{s.regret_mean:.4f}" if s.regret_mean is not None else "null"
    ff = f"{s.failure_frequency:.4f}" if s.failure_frequency is not None else "null"
    ece = f"{s.ece:.4f}" if s.ece is not None else "null"
    print(f"{sn:10s} | {rm:>10s} | {ff:>8s} | {s.mean_failure_prob:>14.4f} | {ece:>8s}")
print()
print("ETO/IEO 差异:")
for tg in ["C", "Q"]:
    d = r.eto_ieo_diff[tg]
    print(f"  目标{tg}: 窗口差均值={d.window_diff_mean:.1f}  IEO更好={d.n_ieo_better}  更差={d.n_ieo_worse}  相同={d.n_ieo_same}")
print()
print("成本敏感性分析(cc):")
for sp in r.sensitivity:
    etoc = sp.regret_mean_by_strategy.get("ETO-C")
    ieoc = sp.regret_mean_by_strategy.get("IEO-C")
    etoc_s = f"{etoc:.4f}" if etoc is not None else "null"
    ieoc_s = f"{ieoc:.4f}" if ieoc is not None else "null"
    print(f"  cc={sp.param_value:.0f}: ETO-C regret={etoc_s}  IEO-C regret={ieoc_s}")
print()
print(f"数据充分性说明: {r.data_sufficiency_note[:100]}...")
print()
print("CSV 导出(前5行):")
csv = export_backtest_csv(r)
for line in csv.split("\n")[:5]:
    print(f"  {line}")