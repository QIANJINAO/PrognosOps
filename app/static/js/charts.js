/**
 * PrognosOps 图表渲染模块(Chart.js v4)
 * 职责:传感器趋势 / RUL 概率 / 成本曲线 / 失效概率与寿命 / 校准 / 敏感性
 * 所有数据字段严格对应后端响应模型,不虚构任何数值
 * 深色主题清晰度规范:刻度/图例 ≥12px、轴标题 13px、曲线 2~2.5px、
 * 提示框浅色文字 + 可辨边框;_baseOptions 对 plugins/scales 深合并,
 * 子图覆盖 legend/scales 不再丢失公共 tooltip/刻度主题。
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

  // 14 个传感器用色板(深色主题提亮至 400 级亮度,深海军蓝底上高对比可辨)
  const SENSOR_COLORS = [
    '#34D399', '#F87171', '#FBBF24', '#A78BFA', '#F472B6',
    '#22D3EE', '#A3E635', '#FB923C', '#818CF8', '#E879F9',
    '#2DD4BF', '#FACC15', '#C084FC', '#FB7185',
  ];

  // S14:传感器名→颜色固定映射(同名同色,筛选顺序不换色)
  const SENSOR_COLOR_MAP = {
    s1: '#22D3EE', s2: '#34D399', s3: '#F87171', s4: '#FBBF24', s5: '#A78BFA',
    s6: '#F472B6', s7: '#A3E635', s8: '#FB923C', s9: '#818CF8', s10: '#E879F9',
    s11: '#2DD4BF', s12: '#FACC15', s13: '#C084FC', s14: '#FB7185', s15: '#34D399',
    s16: '#F87171', s17: '#FBBF24', s18: '#A78BFA', s19: '#F472B6', s20: '#22D3EE',
    s21: '#A3E635',
  };
  function sensorColor(name) {
    if (SENSOR_COLOR_MAP[name]) return SENSOR_COLOR_MAP[name];
    // 未知传感器名:按名称哈希取色(同名同色,与筛选顺序无关)
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return SENSOR_COLORS[h % SENSOR_COLORS.length];
  }

  // 策略用色(浅色主题:深蓝=基准/当前,深绿=IEO-C,中灰=ETO-Q,深琥珀=IEO-Q)
  const STRATEGY_COLORS = {
    'ETO-C': '#2B8FD4', 'IEO-C': '#38A169',
    'ETO-Q': '#718096', 'IEO-Q': '#C68A2E',
  };

  // 浅色主题图表文字/网格色(与 tokens.css 白底对齐)
  const THEME = {
    text: '#1A2332',        // 主文字:深蓝黑
    secondary: '#4A5568',   // 次级文字:图例/轴标题
    muted: '#718096',       // 刻度文字:中灰
    grid: 'rgba(113, 128, 150, 0.20)', // 网格线:可见但克制
    tooltipBg: '#FFFFFF',   // 提示框底色:纯白
    tooltipBorder: '#CBD5E0', // 提示框边框:浅灰
  };

  // 字号规范:刻度/图例 ≥12px,轴标题 13px,提示框标题 13/正文 12
  const FONT = {
    tick: 12, legend: 12, axisTitle: 13, tooltipTitle: 13, tooltipBody: 12,
  };

  // ───────── 配置合并工具(修复浅展开覆盖公共主题的缺陷) ─────────

  /** 深合并:嵌套对象逐键合并,避免子图整体覆盖公共 plugins/scales */
  function _mergeDeep(base, extra) {
    const out = Object.assign({}, base);
    Object.keys(extra || {}).forEach(k => {
      const bv = base[k], ev = extra[k];
      if (ev && typeof ev === 'object' && !Array.isArray(ev)
          && bv && typeof bv === 'object' && !Array.isArray(bv)) {
        out[k] = _mergeDeep(bv, ev);
      } else {
        out[k] = ev;
      }
    });
    return out;
  }

  /**
   * scales 合并:仅合并子图显式给出的刻度 ID,
   * 不把基础 y 强加给双 Y 轴图(yFail/yLife),避免出现空闲坐标轴。
   */
  function _mergeScales(baseScales, extraScales) {
    if (!extraScales) return baseScales;
    const out = {};
    Object.keys(extraScales).forEach(id => {
      out[id] = (baseScales[id] && typeof baseScales[id] === 'object')
        ? _mergeDeep(baseScales[id], extraScales[id])
        : extraScales[id];
    });
    return out;
  }

  // 窄屏判定:移动端减少刻度数量,避免 12px 刻度互相挤压
  function _isNarrow() {
    return (window.innerWidth || 1024) <= 640;
  }
  function _xTickLimit(desktop, mobile) {
    return _isNarrow() ? mobile : desktop;
  }

  // 通用默认选项(深色主题:轴/网格/图例/提示框统一浅色化)
  // plugins 与 scales 深合并:子图覆盖 legend.display 或自定义 scales 时,
  // 公共 tooltip 主题与刻度字号/颜色不再丢失。
  const _baseOptions = (extra = {}) => {
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // S14:关闭曲线数值插值动效
      plugins: {
        legend: {
          labels: { font: { size: FONT.legend }, boxWidth: 14, padding: 10, color: THEME.secondary },
        },
        tooltip: {
          titleFont: { size: FONT.tooltipTitle },
          bodyFont: { size: FONT.tooltipBody },
          backgroundColor: THEME.tooltipBg,
          titleColor: THEME.text,
          bodyColor: THEME.secondary,
          borderColor: THEME.tooltipBorder,
          borderWidth: 1,
          padding: 10,
          cornerRadius: 6,
        },
      },
      scales: {
        x: { ticks: { color: THEME.muted, font: { size: FONT.tick } }, grid: { color: THEME.grid } },
        y: { ticks: { color: THEME.muted, font: { size: FONT.tick } }, grid: { color: THEME.grid } },
      },
    };
    if (!extra || !Object.keys(extra).length) return base;
    const out = Object.assign({}, base);
    if (extra.plugins) out.plugins = _mergeDeep(base.plugins, extra.plugins);
    if (extra.scales) out.scales = _mergeScales(base.scales, extra.scales);
    // 其余顶级键(interaction 等)浅覆盖
    Object.keys(extra).forEach(k => {
      if (k !== 'plugins' && k !== 'scales') out[k] = extra[k];
    });
    return out;
  };

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
            borderWidth: 2,       // 提亮配色下加粗至 2px,小图更清晰
            pointRadius: 0,
            pointHitRadius: 8,    // 无标记点时仍可悬停查值
            tension: 0.2,
          }],
        },
        options: _baseOptions({
          plugins: { legend: { display: false } },
          scales: {
            x: {
              title: { display: true, text: '运行周期', font: { size: FONT.axisTitle }, color: THEME.secondary },
              ticks: { maxTicksLimit: _xTickLimit(8, 5), color: THEME.muted },
              grid: { color: THEME.grid },
            },
            y: {
              title: { display: true, text: '原始读数', font: { size: FONT.axisTitle }, color: THEME.secondary },
              ticks: { maxTicksLimit: 5, color: THEME.muted },
              grid: { color: THEME.grid },
            },
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
          backgroundColor: 'rgba(56, 161, 105, 0.70)',
          borderColor: '#38A169',
          borderWidth: 1,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        }],
      },
      options: _baseOptions({
        scales: {
          x: {
            title: { display: true, text: '剩余使用寿命 h(周期)', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { maxTicksLimit: _xTickLimit(16, 8), color: THEME.muted },
            grid: { color: THEME.grid },
          },
          y: {
            title: { display: true, text: '概率 P(RUL = h)', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { color: THEME.muted },
            beginAtZero: true,
            grid: { color: THEME.grid },
          },
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
        borderColor: '#2B8FD4',
        backgroundColor: 'rgba(43, 143, 212, 0.12)',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHitRadius: 8,
        tension: 0.2,
        fill: true,
      },
      {
        label: 'E[C1(z)] 单次期望成本',
        data: costCurve,
        borderColor: THEME.secondary, // 虚线在白底上可辨
        borderWidth: 2,
        borderDash: [5, 3],
        pointRadius: 0,
        pointHitRadius: 8,
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
        pointHoverRadius: 9,
        showLine: false,
      });
    });
    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels: windows, datasets },
      options: _baseOptions({
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            title: { display: true, text: '维修窗口 z(周期)', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { color: THEME.muted },
            grid: { color: THEME.grid },
          },
          y: {
            title: { display: true, text: '期望成本', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { color: THEME.muted },
            grid: { color: THEME.grid },
          },
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
            borderColor: '#E53E3E',
            backgroundColor: 'rgba(229, 62, 62, 0.12)',
            borderWidth: 2.5,
            pointRadius: 0,
            pointHitRadius: 8,
            tension: 0.2,
            yAxisID: 'yFail',
          },
          {
            label: 'E[L(z)] 期望寿命(周期)',
            data: expectedLifeCurve,
            borderColor: '#38A169',
            backgroundColor: 'rgba(56, 161, 105, 0.12)',
            borderWidth: 2.5,
            pointRadius: 0,
            pointHitRadius: 8,
            tension: 0.2,
            yAxisID: 'yLife',
          },
        ],
      },
      options: _baseOptions({
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            title: { display: true, text: '维修窗口 z(周期)', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { color: THEME.muted },
            grid: { color: THEME.grid },
          },
          yFail: {
            type: 'linear', position: 'left',
            title: { display: true, text: '失效概率', font: { size: FONT.axisTitle }, color: '#E53E3E' },
            ticks: { color: '#E53E3E' },
            beginAtZero: true,
            grid: { color: THEME.grid },
          },
          yLife: {
            type: 'linear', position: 'right',
            title: { display: true, text: '期望寿命(周期)', font: { size: FONT.axisTitle }, color: '#38A169' },
            ticks: { color: '#38A169' },
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
            backgroundColor: 'rgba(43, 143, 212, 0.70)',
            borderWidth: 1,
            borderColor: '#2B8FD4',
          },
          {
            label: '观测失效频率',
            data: bins.map(b => b.observed_freq),
            backgroundColor: 'rgba(56, 161, 105, 0.70)',
            borderWidth: 1,
            borderColor: '#38A169',
          },
        ],
      },
      options: _baseOptions({
        scales: {
          x: {
            title: { display: true, text: '预测概率分箱', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { maxTicksLimit: _xTickLimit(10, 5), color: THEME.muted },
            grid: { color: THEME.grid },
          },
          y: {
            title: { display: true, text: '概率 / 频率', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { color: THEME.muted },
            beginAtZero: true, max: 1,
            grid: { color: THEME.grid },
          },
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
      borderWidth: 2.5,
      pointRadius: 3,
      pointHoverRadius: 6,
      pointHitRadius: 8,
      tension: 0.2,
    }));
    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: _baseOptions({
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            title: { display: true, text: `参数 ${paramName} 取值`, font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { color: THEME.muted },
            grid: { color: THEME.grid },
          },
          y: {
            title: { display: true, text: 'regret 均值', font: { size: FONT.axisTitle }, color: THEME.secondary },
            ticks: { color: THEME.muted },
            beginAtZero: true,
            grid: { color: THEME.grid },
          },
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

  /** 强制重算尺寸:页面从隐藏切回可见后调用,确保 canvas 不停留在 0 尺寸 */
  function resizeAll() {
    Object.keys(_instances).forEach(id => {
      try { _instances[id].resize(); } catch (_) { /* 实例已销毁则忽略 */ }
    });
  }

  return {
    sensorTrend, rulProbability, costCurve, failLifeCurve,
    calibration, sensitivity, destroy, destroyAll, resizeAll,
    THEME, SENSOR_COLORS, SENSOR_COLOR_MAP, STRATEGY_COLORS,
  };
})();