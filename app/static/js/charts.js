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

  // S14:传感器名→颜色固定映射(同名同色,筛选顺序不换色)
  const SENSOR_COLOR_MAP = {
    s1: '#0891b2', s2: '#059669', s3: '#dc2626', s4: '#d97706', s5: '#7c3aed',
    s6: '#db2777', s7: '#65a30d', s8: '#ea580c', s9: '#4f46e5', s10: '#be185d',
    s11: '#0d9488', s12: '#ca8a04', s13: '#9333ea', s14: '#e11d48', s15: '#059669',
    s16: '#dc2626', s17: '#d97706', s18: '#7c3aed', s19: '#db2777', s20: '#0891b2',
    s21: '#65a30d',
  };
  function sensorColor(name) {
    if (SENSOR_COLOR_MAP[name]) return SENSOR_COLOR_MAP[name];
    // 未知传感器名:按名称哈希取色(同名同色,与筛选顺序无关)
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return SENSOR_COLORS[h % SENSOR_COLORS.length];
  }

  // 策略用色(深色主题:冰蓝=基准/当前,绿=IEO-C,冷灰=ETO-Q,琥珀=IEO-Q)
  const STRATEGY_COLORS = {
    'ETO-C': '#59C7FF', 'IEO-C': '#52C7A5',
    'ETO-Q': '#AABBD0', 'IEO-Q': '#F1B85B',
  };

  // 深色主题图表文字/网格色(与 tokens.css 对齐)
  const THEME = {
    text: '#F3F7FC',      // 主文字:冷白
    secondary: '#AABBD0', // 次级文字
    muted: '#6B7F99',     // 弱化文字
    grid: 'rgba(170, 187, 208, 0.08)', // 极淡网格线
  };

  // 通用默认选项(深色主题:轴/网格/图例统一浅色化)
  const _baseOptions = (extra = {}) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false, // S14:关闭曲线数值插值动效
    plugins: {
      legend: { labels: { font: { size: 11 }, boxWidth: 12, padding: 8, color: THEME.secondary } },
      tooltip: {
        bodyFont: { size: 11 }, titleFont: { size: 12 },
        backgroundColor: '#16263A', titleColor: THEME.text, bodyColor: THEME.secondary,
        borderColor: '#1E3048', borderWidth: 1,
      },
    },
    scales: {
      x: { ticks: { color: THEME.muted }, grid: { color: THEME.grid } },
      y: { ticks: { color: THEME.muted }, grid: { color: THEME.grid } },
    },
    ...extra,
  });

  // ───────── 1. 传感器趋势图(S14:容器化独立小图) ─────────

  // 销毁容器内所有图表实例(键格式 containerId:sensorName)
  function _destroyInContainer(containerId) {
    Object.keys(_instances).forEach(k => {
      if (k === containerId || k.startsWith(containerId + ':')) {
        _instances[k].destroy();
        delete _instances[k];
      }
    });
  }

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  /**
   * S14:传感器趋势改独立小图(每次最多 4 个,独立 y 轴,桌面两列/移动一列)
   * @param {string} containerId - 容器元素 ID(旧页已从 canvas 改为 div)
   * @param {number[]} cycles - 周期序列(SensorTrendResponse.cycles)
   * @param {Object} sensorData - 传感器名→读数数组(SensorTrendResponse.sensor_data)
   * @param {string[]} sensors - 选中的传感器名列表(默认前 4 个有效传感器)
   */
  function sensorTrend(containerId, cycles, sensorData, sensors) {
    const container = document.getElementById(containerId);
    if (!container) return;
    _destroyInContainer(containerId);

    // 有效传感器:有数据的前 4 个(不得把 s9 与 s15 原值叠到同一轴)
    const valid = (sensors || []).filter(s => sensorData[s] && sensorData[s].length);
    const shown = valid.slice(0, 4);

    if (!shown.length) {
      container.classList.remove('po-sensor-grid');
      container.innerHTML = '<div class="po-chart-empty">暂无传感器数据</div>';
      return;
    }

    container.classList.add('po-sensor-grid');
    container.innerHTML = shown.map(s =>
      '<div class="po-sensor-mini">'
      + '<div class="po-sensor-title">' + esc(s) + '</div>'
      + '<canvas></canvas>'
      + '</div>'
    ).join('');

    shown.forEach((s, i) => {
      const canvas = container.querySelectorAll('canvas')[i];
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const color = sensorColor(s);
      _instances[containerId + ':' + s] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: cycles,
          datasets: [{
            label: s,
            data: sensorData[s],
            borderColor: color,
            backgroundColor: color + '20',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.2,
          }],
        },
        options: _baseOptions({
          plugins: { legend: { display: false } },
          scales: {
            x: { title: { display: true, text: '运行周期', font: { size: 10 }, color: THEME.muted }, ticks: { maxTicksLimit: 8, font: { size: 9 }, color: THEME.muted }, grid: { color: THEME.grid } },
            y: { title: { display: true, text: '原始读数', font: { size: 10 }, color: THEME.muted }, ticks: { font: { size: 9 }, color: THEME.muted }, grid: { color: THEME.grid } },
          },
        }),
      });
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
          backgroundColor: 'rgba(82, 199, 165, 0.7)',
          borderColor: '#52C7A5',
          borderWidth: 0.5,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        }],
      },
      options: _baseOptions({
        scales: {
          x: { title: { display: true, text: '剩余使用寿命 h(周期)', font: { size: 11 }, color: THEME.secondary }, ticks: { maxTicksLimit: 16, color: THEME.muted }, grid: { color: THEME.grid } },
          y: { title: { display: true, text: '概率 P(RUL = h)', font: { size: 11 }, color: THEME.secondary }, ticks: { color: THEME.muted }, beginAtZero: true, grid: { color: THEME.grid } },
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
        borderColor: '#59C7FF',
        backgroundColor: 'rgba(89, 199, 255, 0.08)',
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0.2,
        fill: true,
      },
      {
        label: 'E[C1(z)] 单次期望成本',
        data: costCurve,
        borderColor: '#6B7F99',
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
          x: { title: { display: true, text: '维修窗口 z(周期)', font: { size: 11 }, color: THEME.secondary }, ticks: { color: THEME.muted }, grid: { color: THEME.grid } },
          y: { title: { display: true, text: '期望成本', font: { size: 11 }, color: THEME.secondary }, ticks: { color: THEME.muted }, grid: { color: THEME.grid } },
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
            borderColor: '#F07878',
            backgroundColor: 'rgba(240, 120, 120, 0.10)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
            yAxisID: 'yFail',
          },
          {
            label: 'E[L(z)] 期望寿命(周期)',
            data: expectedLifeCurve,
            borderColor: '#52C7A5',
            backgroundColor: 'rgba(82, 199, 165, 0.10)',
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
          x: { title: { display: true, text: '维修窗口 z(周期)', font: { size: 11 }, color: THEME.secondary }, ticks: { color: THEME.muted }, grid: { color: THEME.grid } },
          yFail: {
            type: 'linear', position: 'left',
            title: { display: true, text: '失效概率', font: { size: 11 }, color: '#F07878' },
            ticks: { color: '#F07878' },
            beginAtZero: true,
            grid: { color: THEME.grid },
          },
          yLife: {
            type: 'linear', position: 'right',
            title: { display: true, text: '期望寿命(周期)', font: { size: 11 }, color: '#52C7A5' },
            ticks: { color: '#52C7A5' },
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
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    // S14:无真实 RUL 或无校准 bins 时用文字空态,不画假零柱
    if (!bins || bins.length === 0) {
      if (_instances[canvasId]) { _instances[canvasId].destroy(); delete _instances[canvasId]; }
      canvas.style.display = 'none';
      const parent = canvas.parentElement;
      if (parent) {
        let emptyEl = parent.querySelector('.po-chart-empty');
        if (!emptyEl) {
          emptyEl = document.createElement('div');
          emptyEl.className = 'po-chart-empty';
          parent.appendChild(emptyEl);
        }
        emptyEl.textContent = '无真实 RUL 标签,无法计算校准';
      }
      return;
    }
    // 有 bins:恢复 canvas,移除空态
    canvas.style.display = '';
    const parent = canvas.parentElement;
    if (parent) {
      const emptyEl = parent.querySelector('.po-chart-empty');
      if (emptyEl) emptyEl.remove();
    }
    const ctx = _prepare(canvasId);
    if (!ctx) return;
    const labels = bins.map(b => `${API.fmtNum(b.bin_low, 2)}~${API.fmtNum(b.bin_high, 2)}`);
    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: `${strategyName} 预测失效概率`,
            data: bins.map(b => b.mean_predicted),
            backgroundColor: 'rgba(89, 199, 255, 0.7)',
            borderWidth: 0,
          },
          {
            label: '观测失效频率',
            data: bins.map(b => b.observed_freq),
            backgroundColor: 'rgba(82, 199, 165, 0.7)',
            borderWidth: 0,
          },
        ],
      },
      options: _baseOptions({
        scales: {
          x: { title: { display: true, text: '预测概率分箱', font: { size: 11 }, color: THEME.secondary }, ticks: { maxTicksLimit: 10, font: { size: 9 }, color: THEME.muted }, grid: { color: THEME.grid } },
          y: { title: { display: true, text: '概率 / 频率', font: { size: 11 }, color: THEME.secondary }, ticks: { color: THEME.muted }, beginAtZero: true, max: 1, grid: { color: THEME.grid } },
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
      borderColor: STRATEGY_COLORS[sName] || THEME.secondary,
      backgroundColor: (STRATEGY_COLORS[sName] || THEME.secondary) + '20',
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
          x: { title: { display: true, text: `参数 ${paramName} 取值`, font: { size: 11 }, color: THEME.secondary }, ticks: { color: THEME.muted }, grid: { color: THEME.grid } },
          y: { title: { display: true, text: 'regret 均值', font: { size: 11 }, color: THEME.secondary }, ticks: { color: THEME.muted }, beginAtZero: true, grid: { color: THEME.grid } },
        },
      }),
    });
  }

  // ───────── 实例管理(S06:换数据时销毁全部图表) ─────────

  /** 销毁指定图表实例并清空注册表(S14:兼容容器化多实例键 containerId:sensor) */
  function destroy(canvasId) {
    _destroyInContainer(canvasId);
  }

  /** 销毁所有图表实例(换数据/重置时调用,防止实例积累) */
  function destroyAll() {
    Object.keys(_instances).forEach(id => destroy(id));
  }

  return {
    sensorTrend, rulProbability, costCurve, failLifeCurve,
    calibration, sensitivity, destroy, destroyAll,
  };
})();