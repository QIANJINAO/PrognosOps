/**
 * PrognosOps 主应用逻辑
 * 职责:状态管理 / 标签导航 / 上传 / 体检 / 趋势 / 决策 / 回测 / 智能询问
 * 所有数值来自后端真实计算,不虚构任何数据;无数据时显示空状态提示
 */
const App = (() => {
  'use strict';

  // ───────── 全局状态(仅存后端返回的真实数据) ─────────
  const state = {
    sessionId: null,
    overview: null,        // DataOverview
    qualityReport: null,   // DataQualityReport
    unitIds: [],           // 可用单元 ID 列表
    rulPrediction: null,   // RULPredictResponse
    decisionResult: null,  // DecisionResult
    backtestResult: null,  // BacktestResult
    chatHistory: [],       // Agent 对话历史(最近 20 条)
  };

  // ───────── DOM 工具 ─────────
  const $ = (id) => document.getElementById(id);
  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');
  // HTML 转义:使用字符码构造实体,避免源码中的实体被解码
  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  // ───────── 标签导航 ─────────
  function switchTab(tabName) {
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.toggle('hidden', sec.id !== `view-${tabName}`);
    });
    // 切换到有数据依赖的视图时刷新空状态
    if (tabName === 'quality') refreshQualityView();
    if (tabName === 'trend') refreshTrendView();
    if (tabName === 'decision') refreshDecisionView();
    if (tabName === 'backtest') refreshBacktestView();
  }

  // ───────── 健康检查 ─────────
  async function checkHealth() {
    try {
      const h = await API.health();
      $('health-dot').className = 'w-2 h-2 rounded-full bg-emerald-400';
      $('health-text').textContent = `服务正常 v${h.version}`;
    } catch {
      $('health-dot').className = 'w-2 h-2 rounded-full bg-red-400';
      $('health-text').textContent = '服务不可达';
    }
  }

  // ───────── 上传成功后的统一处理 ─────────
  function onUploadSuccess(data) {
    state.sessionId = data.session_id;
    state.overview = data.overview;
    state.qualityReport = data.quality_report;
    state.unitIds = data.overview.units.map(u => u.unit_id);
    state.rulPrediction = null;
    state.decisionResult = null;
    state.backtestResult = null;

    // 更新会话徽章
    const badge = $('session-badge');
    badge.textContent = state.sessionId;
    show(badge);

    // 渲染上传结果摘要
    const ov = data.overview;
    $('upload-result-content').innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        ${statCard('总行数', ov.total_rows, 'accent')}
        ${statCard('设备单元数', ov.unit_count)}
        ${statCard('数据列数', ov.columns)}
        ${statCard('分隔符', ov.separator)}
      </div>
      <p class="text-sm text-slate-600">会话 ID:<code class="bg-slate-100 px-2 py-0.5 rounded font-mono text-xs">${esc(state.sessionId)}</code></p>`;
    show($('upload-result'));

    API.showToast('success', '上传成功', `${ov.unit_count} 个单元,${ov.total_rows} 行数据已就绪`);
    switchTab('quality');
  }

  // ───────── 视图:数据上传 ─────────
  function initUpload() {
    const dropZone = $('drop-zone');
    const fileInput = $('file-input');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-emerald-500', 'bg-emerald-50/30'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-emerald-500', 'bg-emerald-50/30'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-emerald-500', 'bg-emerald-50/30');
      if (e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) handleFileUpload(fileInput.files[0]);
    });

    // 演示数据按钮
    $('btn-demo').addEventListener('click', () => {
      API.withLoading($('btn-demo'), $('demo-loading'), async () => {
        try {
          const file = DemoData.generateFile(42);
          const data = await API.uploadCsv(file);
          onUploadSuccess(data);
        } catch (err) {
          API.showApiError(err);
        }
      });
    });
  }

  async function handleFileUpload(file) {
    hide($('upload-error'));
    // 前端预校验:文件大小
    if (file.size > 50 * 1024 * 1024) {
      const errEl = $('upload-error');
      errEl.textContent = '文件超过 50MB 限制,请压缩或拆分后上传';
      show(errEl);
      return;
    }
    // 模拟加载状态(禁用上传区域交互)
    const loadingEl = $('upload-loading');
    show(loadingEl);
    dropZoneDisabled(true);
    try {
      const data = await API.uploadCsv(file);
      onUploadSuccess(data);
    } catch (err) {
      const errEl = $('upload-error');
      errEl.textContent = err.message + (err.detail ? `\n${err.detail}` : '');
      show(errEl);
    } finally {
      hide(loadingEl);
      dropZoneDisabled(false);
    }
  }

  function dropZoneDisabled(disabled) {
    $('drop-zone').style.pointerEvents = disabled ? 'none' : '';
    $('drop-zone').style.opacity = disabled ? '0.5' : '';
  }

  // ───────── 视图:数据体检 ─────────
  function refreshQualityView() {
    if (!state.qualityReport) { show($('quality-empty')); hide($('quality-content')); return; }
    hide($('quality-empty')); show($('quality-content'));
    renderQuality();
  }

  function renderQuality() {
    const qr = state.qualityReport;
    // 摘要卡片
    $('quality-summary-cards').innerHTML = [
      statCard('总体判定', qr.is_valid ? '通过' : '未通过', qr.is_valid ? 'accent' : 'error', qr.has_critical ? '存在严重问题' : ''),
      statCard('总行数', qr.total_rows),
      statCard('设备单元数', qr.unit_count),
      statCard('文件大小', API.fmtNum(qr.file_size_mb, 2) + ' MB'),
    ].join('');

    // 检查项
    $('quality-checks').innerHTML = qr.checks.map(c => {
      const passClass = c.passed ? 'pass' : (c.level === 'critical' || c.level === 'error' ? 'fail-critical' : 'fail-warning');
      return `<div class="check-item ${passClass}">
        <div class="flex-1">
          <div class="flex items-center gap-2"><span class="check-name">${esc(c.name)}</span>
          <span class="check-badge ${c.passed ? 'pass' : c.level}">${c.passed ? '通过' : c.level}</span></div>
          <div class="check-msg">${esc(c.message)}</div>
        </div></div>`;
    }).join('');

    // 单元表
    const unitRows = qr.units.map(u => `<tr>
      <td class="num">${u.unit_id}</td><td class="num">${u.cycle_count}</td>
      <td class="num">${u.cycle_min} ~ ${u.cycle_max}</td>
      <td>${u.cycle_continuous ? '<span class="check-badge pass">连续</span>' : '<span class="check-badge warning">不连续</span>'}</td>
      <td>${u.meets_min_cycles ? '<span class="check-badge pass">满足</span>' : '<span class="check-badge error">不足</span>'}</td>
    </tr>`).join('');
    $('quality-units-table').innerHTML = `<thead><tr><th>单元</th><th>周期数</th><th>周期范围</th><th>连续性</th><th>≥30周期</th></tr></thead><tbody>${unitRows}</tbody>`;
    $('quality-units-table').className = 'w-full text-sm data-table';

    // 列识别
    const cm = qr.column_mapping;
    $('quality-columns').innerHTML = `
      <div><span class="text-slate-500">单元列:</span> <code>${esc(cm.unit_column)}</code></div>
      <div><span class="text-slate-500">周期列:</span> <code>${esc(cm.cycle_column)}</code></div>
      <div><span class="text-slate-500">设定列:</span> ${cm.setting_columns.map(esc).join(', ')}</div>
      <div><span class="text-slate-500">选定传感器(14):</span> ${cm.selected_sensors.map(esc).join(', ')}</div>
      ${cm.missing_sensors.length ? `<div class="text-red-600">缺失传感器:${cm.missing_sensors.map(esc).join(', ')}</div>` : ''}
      ${cm.constant_sensors.length ? `<div class="text-amber-600">常量传感器:${cm.constant_sensors.map(esc).join(', ')}</div>` : ''}`;

    // 假设
    $('quality-assumptions').innerHTML = qr.assumptions.map(a => `<div class="assumption-item">${esc(a)}</div>`).join('') || '<p class="text-sm text-slate-400">无假设说明</p>';
  }

  // ───────── 视图:趋势分析 ─────────
  function refreshTrendView() {
    if (!state.sessionId) { show($('trend-empty')); hide($('trend-content')); return; }
    hide($('trend-empty')); show($('trend-content'));
    // 填充单元选择器
    fillUnitSelect($('trend-unit-select'), state.unitIds);
    fillUnitSelect($('rul-unit-select'), state.unitIds);
    // 填充传感器多选(默认全选)
    const sensorSelect = $('trend-sensor-select');
    if (sensorSelect.options.length === 0 && state.qualityReport) {
      const sensors = state.qualityReport.column_mapping.selected_sensors;
      sensors.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s; opt.selected = true;
        sensorSelect.appendChild(opt);
      });
    }
  }

  function fillUnitSelect(select, unitIds) {
    if (select.options.length > 0) return;
    unitIds.forEach(uid => {
      const opt = document.createElement('option');
      opt.value = uid; opt.textContent = `单元 ${uid}`;
      select.appendChild(opt);
    });
  }

  function initTrend() {
    $('btn-trend-load').addEventListener('click', () => {
      API.withLoading($('btn-trend-load'), null, async () => {
        try {
          const unitId = parseInt($('trend-unit-select').value);
          const selected = Array.from($('trend-sensor-select').selectedOptions).map(o => o.value);
          if (selected.length === 0) { API.showToast('warning', '请至少选择一个传感器'); return; }
          const trend = await API.sensorTrend(state.sessionId, unitId);
          Charts.sensorTrend('chart-sensor-trend', trend.cycles, trend.sensor_data, selected);
        } catch (err) { API.showApiError(err); }
      });
    });

    $('btn-rul-predict').addEventListener('click', () => {
      API.withLoading($('btn-rul-predict'), $('rul-loading'), async () => {
        try {
          const payload = {
            session_id: state.sessionId,
            unit_id: parseInt($('rul-unit-select').value),
            k_nn: parseInt($('rul-knn-input').value) || 50,
          };
          const cycleVal = $('rul-cycle-input').value.trim();
          if (cycleVal) payload.cycle = parseInt(cycleVal);
          const seedVal = $('rul-seed-input').value.trim();
          if (seedVal) payload.random_seed = parseInt(seedVal);

          const result = await API.rulPredict(payload);
          state.rulPrediction = result;
          renderRulResult(result);
          API.showToast('success', 'RUL 预测完成', `Weibull λ=${API.fmtNum(result.weibull.lam, 2)}, k=${API.fmtNum(result.weibull.k, 4)}`);
        } catch (err) { API.showApiError(err); }
      });
    });
  }

  function renderRulResult(r) {
    // Weibull 参数卡片
    $('rul-weibull-cards').innerHTML = [
      statCard('尺度参数 λ', API.fmtNum(r.weibull.lam, 2), 'accent', 'Weibull scale'),
      statCard('形状参数 k', API.fmtNum(r.weibull.k, 4), '', 'Weibull shape'),
      statCard('对数似然', API.fmtNum(r.weibull.log_likelihood, 2), '', 'log-likelihood'),
      statCard('拟合样本数', r.weibull.n_samples, '', 'kNN 近邻'),
      statCard('参考集规模', r.n_reference, '', '留一单元法'),
    ].join('');

    // 概率分布图
    Charts.rulProbability('chart-rul-prob', r.discrete.probs, r.discrete.h_max);

    // 假设
    $('rul-assumptions').innerHTML = r.assumptions.map(a => `<div class="assumption-item">${esc(a)}</div>`).join('');
    show($('rul-result'));

    // 解锁决策视图
    refreshDecisionView();
  }

  // ───────── 视图:维修决策 ─────────
  function refreshDecisionView() {
    if (!state.rulPrediction) { show($('decision-empty')); hide($('decision-content')); return; }
    hide($('decision-empty')); show($('decision-content'));
  }

  function initDecision() {
    $('btn-decision-run').addEventListener('click', () => {
      // 参数前端校验(非法不提交)
      const params = validateDecisionParams();
      if (!params) return;

      API.withLoading($('btn-decision-run'), $('decision-loading'), async () => {
        try {
          const payload = {
            probs: state.rulPrediction.discrete.probs,
            params: params,
            use_cache: $('param-use-cache').checked,
          };
          const result = await API.decisionRun(payload);
          state.decisionResult = result;
          renderDecisionResult(result);
          API.showToast('success', '决策分析完成', `ETO-C 推荐窗口 z*=${result.strategies['ETO-C'].optimal_window}`);
        } catch (err) { API.showApiError(err); }
      });
    });

    $('btn-export-decision-json').addEventListener('click', () => {
      if (!state.decisionResult) return;
      API.downloadJson('decision_result.json', state.decisionResult);
      API.showToast('success', '已导出', 'decision_result.json');
    });
  }

  function validateDecisionParams() {
    const errEl = $('decision-param-error');
    hide(errEl);
    const cm = parseFloat($('param-cm').value);
    const cd = parseFloat($('param-cd').value);
    const cp = parseFloat($('param-cp').value);
    const cc = parseFloat($('param-cc').value);
    const alpha = parseFloat($('param-alpha').value);
    const errors = [];
    if (!(cm > 0)) errors.push('cm 必须为正数');
    if (!(cd >= 0)) errors.push('cd 必须为非负数');
    if (!(cp > 0)) errors.push('cp 必须为正数');
    if (!(cc > 0)) errors.push('cc 必须为正数');
    if (!(alpha > 0 && alpha <= 1)) errors.push('alpha 必须在 (0, 1] 范围内');
    if (errors.length > 0) {
      errEl.textContent = '参数校验失败:' + errors.join('；');
      show(errEl);
      return null;
    }
    return { cm, cd, cp, cc, alpha, h_max: state.rulPrediction.discrete.h_max };
  }

  function renderDecisionResult(d) {
    // 四策略卡片(ETO-C 为推荐基准)
    const order = ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q'];
    $('decision-strategy-cards').innerHTML = order.map(name => {
      const s = d.strategies[name];
      if (!s) return '';
      const isRec = name === 'ETO-C';
      return `<div class="strategy-card ${isRec ? 'recommended' : ''}">
        ${isRec ? '<span class="recommend-tag">推荐基准</span>' : ''}
        <div class="strategy-name">${esc(s.strategy)}</div>
        <div class="strategy-window">${s.optimal_window}<span class="unit"> 周期</span></div>
        <div class="strategy-detail">
          期望总成本 E[TC]=${API.fmtNum(s.expected_total_cost, 2)}<br>
          失效概率 P=${API.fmtPct(s.failure_prob)}<br>
          ${s.diff_window_vs_eto !== 0 ? `与ETO窗口差:${s.diff_window_vs_eto}` : 'ETO 基准'}
        </div></div>`;
    }).join('');

    // 成本曲线
    Charts.costCurve('chart-cost-curve', d.windows, d.total_cost_curve, d.cost_curve, d.strategies);
    // 失效概率与寿命
    Charts.failLifeCurve('chart-fail-life', d.windows, d.failure_prob_curve, d.expected_life_curve);

    // 对比表
    const rows = order.map(name => {
      const s = d.strategies[name];
      if (!s) return '';
      return `<tr>
        <td class="font-semibold">${esc(s.strategy)}</td>
        <td class="num">${s.optimal_window}</td>
        <td class="num">${API.fmtNum(s.objective_value, 4)}</td>
        <td class="num">${API.fmtNum(s.expected_cost, 4)}</td>
        <td class="num">${API.fmtNum(s.expected_total_cost, 4)}</td>
        <td class="num">${API.fmtNum(s.expected_quality, 4)}</td>
        <td class="num">${API.fmtNum(s.expected_total_quality, 4)}</td>
        <td class="num">${API.fmtPct(s.failure_prob)}</td>
        <td class="num">${API.fmtNum(s.expected_life, 2)}</td>
        <td class="num">${s.diff_window_vs_eto !== 0 ? s.diff_window_vs_eto : '—'}</td>
        <td class="num">${s.diff_objective_vs_eto !== 0 ? API.fmtNum(s.diff_objective_vs_eto, 4) : '—'}</td>
      </tr>`;
    }).join('');
    $('decision-compare-table').innerHTML = `<thead><tr>
      <th>策略</th><th>推荐窗口 z*</th><th>目标值</th><th>E[C1]</th><th>E[TC]</th>
      <th>E[Q1]</th><th>E[TQ]</th><th>失效概率</th><th>期望寿命</th><th>窗口差</th><th>目标差</th>
    </tr></thead><tbody>${rows}</tbody>`;
    $('decision-compare-table').className = 'w-full text-sm data-table';

    // IEO 追踪(模型可信度)
    const traceNames = Object.keys(d.ieo_traces || {});
    $('decision-ieo-traces').innerHTML = traceNames.length ? traceNames.map(tn => {
      const t = d.ieo_traces[tn];
      return `<div class="ieo-trace-block">
        <div class="trace-title">${esc(tn)} <span class="converged-badge ${t.converged ? 'yes' : 'no'}">${t.converged ? '已收敛' : '未收敛'}</span></div>
        <div class="trace-row"><span>初始方案(ETO)</span><span class="trace-val">${t.initial_window}</span></div>
        <div class="trace-row"><span>最终 μ</span><span class="trace-val">${API.fmtNum(t.final_mu, 2)}</span></div>
        <div class="trace-row"><span>最终 σ</span><span class="trace-val">${API.fmtNum(t.final_sigma, 2)}</span></div>
        <div class="trace-row"><span>实际步数</span><span class="trace-val">${t.n_steps_actual}</span></div>
        <div class="trace-row"><span>训练步数 / 批大小 / MC样本</span><span class="trace-val">${t.config.n_steps} / ${t.config.batch_size} / ${t.config.mc_samples}</span></div>
        <div class="trace-row"><span>随机种子</span><span class="trace-val">${t.config.random_seed ?? '未固定'}</span></div>
      </div>`;
    }).join('') : '<p class="text-sm text-slate-400">无 IEO 追踪数据</p>';

    // 假设
    $('decision-assumptions').innerHTML = d.assumptions.map(a => `<div class="assumption-item">${esc(a)}</div>`).join('');
    show($('decision-result'));
  }

  // ───────── 视图:离线回测 ─────────
  function refreshBacktestView() {
    if (!state.sessionId) { show($('backtest-empty')); hide($('backtest-content')); return; }
    hide($('backtest-empty')); show($('backtest-content'));
  }

  function initBacktest() {
    $('btn-backtest-run').addEventListener('click', () => {
      API.withLoading($('btn-backtest-run'), $('backtest-loading'), async () => {
        try {
          const config = buildBacktestConfig();
          const result = await API.backtestRun({ session_id: state.sessionId, config });
          state.backtestResult = result;
          renderBacktestResult(result);
          API.showToast('success', '回测完成', `${result.n_points} 个时点,${result.n_units} 个单元`);
        } catch (err) { API.showApiError(err); }
      });
    });

    $('btn-backtest-csv').addEventListener('click', () => {
      API.withLoading($('btn-backtest-csv'), $('backtest-loading'), async () => {
        try {
          const config = buildBacktestConfig();
          const csv = await API.backtestExportCsv({ session_id: state.sessionId, config });
          API.downloadText('backtest_result.csv', csv, 'text/csv');
          API.showToast('success', '已导出', 'backtest_result.csv');
        } catch (err) { API.showApiError(err); }
      });
    });
  }

  function buildBacktestConfig() {
    const config = {
      data_mode: $('bt-mode').value,
      step: parseInt($('bt-step').value) || 10,
      min_cycle: parseInt($('bt-min-cycle').value) || 30,
      k_nn: parseInt($('bt-knn').value) || 50,
      n_repeats: parseInt($('bt-repeats').value) || 1,
      n_calibration_bins: parseInt($('bt-bins').value) || 10,
    };
    const seed = $('bt-seed').value.trim();
    if (seed) config.random_seed = parseInt(seed);
    const sensParam = $('bt-sens-param').value;
    if (sensParam) {
      config.sensitivity_param = sensParam;
      // 默认敏感性取值:基准值的 0.5× ~ 2×
      const base = { cm: 1, cd: 5, cp: 50, cc: 200, alpha: 0.01 }[sensParam] || 1;
      config.sensitivity_values = [base * 0.5, base * 0.75, base, base * 1.5, base * 2.0];
    }
    return config;
  }

  function renderBacktestResult(bt) {
    // 摘要卡片
    $('bt-summary-cards').innerHTML = [
      statCard('回测时点数', bt.n_points, 'accent'),
      statCard('回测单元数', bt.n_units),
      statCard('真实RUL', bt.has_true_rul ? '有' : '无', bt.has_true_rul ? 'accent' : 'warn', bt.has_true_rul ? '可计算 regret' : 'regret 不可用'),
      statCard('NLL 均值', bt.nll_mean !== null ? API.fmtNum(bt.nll_mean, 4) : '—', '', bt.nll_std !== null ? `std=${API.fmtNum(bt.nll_std, 4)}` : ''),
      statCard('MAE 均值', bt.mae_mean !== null ? API.fmtNum(bt.mae_mean, 2) : '—', '', bt.mae_std !== null ? `std=${API.fmtNum(bt.mae_std, 2)}` : ''),
    ].join('');

    // 数据充分性说明
    const noteEl = $('bt-sufficiency-note');
    if (bt.data_sufficiency_note) { noteEl.textContent = bt.data_sufficiency_note; show(noteEl); }
    else hide(noteEl);

    // 策略汇总表
    const sNames = Object.keys(bt.strategies);
    $('bt-strategy-table').innerHTML = `<thead><tr>
      <th>策略</th><th>时点数</th><th>regret均值</th><th>regret中位数</th><th>regret标准差</th>
      <th>失效频率</th><th>平均预测失效概率</th><th>ECE</th>
    </tr></thead><tbody>${sNames.map(sn => {
      const s = bt.strategies[sn];
      return `<tr>
        <td class="font-semibold">${esc(s.strategy)}</td>
        <td class="num">${s.n_points}</td>
        <td class="num">${s.regret_mean !== null ? API.fmtNum(s.regret_mean, 4) : '—'}</td>
        <td class="num">${s.regret_median !== null ? API.fmtNum(s.regret_median, 4) : '—'}</td>
        <td class="num">${s.regret_std !== null ? API.fmtNum(s.regret_std, 4) : '—'}</td>
        <td class="num">${s.failure_frequency !== null ? API.fmtPct(s.failure_frequency) : '—'}</td>
        <td class="num">${API.fmtPct(s.mean_failure_prob)}</td>
        <td class="num">${s.ece !== null ? API.fmtNum(s.ece, 4) : '—'}</td>
      </tr>`;
    }).join('')}</tbody>`;
    $('bt-strategy-table').className = 'w-full text-sm data-table';

    // ETO-IEO 差异表
    const diffKeys = Object.keys(bt.eto_ieo_diff);
    $('bt-diff-table').innerHTML = `<thead><tr>
      <th>目标</th><th>窗口差均值</th><th>窗口差标准差</th><th>目标差均值</th><th>目标差标准差</th>
      <th>IEO更优</th><th>IEO更差</th><th>相同</th>
    </tr></thead><tbody>${diffKeys.map(dk => {
      const d = bt.eto_ieo_diff[dk];
      return `<tr>
        <td class="font-semibold">${esc(d.target)}</td>
        <td class="num">${API.fmtNum(d.window_diff_mean, 2)}</td>
        <td class="num">${API.fmtNum(d.window_diff_std, 2)}</td>
        <td class="num">${API.fmtNum(d.objective_diff_mean, 4)}</td>
        <td class="num">${API.fmtNum(d.objective_diff_std, 4)}</td>
        <td class="num text-emerald-600">${d.n_ieo_better}</td>
        <td class="num text-red-600">${d.n_ieo_worse}</td>
        <td class="num">${d.n_ieo_same}</td>
      </tr>`;
    }).join('')}</tbody>`;
    $('bt-diff-table').className = 'w-full text-sm data-table';

    // 校准图(取第一个有校准数据的策略)
    const calStrategy = sNames.find(sn => bt.strategies[sn].calibration_bins.length > 0);
    Charts.calibration('chart-calibration', calStrategy ? bt.strategies[calStrategy].calibration_bins : [], calStrategy || '');

    // 敏感性图
    if (bt.sensitivity && bt.sensitivity.length > 0) {
      show($('bt-sensitivity-section'));
      Charts.sensitivity('chart-sensitivity', bt.sensitivity, bt.config.sensitivity_param || '');
    } else hide($('bt-sensitivity-section'));

    // 假设
    $('bt-assumptions').innerHTML = bt.assumptions.map(a => `<div class="assumption-item">${esc(a)}</div>`).join('');
    show($('backtest-result'));
  }

  // ───────── 视图:智能询问(在线 Agent,降级离线关键词) ─────────
  function initQuery() {
    $('btn-query-submit').addEventListener('click', submitQuery);
    $('query-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuery(); });

    const suggestions = [
      '如果停机损失翻倍会怎样?',
      '如果alpha改为0.02会怎样?',
      '为什么推荐这个维修窗口?',
      '再等一个窗口会多花多少钱?',
      'ETO和IEO有什么差异?',
      '当前结果有哪些假设?',
    ];
    $('query-suggestions').innerHTML = suggestions.map(s =>
      `<button class="suggestion-chip" data-q="${esc(s)}">${esc(s)}</button>`
    ).join('');
    $('query-suggestions').addEventListener('click', (e) => {
      if (e.target.dataset.q) { $('query-input').value = e.target.dataset.q; submitQuery(); }
    });
  }

  async function submitQuery() {
    const q = $('query-input').value.trim();
    if (!q) return;

    const btn = $('btn-query-submit');
    const responseEl = $('query-response');
    const toolsEl = $('query-tools');
    const originalHtml = btn.innerHTML;

    // 构建 Agent 请求(注入当前工作台状态,后端工具执行真实计算)
    const payload = {
      session_id: state.sessionId || '',
      query: q,
      probs: state.rulPrediction ? state.rulPrediction.discrete.probs : [],
      h_max: state.rulPrediction ? state.rulPrediction.discrete.h_max : 150,
      unit_id: state.rulPrediction ? state.rulPrediction.unit_id : null,
      cycle: state.rulPrediction ? state.rulPrediction.cycle : null,
      current_params: state.decisionResult ? state.decisionResult.params : {},
      history: state.chatHistory,
    };

    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="h-4 w-4 animate-spin"></i>思考中...';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    responseEl.innerHTML = '<div class="agent-thinking">AI 助手正在分析问题并调用后端工具计算...</div>';
    hide(toolsEl);
    show(responseEl);

    try {
      const result = await API.agentChat(payload);
      renderAgentResponse(q, result);
      // 更新对话历史(保留最近 20 条)
      state.chatHistory.push({ role: 'user', content: q });
      state.chatHistory.push({ role: 'assistant', content: result.answer });
      if (state.chatHistory.length > 20) state.chatHistory.splice(0, state.chatHistory.length - 20);
    } catch (err) {
      if (err.status === 400 && err.message.includes('E4002')) {
        // 模型未配置:显示配置提示,不假装成功
        renderAgentConfigError(err);
      } else {
        // 模型调用失败:降级为离线关键词匹配,同时告知用户
        const fallback = answerQuery(q);
        renderFallbackResponse(q, fallback, err);
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  /** 渲染 Agent 在线回答 + 工具调用过程 */
  function renderAgentResponse(q, result) {
    const responseEl = $('query-response');
    const toolsEl = $('query-tools');

    // 主回答
    responseEl.innerHTML = `
      <div class="agent-answer">
        <div class="agent-question-label">问:${esc(q)}</div>
        <div class="agent-answer-text">${esc(result.answer).replace(/\n/g, '<br>')}</div>
        <div class="agent-meta">模型:${esc(result.model_used)} | 工具调用:${result.n_rounds} 轮</div>
      </div>`;
    show(responseEl);

    // 工具调用过程(展示真实计算来源,非 LLM 编造)
    if (result.tool_calls_log && result.tool_calls_log.length) {
      const items = result.tool_calls_log.map(tc => {
        const argStr = Object.keys(tc.args || {}).length
          ? Object.entries(tc.args).map(([k, v]) => `${esc(k)}=${esc(String(v))}`).join(', ')
          : '(无参数)';
        const hasResult = tc.result && !tc.result.error;
        const errResult = tc.result && tc.result.error;
        return `<div class="tool-call-item ${errResult ? 'tool-error' : ''}">
          <div class="tool-call-header">
            <i data-lucide="${errResult ? 'alert-circle' : 'check-circle-2'}" class="h-4 w-4"></i>
            <span class="tool-name">${esc(tc.tool)}</span>
            <span class="tool-args">${argStr}</span>
          </div>
          ${hasResult ? `<details class="tool-result-details"><summary>查看结构化结果</summary>
            <pre class="tool-result-json">${esc(JSON.stringify(tc.result, null, 2))}</pre></details>` : ''}
          ${errResult ? `<div class="tool-error-msg">${esc(tc.result.message)}</div>` : ''}
        </div>`;
      }).join('');
      toolsEl.innerHTML = `<div class="tool-calls-title">工具调用记录(数值均由后端计算)</div>${items}`;
      show(toolsEl);
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
      hide(toolsEl);
    }
  }

  /** 渲染模型未配置提示(不假装成功) */
  function renderAgentConfigError(err) {
    const responseEl = $('query-response');
    responseEl.innerHTML = `
      <div class="agent-config-error">
        <div class="agent-error-title">运行时 AI Agent 未配置模型 API</div>
        <div class="agent-error-detail">${esc(err.message)}</div>
        <div class="agent-error-hint">
          配置方法:在后端环境变量中设置以下三个变量,然后重启服务:<br>
          MODEL_BASE_URL=模型 API 地址(OpenAI 兼容,含 /v1)<br>
          MODEL_API_KEY=你的 API Key(仅存在后端,不会出现在前端)<br>
          MODEL_NAME=模型名称(如 gpt-4o-mini)<br><br>
          参见项目根目录 .env.example 文件。
        </div>
      </div>`;
    show(responseEl);
    hide($('query-tools'));
  }

  /** 渲染降级模式回答(离线关键词匹配 + 告知降级原因) */
  function renderFallbackResponse(q, fallback, err) {
    const responseEl = $('query-response');
    responseEl.innerHTML = `
      <div class="agent-fallback">
        <div class="agent-fallback-notice">模型 API 调用失败(${esc(err.message)}),已切换为离线关键词匹配模式:</div>
        <div class="agent-answer-text">${esc(fallback).replace(/\n/g, '<br>')}</div>
      </div>`;
    show(responseEl);
    hide($('query-tools'));
  }

  /** 基于当前工作台状态的关键词匹配回答(数据不足时如实告知) */
  function answerQuery(q) {
    const has = (...keys) => keys.some(k => q.includes(k));

    if (has('质量', '体检', '检查')) {
      if (!state.qualityReport) return '尚未上传数据,无法评估数据质量。请先在"数据上传"页面上传 CSV 或使用演示数据。';
      const qr = state.qualityReport;
      const failed = qr.checks.filter(c => !c.passed);
      return `数据质量总体判定:${qr.is_valid ? '通过' : '未通过'}。\n` +
        `共 ${qr.checks.length} 项检查,${qr.checks.length - failed.length} 项通过,${failed.length} 项未通过。\n` +
        (qr.has_critical ? '存在严重问题,建议检查数据格式。\n' : '') +
        (failed.length ? '未通过项:' + failed.map(c => c.name).join('、') : '全部检查通过。');
    }
    if (has('单元', '设备', '发动机')) {
      if (!state.overview) return '尚未上传数据。请先上传 CSV 文件。';
      return `数据包含 ${state.overview.unit_count} 个设备单元,共 ${state.overview.total_rows} 行。\n` +
        state.overview.units.map(u => `单元 ${u.unit_id}:${u.cycles} 个周期`).join('\n');
    }
    if (has('维修', '窗口', '推荐', '什么时候')) {
      if (!state.decisionResult) return state.rulPrediction ? '已预测 RUL 概率,请在"维修决策"页面运行决策分析。' : '请先在"趋势分析"页面预测 RUL 概率分布。';
      const d = state.decisionResult;
      const etoc = d.strategies['ETO-C'];
      const ieoc = d.strategies['IEO-C'];
      return `基于当前 RUL 分布的推荐维修窗口:\n` +
        `ETO-C(期望总成本最优):${etoc.optimal_window} 周期,E[TC]=${API.fmtNum(etoc.expected_total_cost, 2)},失效概率=${API.fmtPct(etoc.failure_prob)}\n` +
        `IEO-C(改进策略):${ieoc.optimal_window} 周期,E[TC]=${API.fmtNum(ieoc.expected_total_cost, 2)},失效概率=${API.fmtPct(ieoc.failure_prob)}\n` +
        `成本参数:cm=${d.params.cm}, cd=${d.params.cd}, cp=${d.params.cp}, cc=${d.params.cc}, alpha=${d.params.alpha}`;
    }
    if (has('ETO', 'IEO', '差异', '对比', '比较')) {
      if (!state.decisionResult) return '请先运行维修决策分析。';
      const d = state.decisionResult;
      const lines = ['ETO 与 IEO 并排对比:'];
      for (const name of ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q']) {
        const s = d.strategies[name];
        if (s) lines.push(`${name}:z*=${s.optimal_window},目标值=${API.fmtNum(s.objective_value, 4)},与ETO窗口差=${s.diff_window_vs_eto}`);
      }
      return lines.join('\n');
    }
    if (has('回测', 'regret', 'NLL', 'MAE', '校准')) {
      if (!state.backtestResult) return '尚未运行回测。请在"离线回测"页面配置参数并运行。';
      const bt = state.backtestResult;
      let ans = `回测结果:${bt.n_points} 个时点,${bt.n_units} 个单元。\n`;
      ans += bt.has_true_rul ? `NLL 均值=${API.fmtNum(bt.nll_mean, 4)},MAE 均值=${API.fmtNum(bt.mae_mean, 2)}\n` : '无真实 RUL 标签,regret/NLL/MAE 不可计算。\n';
      for (const sn of Object.keys(bt.strategies)) {
        const s = bt.strategies[sn];
        ans += `${sn}:regret均值=${s.regret_mean !== null ? API.fmtNum(s.regret_mean, 4) : '—'},ECE=${s.ece !== null ? API.fmtNum(s.ece, 4) : '—'}\n`;
      }
      if (bt.data_sufficiency_note) ans += `\n${bt.data_sufficiency_note}`;
      return ans;
    }
    if (has('RUL', '寿命', '剩余', 'Weibull', '概率')) {
      if (!state.rulPrediction) return '尚未预测 RUL。请在"趋势分析"页面选择单元并点击"预测 RUL"。';
      const r = state.rulPrediction;
      return `RUL 预测结果(单元 ${r.unit_id},周期 ${r.cycle}):\n` +
        `Weibull 参数:λ=${API.fmtNum(r.weibull.lam, 2)},k=${API.fmtNum(r.weibull.k, 4)}\n` +
        `拟合样本数:${r.weibull.n_samples},参考集规模:${r.n_reference}\n` +
        `离散概率分布已生成(h_max=${r.discrete.h_max},归一化=${r.discrete.is_normalized})。`;
    }
    if (has('假设', '可信度', '收敛')) {
      const all = [];
      if (state.qualityReport) all.push('【数据体检】', ...state.qualityReport.assumptions);
      if (state.rulPrediction) all.push('【RUL 预测】', ...state.rulPrediction.assumptions);
      if (state.decisionResult) all.push('【维修决策】', ...state.decisionResult.assumptions);
      if (state.backtestResult) all.push('【离线回测】', ...state.backtestResult.assumptions);
      if (state.decisionResult && Object.keys(state.decisionResult.ieo_traces).length) {
        for (const [tn, t] of Object.entries(state.decisionResult.ieo_traces)) {
          all.push(`【IEO 可信度·${tn}】${t.converged ? '已收敛' : '未收敛'},实际步数 ${t.n_steps_actual},最终 σ=${API.fmtNum(t.final_sigma, 2)}`);
        }
      }
      return all.length ? all.join('\n') : '尚无假设说明。请先上传数据并执行分析。';
    }
    if (has('导出', '下载', 'JSON', 'CSV')) {
      return '导出方式:\n· 维修决策结果:在"维修决策"页面点击"导出 JSON"\n· 回测结果:在"离线回测"页面点击"导出 CSV"';
    }
    if (has('成本', '期望', '费用')) {
      if (!state.decisionResult) return '请先运行维修决策分析。';
      const d = state.decisionResult;
      const etoc = d.strategies['ETO-C'];
      return `当前成本参数:cm=${d.params.cm}, cd=${d.params.cd}, cp=${d.params.cp}, cc=${d.params.cc}, alpha=${d.params.alpha}\n` +
        `ETO-C 推荐窗口 ${etoc.optimal_window}:单次期望成本 E[C1]=${API.fmtNum(etoc.expected_cost, 4)},期望总成本 E[TC]=${API.fmtNum(etoc.expected_total_cost, 4)}`;
    }
    return '当前为离线问答模式,支持的问题主题:数据质量、设备单元、RUL 预测、维修窗口、成本、ETO/IEO 对比、回测指标、假设说明、导出方式。\n请尝试快捷问题或换一种问法。';
  }

  // ───────── 工具:摘要卡片 HTML ─────────
  function statCard(label, value, variant = '', sub = '') {
    return `<div class="stat-card ${variant}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>`;
  }

  // ───────── 初始化 ─────────
  function init() {
    // 标签导航
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    // 各视图事件绑定
    initUpload();
    initTrend();
    initDecision();
    initBacktest();
    initQuery();
    // 健康检查(立即 + 每 30 秒)
    checkHealth();
    setInterval(checkHealth, 30000);
    // 图标渲染
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());