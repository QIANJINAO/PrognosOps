/**
 * PrognosOps 图表渲染模块(Chart.js v4)
 * 职责:传感器趋势 / RUL 概率 / 成本曲线 / 失效概率与寿命 / 校准 / 敏感性
 * 所有数据字段严格对应后端响应模型,不虚构任何数值
 */
const Charts = (() => {
  'use strict';

  // 图表实例注册表(canvasId → Chart 实例),重绘前销毁旧实例
  const _instances = {};

  /** 销毁旧图表并返回 canvas 上下文 */
  function _prepare(canvasId) {
    if (_instances[canvasId]) {
      _instances[canvasId].destroy();
      delete _instances[canvasId];
    }
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    return canvas.getContext('2d');
  }

  // 14 个传感器用色板(高区分度,避免蓝色系主导)
  const SENSOR_COLORS = [
    '#059669', '#dc2626', '#d97706', '#7c3aed', '#db2777',
    '#0891b2', '#65a30d', '#ea580c', '#4f46e5', '#be185d',
    '#0d9488', '#ca8a04', '#9333ea', '#e11d48',
  ];

  // 策略用色
  const STRATEGY_COLORS = {
    'ETO-C': '#0f172a', 'IEO-C': '#059669',
    'ETO-Q': '#64748b', 'IEO-Q': '#d97706',
  };

  // 通用默认选项
  const _baseOptions = (extra = {}) => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
      tooltip: { bodyFont: { size: 11 }, titleFont: { size: 12 } },
    },
    ...extra,
  });

  // ───────── 1. 传感器趋势图 ─────────

  /**
   * @param {string} canvasId - canvas 元素 ID
   * @param {number[]} cycles - 周期序列(SensorTrendResponse.cycles)
   * @param {Object} sensorData - 传感器名→读数数组(SensorTrendResponse.sensor_data)
   * @param {string[]} sensors - 选中的传感器名列表
   */
  function sensorTrend(canvasId, cycles, sensorData, sensors) {
    const ctx = _prepare(canvasId);
    if (!ctx) return;
    const datasets = sensors.map((s, i) => ({
      label: s,
      data: sensorData[s] || [],
      borderColor: SENSOR_COLORS[i % SENSOR_COLORS.length],
      backgroundColor: SENSOR_COLORS[i % SENSOR_COLORS.length] + '20',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
    }));
    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels: cycles, datasets },
      options: _baseOptions({
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { title: { display: true, text: '运行周期', font: { size: 11 } }, ticks: { maxTicksLimit: 15 } },
          y: { title: { display: true, text: '传感器读数', font: { size: 11 } } },
        },
        plugins: {
          legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10, padding: 6 } },
          tooltip: { mode: 'index', intersect: false },
        },
      }),
    });
  }

  // ───────── 2. RUL 概率分布图 ─────────

  /**
   * @param {string} canvasId
   * @param {number[]} probs - P(RUL=h), h=0..h_max(DiscreteRULResult.probs)
   * @param {number} hMax - 最大离散 RUL
   */
  function rulProbability(canvasId, probs, hMax) {
    const ctx = _prepare(canvasId);
    if (!ctx) return;
    const labels = Array.from({ length: hMax + 1 }, (_, h) => h);
    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'P(RUL = h)',
          data: probs,
          backgroundColor: '#059669',
          borderColor: '#047857',
          borderWidth: 0.5,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        }],
      },
      options: _baseOptions({
        scales: {
          x: { title: { display: true, text: '剩余使用寿命 h(周期)', font: { size: 11 } }, ticks: { maxTicksLimit: 16 } },
          y: { title: { display: true, text: '概率 P(RUL = h)', font: { size: 11 } }, beginAtZero: true },
        },
        plugins: { legend: { display: false } },
      }),
    });
  }

  // ───────── 3. 维修窗口成本曲线 ─────────

  /**
   * @param {string} canvasId
   * @param {number[]} windows - 候选窗口 Z(DecisionResult.windows)
   * @param {number[]} totalCostCurve - E[TC(z)](DecisionResult.total_cost_curve)
   * @param {number[]} costCurve - E[C1(z)](DecisionResult.cost_curve)
   * @param {Object} strategies - DecisionResult.strategies(用于标注最优点)
   */
  function costCurve(canvasId, windows, totalCostCurve, costCurve, strategies) {
    const ctx = _prepare(canvasId);
    if (!ctx) return;
    const datasets = [
      {
        label: 'E[TC(z)] 期望总成本',
        data: totalCostCurve,
        borderColor: '#0f172a',
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0.2,
      },
      {
        label: 'E[C1(z)] 单次期望成本',
        data: costCurve,
        borderColor: '#94a3b8',
        borderWidth: 1.5,
        borderDash: [5, 3],
        pointRadius: 0,
        tension: 0.2,
      },
    ];
    // 标注 ETO-C 和 IEO-C 的最优点
    ['ETO-C', 'IEO-C'].forEach(sName => {
      const s = strategies[sName];
      if (!s) return;
      const idx = windows.indexOf(s.optimal_window);
      if (idx < 0) return;
      datasets.push({
        label: `${sName} 最优 z*=${s.optimal_window}`,
        data: windows.map((_, i) => (i === idx ? totalCostCurve[i] : null)),
        borderColor: STRATEGY_COLORS[sName],
        backgroundColor: STRATEGY_COLORS[sName],
        pointRadius: 6,
        pointHoverRadius: 8,
        showLine: false,
      });
    });
    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels: windows, datasets },
      options: _baseOptions({
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { title: { display: true, text: '维修窗口 z(周期)', font: { size: 11 } } },
          y: { title: { display: true, text: '期望成本', font: { size: 11 } } },
        },
      }),
    });
  }

  // ───────── 4. 失效概率与期望寿命曲线(双 Y 轴) ─────────

  /**
   * @param {string} canvasId
   * @param {number[]} windows - DecisionResult.windows
   * @param {number[]} failureProbCurve - P(RUL<z)(DecisionResult.failure_prob_curve)
   * @param {number[]} expectedLifeCurve - E[L(z)](DecisionResult.expected_life_curve)
   */
  function failLifeCurve(canvasId, windows, failureProbCurve, expectedLifeCurve) {
    const ctx = _prepare(canvasId);
    if (!ctx) return;
    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: windows,
        datasets: [
          {
            label: 'P(RUL < z) 失效概率',
            data: failureProbCurve,
            borderColor: '#dc2626',
            backgroundColor: '#dc262620',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
            yAxisID: 'yFail',
          },
          {
            label: 'E[L(z)] 期望寿命(周期)',
            data: expectedLifeCurve,
            borderColor: '#059669',
            backgroundColor: '#05966920',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
            yAxisID: 'yLife',
          },
        ],
      },
      options: _baseOptions({
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { title: { display: true, text: '维修窗口 z(周期)', font: { size: 11 } } },
          yFail: {
            type: 'linear', position: 'left',
            title: { display: true, text: '失效概率', font: { size: 11 }, color: '#dc2626' },
            ticks: { color: '#dc2626' },
            beginAtZero: true,
          },
          yLife: {
            type: 'linear', position: 'right',
            title: { display: true, text: '期望寿命(周期)', font: { size: 11 }, color: '#059669' },
            ticks: { color: '#059669' },
            beginAtZero: true,
            grid: { drawOnChartArea: false },
          },
        },
      }),
    });
  }

  // ───────── 5. 校准图(预测失效概率 vs 观测失效频率) ─────────

  /**
   * @param {string} canvasId
   * @param {Object[]} bins - CalibrationBin[](StrategyBacktestSummary.calibration_bins)
   *   每项:{bin_index, bin_low, bin_high, n_points, mean_predicted, observed_freq}
   * @param {string} strategyName - 策略名(图例标注)
   */
  function calibration(canvasId, bins, strategyName) {
    const ctx = _prepare(canvasId);
    if (!ctx) return;
    if (!bins || bins.length === 0) {
      // 无真实 RUL 时无法计算校准,显示空状态
      _instances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: { labels: ['无数据'], datasets: [{ label: '无真实 RUL 标签,无法计算校准', data: [0], backgroundColor: '#e2e8f0' }] },
        options: _baseOptions({ plugins: { legend: { display: false } } }),
      });
      return;
    }
    const labels = bins.map(b => `${API.fmtNum(b.bin_low, 2)}~${API.fmtNum(b.bin_high, 2)}`);
    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: `${strategyName} 预测失效概率`,
            data: bins.map(b => b.mean_predicted),
            backgroundColor: '#64748b',
            borderWidth: 0,
          },
          {
            label: '观测失效频率',
            data: bins.map(b => b.observed_freq),
            backgroundColor: '#059669',
            borderWidth: 0,
          },
        ],
      },
      options: _baseOptions({
        scales: {
          x: { title: { display: true, text: '预测概率分箱', font: { size: 11 } }, ticks: { maxTicksLimit: 10, font: { size: 9 } } },
          y: { title: { display: true, text: '概率 / 频率', font: { size: 11 } }, beginAtZero: true, max: 1 },
        },
      }),
    });
  }

  // ───────── 6. 成本敏感性分析图 ─────────

  /**
   * @param {string} canvasId
   * @param {Object[]} sensitivity - SensitivityPoint[](BacktestResult.sensitivity)
   *   每项:{param_name, param_value, regret_mean_by_strategy}
   * @param {string} paramName - 参数名(横轴标题)
   */
  function sensitivity(canvasId, sensitivity, paramName) {
    const ctx = _prepare(canvasId);
    if (!ctx) return;
    if (!sensitivity || sensitivity.length === 0) return;
    const labels = sensitivity.map(p => API.fmtNum(p.param_value, 2));
    const strategyNames = Object.keys(sensitivity[0].regret_mean_by_strategy || {});
    const datasets = strategyNames.map(sName => ({
      label: sName,
      data: sensitivity.map(p => p.regret_mean_by_strategy[sName]),
      borderColor: STRATEGY_COLORS[sName] || '#64748b',
      backgroundColor: (STRATEGY_COLORS[sName] || '#64748b') + '20',
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.2,
    }));
    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: _baseOptions({
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { title: { display: true, text: `参数 ${paramName} 取值`, font: { size: 11 } } },
          y: { title: { display: true, text: 'regret 均值', font: { size: 11 } }, beginAtZero: true },
        },
      }),
    });
  }

  return {
    sensorTrend, rulProbability, costCurve, failLifeCurve,
    calibration, sensitivity,
  };
})();