/**
 * S01 行为回归夹具:API 响应对象构造器
 * 字段名严格对应 app/domain/models.py 中的 Pydantic 模型定义
 * 用于 Playwright page.route() 拦截,避免依赖耗时计算或真实 LLM
 */

// ───────── Weibull 拟合结果 ─────────
function makeWeibullFit(overrides = {}) {
  return Object.assign({
    lam: 62.5, k: 2.35, log_likelihood: -128.4,
    n_samples: 48, n_zero: 0, n_negative: 0, n_non_finite: 0,
  }, overrides);
}

// ───────── 离散 RUL 分布 ─────────
function makeDiscreteRUL(hMax = 150, overrides = {}) {
  // 构造单调递减的离散概率分布 P(h),归一化保证和为 1
  const probs = [];
  let total = 0;
  for (let h = 0; h <= hMax; h++) {
    const p = Math.exp(-h / 40) * (h + 1);
    probs.push(p); total += p;
  }
  for (let i = 0; i < probs.length; i++) probs[i] = probs[i] / total;
  // CDF 累积分布
  const cdf = [];
  let acc = 0;
  for (let i = 0; i < probs.length; i++) { acc += probs[i]; cdf.push(acc); }
  cdf[cdf.length - 1] = 1.0; // 防浮点误差
  return Object.assign({ probs, cdf, h_max: hMax, is_normalized: true }, overrides);
}

// ───────── RUL 预测响应 (RULPredictResponse) ─────────
function makeRULResponse(sessionId = 'fx-session-001', unitId = 101, cycle = 40, overrides = {}) {
  return Object.assign({
    session_id: sessionId,
    unit_id: unitId,
    cycle: cycle,
    weibull: makeWeibullFit(),
    discrete: makeDiscreteRUL(),
    n_reference: 120,
    assumptions: ['Weibull MLE 拟合假设失效时间服从两参数威布尔分布', 'kNN 参考集来自同工况历史单元'],
  }, overrides);
}

// ───────── 决策参数 (DecisionParams) ─────────
function makeDecisionParams(overrides = {}) {
  return Object.assign({
    cm: 10.0, cd: 5.0, cp: 100.0, cc: 500.0, alpha: 0.95, h_max: 150,
  }, overrides);
}

// ───────── 单策略结果 (StrategyResult) ─────────
function makeStrategyResult(strategy, optimalWindow, objectiveValue, overrides = {}) {
  return Object.assign({
    strategy: strategy,
    optimal_window: optimalWindow,
    objective_value: objectiveValue,
    expected_cost: 80.0,
    expected_total_cost: 420.0,
    expected_quality: 0.85,
    expected_total_quality: 4.2,
    failure_prob: 0.12,
    expected_life: 55.0,
    diff_window_vs_eto: 0,
    diff_objective_vs_eto: 0.0,
  }, overrides);
}

// ───────── IEO 优化配置 (IEOOptConfig) ─────────
function makeIEOOptConfig(overrides = {}) {
  return Object.assign({
    n_steps: 100, batch_size: 16, mc_samples: 64,
    sigma_init: 5.0, sigma_min: 0.5, sigma_decay: 0.92,
    lr_mu: 0.1, baseline_decay: 0.9, random_seed: 42,
  }, overrides);
}

// ───────── IEO 优化轨迹 (IEOOptTrace) ─────────
function makeIEOOptTrace(initialWindow, finalMu, overrides = {}) {
  return Object.assign({
    config: makeIEOOptConfig(),
    n_steps_actual: 80,
    initial_window: initialWindow,
    final_mu: finalMu,
    final_sigma: 0.6,
    baseline_history: [420.0, 418.5, 416.2, 415.0],
    mu_history: [initialWindow, initialWindow + 1, initialWindow + 2, Math.round(finalMu)],
    converged: true,
  }, overrides);
}

// ───────── 决策响应 (DecisionResult) ─────────
function makeDecisionResponse(params, overrides = {}) {
  const p = params || makeDecisionParams();
  const windows = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125];
  // 构造 6 条曲线(与 windows 等长,数值合理单调)
  const costCurve = windows.map(z => 50 + z * 1.2 + 30 * Math.exp(-z / 30));
  const totalCostCurve = windows.map(z => 200 + z * 2.0 + 150 * Math.exp(-z / 25));
  const qualityCurve = windows.map(z => 0.5 + z * 0.01 - 0.2 * Math.exp(-z / 40));
  const totalQualityCurve = windows.map(z => 2.0 + z * 0.05 - 0.8 * Math.exp(-z / 35));
  const failureProbCurve = windows.map(z => Math.min(1.0, Math.max(0.0, 1 - Math.exp(-z / 45))));
  const expectedLifeCurve = windows.map(z => 60 - z * 0.3);
  return Object.assign({
    params: p,
    windows: windows,
    cost_curve: costCurve,
    total_cost_curve: totalCostCurve,
    quality_curve: qualityCurve,
    total_quality_curve: totalQualityCurve,
    failure_prob_curve: failureProbCurve,
    expected_life_curve: expectedLifeCurve,
    strategies: {
      'ETO-C': makeStrategyResult('ETO-C', 30, 415.0),
      'IEO-C': makeStrategyResult('IEO-C', 32, 410.5, { diff_window_vs_eto: 2, diff_objective_vs_eto: -4.5 }),
      'ETO-Q': makeStrategyResult('ETO-Q', 25, 3.8),
      'IEO-Q': makeStrategyResult('IEO-Q', 27, 3.6, { diff_window_vs_eto: 2, diff_objective_vs_eto: -0.2 }),
    },
    ieo_traces: {
      'IEO-C': makeIEOOptTrace(30, 32),
      'IEO-Q': makeIEOOptTrace(25, 27),
    },
    assumptions: ['折现续跑项假设更换后过程重启', '失效概率由离散 RUL 分布 CDF 计算'],
  }, overrides);
}

// ───────── 回测配置 (BacktestConfig) ─────────
function makeBacktestConfig(overrides = {}) {
  return Object.assign({
    data_mode: 'offline',
    unit_ids: null,
    step: 10,
    min_cycle: 30,
    k_nn: 50,
    h_max: 150,
    n_repeats: 1,
    random_seed: 42,
    decision_params: null,
    ieo_config: null,
    windows: null,
    sensitivity_param: null,
    sensitivity_values: null,
    n_calibration_bins: 10,
    include_points: true,
  }, overrides);
}

// ───────── 单策略回测汇总 (StrategyBacktestSummary) ─────────
function makeStrategyBacktestSummary(strategy, overrides = {}) {
  return Object.assign({
    strategy: strategy,
    n_points: 12,
    regret_mean: 15.3,
    regret_median: 12.0,
    regret_std: 8.5,
    regret_list: [10.0, 12.0, 15.0, 8.0, 20.0, 12.0, 18.0, 14.0, 22.0, 10.0, 16.0, 25.0],
    failure_frequency: 0.25,
    mean_failure_prob: 0.22,
    calibration_bins: [
      { bin_index: 0, bin_low: 0.0, bin_high: 0.1, n_points: 3, mean_predicted: 0.05, observed_freq: 0.0 },
      { bin_index: 1, bin_low: 0.1, bin_high: 0.3, n_points: 4, mean_predicted: 0.2, observed_freq: 0.25 },
      { bin_index: 2, bin_low: 0.3, bin_high: 0.6, n_points: 3, mean_predicted: 0.45, observed_freq: 0.33 },
      { bin_index: 3, bin_low: 0.6, bin_high: 0.9, n_points: 1, mean_predicted: 0.75, observed_freq: 1.0 },
      { bin_index: 4, bin_low: 0.9, bin_high: 1.01, n_points: 1, mean_predicted: 0.95, observed_freq: 1.0 },
    ],
    ece: 0.08,
  }, overrides);
}

// ───────── 回测响应 (BacktestResult) ─────────
function makeBacktestResponse(config, overrides = {}) {
  const cfg = config || makeBacktestConfig();
  return Object.assign({
    config: cfg,
    n_points: 12,
    n_units: 3,
    has_true_rul: true,
    nll_mean: 3.45,
    nll_std: 0.8,
    mae_mean: 12.5,
    mae_std: 4.2,
    strategies: {
      'ETO-C': makeStrategyBacktestSummary('ETO-C'),
      'IEO-C': makeStrategyBacktestSummary('IEO-C', { regret_mean: 12.1 }),
      'ETO-Q': makeStrategyBacktestSummary('ETO-Q'),
      'IEO-Q': makeStrategyBacktestSummary('IEO-Q', { regret_mean: 10.8 }),
    },
    eto_ieo_diff: {
      'C': { target: 'C', window_diff_mean: 2.0, window_diff_std: 1.5, objective_diff_mean: -3.2, objective_diff_std: 2.1, n_ieo_better: 8, n_ieo_worse: 2, n_ieo_same: 2 },
      'Q': { target: 'Q', window_diff_mean: 1.5, window_diff_std: 1.2, objective_diff_mean: -0.15, objective_diff_std: 0.1, n_ieo_better: 7, n_ieo_worse: 3, n_ieo_same: 2 },
    },
    sensitivity: [],
    points: [
      { unit_id: 101, cycle: 40, true_rul: 8, has_true_rul: true, lam: 55.0, k: 2.1, predicted_rul_mean: 48.5, nll: 3.2, mae_point: 40.5, chosen_windows: { 'ETO-C': 30, 'IEO-C': 32 }, failure_probs: { 'ETO-C': 0.15 }, objective_values: { 'ETO-C': 415.0 }, regrets: { 'ETO-C': 10.0 } },
      { unit_id: 102, cycle: 50, true_rul: 15, has_true_rul: true, lam: 68.0, k: 2.5, predicted_rul_mean: 60.2, nll: 2.8, mae_point: 45.2, chosen_windows: { 'ETO-C': 30, 'IEO-C': 32 }, failure_probs: { 'ETO-C': 0.12 }, objective_values: { 'ETO-C': 412.0 }, regrets: { 'ETO-C': 12.0 } },
    ],
    repeat_metrics: [
      { repeat_index: 0, random_seed_used: 42, nll_mean: 3.45, mae_mean: 12.5, regret_mean_by_strategy: { 'ETO-C': 15.3, 'IEO-C': 12.1 }, failure_freq_by_strategy: { 'ETO-C': 0.25, 'IEO-C': 0.2 } },
    ],
    assumptions: ['回测假设各时点独立决策', 'kNN 参考集仅使用历史单元'],
    data_sufficiency_note: '夹具数据仅用于行为回归,统计指标不代表真实性能',
  }, overrides);
}

// ───────── Agent 响应 (AgentChatResponse) ─────────
function makeAgentResponse(question, overrides = {}) {
  return Object.assign({
    answer: `针对问题"${question}"的分析:基于当前 RUL 分布,ETO-C 策略推荐在窗口 30 进行预防性更换,期望总成本 415.0。`,
    tool_calls_log: [
      { tool: 'get_rul_summary', args: { unit_id: 101, cycle: 40 }, result: { mean_rul: 48.5, p_fail: 0.12 }, round: 1 },
      { tool: 'compare_strategies', args: { target: 'C' }, result: { best: 'IEO-C', window: 32, cost: 410.5 }, round: 2 },
    ],
    model_used: 'fixture-mock',
    n_rounds: 2,
  }, overrides);
}

// ───────── 422 业务错误对象(后端 HTTPException 包装) ─────────
// 形状:{"detail": {"code": "E4001", "message": "...", "detail": "..."}}
function makeBusinessError422(code = 'E4001', message = '决策参数无效', detail = 'cm 必须为正数', overrides = {}) {
  return Object.assign({
    detail: { code: code, message: message, detail: detail },
  }, overrides);
}

// ───────── 422 FastAPI 校验错误数组(Pydantic 原生) ─────────
// 形状:{"detail": [{"type": "...", "loc": [...], "msg": "...", "input": ..., ...}]}
function makeFastAPIValidation422(errors = null, overrides = {}) {
  const defaultErrors = [
    { type: 'missing', loc: ['body', 'probs'], msg: 'Field required', input: { session_id: 'fx-001', unit_id: 101 } },
    { type: 'value_error', loc: ['body', 'cycle'], msg: 'value is not a valid integer', input: 'abc', ctx: { error: {} } },
  ];
  return Object.assign({
    detail: errors || defaultErrors,
  }, overrides);
}

module.exports = {
  makeWeibullFit, makeDiscreteRUL, makeRULResponse,
  makeDecisionParams, makeStrategyResult, makeIEOOptConfig, makeIEOOptTrace, makeDecisionResponse,
  makeBacktestConfig, makeStrategyBacktestSummary, makeBacktestResponse,
  makeAgentResponse, makeBusinessError422, makeFastAPIValidation422,
};