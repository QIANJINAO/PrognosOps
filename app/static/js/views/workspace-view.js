/* ═══════════════════════════════════════════════
   PrognosOps 工作台视图(views/workspace-view.js)
   职责:组织主操作/参数表单/决策摘要/策略对比/依据区五容器;
         状态驱动渲染,输入控件一次构建不重建(防丢焦点)
   挂载:window.PO.workspaceView
   依赖:state.js(PO)、parameters.js(PO.parameters)、
         controllers/analysis.js(PO.analysis)、api.js(API)
   设计约束(施工单 S11):
   - 主操作"分析当前设备";草稿变化显示"重新分析并应用"及未应用字段;
   - 参数网格最小列宽 220px,窄屏单列;每项含中文含义/符号/范围/字段错误;
   - 结论先当前策略/窗口/成本/失效概率/设备时点,再四策略卡片;
   - ETO-C 标"比较基准"与"当前策略";IEO 与 ETO 同窗口只标"与 ETO 窗口相同";
   - "模型可信度"改"优化运行记录";假设/参数/RUL/优化细节放依据区;
   - n_samples 标"参与拟合正样本数"并显示零值数;
   - assumptions 纯文本渲染,含 S00【样本过滤】条;
   - 空态/运行中/失败/过期均有明确操作。
   ═══════════════════════════════════════════════ */
window.PO.workspaceView = (() => {
  'use strict';

  let mounted = false, rootEl = null, unsubscribe = null;
  let lastEvidenceKey = null; // S17:evidencePanel 快照标识,仅变化时重渲染(防展开态重置)

  // ───────── 工具 ─────────
  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');
  function el(id) { return document.getElementById(id); }

  // ───────── 参数定义(中文含义/符号/范围) ─────────
  const PARAM_FIELDS = [
    { key: 'cm',    symbol: 'c_m', label: '计划更换成本', range: '必须大于 0' },
    { key: 'cd',    symbol: 'c_d', label: '停机损失成本', range: '不能为负数' },
    { key: 'cp',    symbol: 'c_p', label: '故障更换成本', range: '必须大于 0' },
    { key: 'cc',    symbol: 'c_c', label: '劣质产出成本', range: '必须大于 0' },
    { key: 'alpha', symbol: 'α',   label: '质量劣化权重', range: '必须在 (0, 1] 范围内' },
  ];
  const STRATEGY_ORDER = ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q'];

  // ───────── 草稿脏判定(draft 与 appliedScenario.params 五字段数值比较) ─────────
  function isDraftDirty(s) {
    const applied = s.appliedScenario;
    if (!applied || !applied.params || !s.draft) return false;
    return PARAM_FIELDS.some(f => Number(s.draft[f.key]) !== Number(applied.params[f.key]));
  }
  function dirtyFields(s) {
    const applied = s.appliedScenario;
    if (!applied || !applied.params || !s.draft) return [];
    return PARAM_FIELDS.filter(f => Number(s.draft[f.key]) !== Number(applied.params[f.key]));
  }

  // 有效预测判定:存在已提交预测且上下文版本匹配(上下文变化后不得复用)
  function hasValidPrediction(s) {
    if (!s.prediction) return false;
    const lastRun = [...s.runs].reverse().find(r => r.kind === 'predict' && r.committedPrediction);
    return !!(lastRun && lastRun.snapshot && lastRun.snapshot.contextRev === s.context.contextRev);
  }

  // 方案过期判定:已应用方案的来源上下文版本与当前不一致
  function isScenarioStale(s) {
    if (!s.appliedScenario) return false;
    return s.appliedScenario._contextRev !== s.context.contextRev;
  }

  // ───────── 参数读取与字段错误渲染 ─────────
  function readParams() {
    const o = {};
    PARAM_FIELDS.forEach(f => { const c = el('ws-param-' + f.key); o[f.key] = c ? c.value : ''; });
    return o;
  }

  function renderParamErrors(v) {
    PARAM_FIELDS.forEach(f => {
      const errEl = el('ws-err-' + f.key);
      const input = el('ws-param-' + f.key);
      const fe = (v.fieldErrors || []).find(e => e.field === f.key);
      if (fe) {
        if (errEl) { errEl.textContent = fe.message; errEl.hidden = false; }
        if (input) input.setAttribute('aria-invalid', 'true');
      } else {
        if (errEl) errEl.hidden = true;
        if (input) input.removeAttribute('aria-invalid');
      }
    });
  }

  function clearParamErrors() {
    PARAM_FIELDS.forEach(f => {
      const errEl = el('ws-err-' + f.key);
      if (errEl) errEl.hidden = true;
      const input = el('ws-param-' + f.key);
      if (input) input.removeAttribute('aria-invalid');
    });
  }

  // ───────── 主状态条(运行中/成功/失败/忙/过期) ─────────
  function setMainStatus(type, msg, err) {
    const bar = el('ws-main-status');
    if (!bar) return;
    bar.className = 'po-status-bar po-status-' + type;
    let text = msg;
    if (err) {
      if (err.detail) text += '\n' + (typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
      if (err.fieldErrors && err.fieldErrors.length) {
        text += '\n' + err.fieldErrors.map(fe => fe.field + ': ' + fe.message).join('; ');
        renderParamErrors({ fieldErrors: err.fieldErrors });
      }
    }
    bar.textContent = text;
    bar.hidden = false;
  }

  function hideMainStatus() {
    const bar = el('ws-main-status');
    if (bar) bar.hidden = true;
  }

  // ───────── 分析执行 ─────────
  async function runAnalysis() {
    const s0 = PO.getState();
    if (!s0.context.sessionId) return;
    if (PO.analysis.isRunning()) return;

    // 参数校验(非法不提交,字段错误在原区域持续可见)
    const v = PO.parameters.validate(readParams());
    renderParamErrors(v);
    if (!v.valid) {
      setMainStatus('error', '参数校验失败,请修正标红字段后重试');
      // S18:聚焦首个错误字段(键盘可访问)
      const firstErr = (v.fieldErrors || [])[0];
      if (firstErr) {
        const firstInput = el('ws-param-' + firstErr.field);
        if (firstInput) firstInput.focus();
      }
      return;
    }

    PO.setDraftParams(v.params);
    hideMainStatus();

    const btn = el('ws-run-btn');
    if (btn) btn.disabled = true;
    setMainStatus('running', '分析进行中,请等待...');

    try {
      const s1 = PO.getState();
      // 草稿变化 + 有效预测 → 重新分析并应用(不重新预测);
      // 首次分析或上下文已变化 → 完整链(预测→决策)
      const useRetry = hasValidPrediction(s1) && isDraftDirty(s1);
      let r;
      if (useRetry) {
        r = await PO.analysis.retryDecision({ params: v.params, useCache: true });
      } else {
        r = await PO.analysis.runCurrent({
          sessionId: s1.context.sessionId,
          unitId: parseInt(el('ws-unit-select').value),
          cycle: el('ws-cycle-input').value.trim() ? parseInt(el('ws-cycle-input').value.trim()) : null,
          k_nn: el('ws-knn-input').value.trim() ? parseInt(el('ws-knn-input').value.trim()) : 50,
          random_seed: el('ws-seed-input').value.trim() ? parseInt(el('ws-seed-input').value.trim()) : null,
          params: v.params,
          useCache: true,
        });
      }
      if (r === null) { setMainStatus('busy', '分析进行中,请等待当前分析完成'); return; }
      if (r.stale) { setMainStatus('busy', '上下文已变化,本次结果已归档,请重新分析'); return; }
      if (r.decisionError) {
        // 预测完成但决策失败(预测已保留,可修正参数后重试)
        setMainStatus('error', '预测完成但决策失败:' + (r.decisionError.message || '请求失败'), r.decisionError);
        return;
      }
      setMainStatus('success', '分析完成,结论与对比已更新');
    } catch (err) {
      setMainStatus('error', '分析失败:' + (err.message || '请求失败'), err);
    } finally {
      if (btn) btn.disabled = false;
      updateRunButton(PO.getState());
    }
  }

  // ───────── 上下文控件变化 → setContext(contextRev 递增,下游失效) ─────────
  function onContextControlChange() {
    const s = PO.getState();
    if (!s.context.sessionId) return;
    PO.setContext({
      unitId: parseInt(el('ws-unit-select').value),
      cycle: el('ws-cycle-input').value.trim() ? parseInt(el('ws-cycle-input').value.trim()) : null,
      predictionConfig: {
        k_nn: el('ws-knn-input').value.trim() ? parseInt(el('ws-knn-input').value.trim()) : 50,
        random_seed: el('ws-seed-input').value.trim() ? parseInt(el('ws-seed-input').value.trim()) : null,
      },
    });
  }

  // 参数输入 → 只改草稿,不动上下文(编辑表单不触发重新分析);
  // 实时校验:仅对已填写字段显示错误(空字段留待提交时校验,避免逐字段填写时误报"不能为空")
  function onParamInput() {
    const raw = readParams();
    PO.setDraftParams(raw);
    const v = PO.parameters.validate(raw);
    const visibleErrors = (v.fieldErrors || []).filter(fe => String(raw[fe.field] ?? '').trim() !== '');
    renderParamErrors({ fieldErrors: visibleErrors });
    updateRunButton(PO.getState());
  }

  // ───────── 渲染:主操作区(空态/就绪切换,不重建输入控件) ─────────
  function renderMainAction(s) {
    const empty = el('ws-empty');
    const ready = el('ws-ready');
    if (!empty || !ready) return;
    if (!s.context.sessionId) {
      empty.hidden = false;
      ready.hidden = true;
      return;
    }
    empty.hidden = true;
    ready.hidden = false;
    updateUnitOptions(s);
    updateRunButton(s);
  }

  // 设备选项更新(选项变化才重建,原选择仍有效则保留)
  function updateUnitOptions(s) {
    const sel = el('ws-unit-select');
    if (!sel) return;
    const ids = s.data.unitIds || [];
    const newVals = ids.map(String);
    const existing = Array.from(sel.options).map(o => o.value);
    if (existing.join(',') === newVals.join(',')) return; // 选项未变不重建
    const current = sel.value;
    sel.innerHTML = newVals.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
    if (current && newVals.indexOf(current) !== -1) sel.value = current;
  }

  // 主按钮状态(文案/禁用/未应用字段提示)
  function updateRunButton(s) {
    const btn = el('ws-run-btn');
    if (!btn) return;
    const running = PO.analysis.isRunning();
    const dirty = isDraftDirty(s);
    const validPred = hasValidPrediction(s);

    btn.disabled = running || !s.context.sessionId;
    if (running) {
      btn.textContent = '分析进行中...';
    } else if (dirty && validPred) {
      btn.textContent = '重新分析并应用';
    } else {
      btn.textContent = '分析当前设备';
    }

    // 未应用字段提示(草稿变化后列出不一致字段)
    const info = el('ws-dirty-info');
    if (!info) return;
    if (dirty && validPred && !running) {
      const names = dirtyFields(s).map(f => f.label + '(' + f.symbol + ')');
      info.textContent = '未应用字段:' + names.join('、');
      info.hidden = false;
    } else {
      info.hidden = true;
    }
  }

  // ───────── 渲染:维修窗口时间轴(当前时点 + 各策略窗口 + ETO-C 推荐高亮) ─────────
  function buildTimeline(dec) {
    // 收集所有策略窗口(数值来自后端 optimal_window)
    const wins = STRATEGY_ORDER
      .map(n => dec.strategies[n])
      .filter(st => st && st.optimal_window != null)
      .map(st => ({ name: st.strategy, win: Number(st.optimal_window) }));
    if (!wins.length) return '';
    const maxWin = Math.max(...wins.map(w => w.win));
    if (maxWin <= 0) return ''; // 全部为 0 时无需时间轴

    // 刻度上限:留 15% 右侧呼吸空间,最右标记不贴边
    const scaleMax = maxWin * 1.15 || 1;
    const pct = v => Math.min(100, (v / scaleMax) * 100);

    // 当前时点标记(位置 0)
    let markers = '<div class="po-tl-marker po-tl-current" style="left:0%">'
      + '<span class="po-tl-dot"></span><span class="po-tl-label">当前时点</span></div>';

    // 各策略窗口标记:ETO-C 高亮为主推荐(z*),其余弱化为参照;同窗口只标一次
    const shown = new Set();
    wins.forEach(w => {
      if (shown.has(w.win)) return;
      shown.add(w.win);
      if (w.win === 0) return; // 0 与当前时点重合,已由当前时点标记表达
      const isOpt = w.name === 'ETO-C';
      markers += '<div class="po-tl-marker ' + (isOpt ? 'po-tl-optimal' : 'po-tl-alt') + '" style="left:' + pct(w.win).toFixed(1) + '%">'
        + '<span class="po-tl-dot"></span>'
        + '<span class="po-tl-label">' + (isOpt ? 'z*=' + esc(String(w.win)) : esc(w.name) + ' ' + esc(String(w.win))) + '</span>'
        + '</div>';
    });

    return '<div class="po-window-timeline" role="img" aria-label="维修窗口时间轴,横轴为周期数">'
      + '<div class="po-tl-track">' + markers + '</div>'
      + '<div class="po-tl-axis"><span>0</span><span>' + esc(String(Math.ceil(maxWin))) + ' 周期</span></div>'
      + '</div>';
  }

  // ───────── 渲染:决策摘要(首屏主角:建议检修时点 + 时间轴 + 指标卡 + 策略卡) ─────────
  function renderSummary(s) {
    const body = el('ws-summary-body');
    if (!body) return;
    const dec = s.appliedScenario;
    if (!dec || !dec.strategies) {
      body.innerHTML = '<div class="po-empty"><p>暂无结论,请先运行分析</p></div>';
      return;
    }

    // 过期提示(上下文已变化,旧方案不冒充当前结果)
    const staleHtml = isScenarioStale(s)
      ? '<div class="po-status-bar po-status-busy">当前方案基于旧上下文(设备/时点已变化),请重新分析</div>'
      : '';

    // 当前策略 = ETO-C(推荐基准);设备与时点取自预测结果
    const cur = dec.strategies['ETO-C'];
    const pred = s.prediction;
    const unitLabel = pred
      ? esc(String(pred.unit_id)) + ' @ ' + esc(String(pred.cycle ?? '—'))
      : '—';

    // 首屏主角结论语:z* 来自后端 optimal_window,0 表示建议当前检修
    const zStar = cur ? Number(cur.optimal_window) : null;
    const heroHtml = (typeof zStar === 'number' && !isNaN(zStar))
      ? (zStar > 0
          ? '<div class="po-hero-text">建议在当前时点后第 <strong class="po-hero-num">' + esc(String(zStar)) + '</strong> 个周期检修</div>'
          : '<div class="po-hero-text">建议<strong class="po-hero-num po-hero-now">当前时点</strong>立即检修</div>')
      : '<div class="po-hero-text">暂无推荐窗口</div>';

    // 维修窗口时间轴(z*>0 时展示,0 时结论语已表达)
    const timelineHtml = (typeof zStar === 'number' && zStar > 0) ? buildTimeline(dec) : '';

    // 关键指标卡:当前策略/期望总成本/失效概率/设备与时点(维修窗口已升级为首屏主角)
    const cards = [
      { label: '当前策略', value: cur ? esc(cur.strategy) : '—' },
      { label: '期望总成本 E[TC]', value: cur ? API.fmtNum(cur.expected_total_cost, 2) : '—' },
      { label: '失效概率 P', value: cur ? API.fmtPct(cur.failure_prob) : '—' },
      { label: '设备与时点', value: unitLabel },
    ];

    // 四策略卡片(ETO-C 标"比较基准"+"当前策略";IEO 与 ETO 同窗口标"与 ETO 窗口相同")
    const cardsHtml = STRATEGY_ORDER.map(name => {
      const st = dec.strategies[name];
      if (!st) return '';
      const badges = [];
      if (name === 'ETO-C') {
        badges.push('<span class="po-badge po-badge-info">比较基准</span>');
        badges.push('<span class="po-badge po-badge-success">当前策略</span>');
      }
      // IEO 与同目标 ETO 窗口相同 → 只标"与 ETO 窗口相同",策略身份不变
      const etoName = name === 'IEO-C' ? 'ETO-C' : (name === 'IEO-Q' ? 'ETO-Q' : null);
      if (etoName && dec.strategies[etoName] && st.optimal_window === dec.strategies[etoName].optimal_window) {
        badges.push('<span class="po-badge po-badge-warning">与 ETO 窗口相同</span>');
      }
      const badgeHtml = badges.length ? '<div class="po-strategy-badges">' + badges.join('') + '</div>' : '';
      return '<div class="po-strategy-card' + (name === 'ETO-C' ? ' po-strategy-baseline' : '') + '">'
        + badgeHtml
        + '<div class="po-strategy-name">' + esc(st.strategy) + '</div>'
        + '<div class="po-strategy-window"><span class="po-number">' + esc(String(st.optimal_window)) + '</span> 周期</div>'
        + '<div class="po-strategy-detail">'
        + '期望总成本 E[TC]=' + API.fmtNum(st.expected_total_cost, 2) + '<br>'
        + '失效概率 P=' + API.fmtPct(st.failure_prob)
        + '</div></div>';
    }).join('');

    body.innerHTML = staleHtml
      + '<div class="po-decision-hero">'
      + '<div class="po-hero-eyebrow">维修决策建议</div>'
      + heroHtml
      + timelineHtml
      + '</div>'
      + '<div class="po-stat-row">' + cards.map(c =>
        '<div class="po-stat-card"><span class="po-stat-label">' + c.label + '</span>'
        + '<span class="po-stat-value">' + c.value + '</span></div>'
      ).join('') + '</div>'
      + '<div class="po-strategy-row" style="margin-top:var(--po-space-4)">' + cardsHtml + '</div>';
  }

  // ───────── 渲染:对比区(11 列对比表) ─────────
  function renderComparison(s) {
    const body = el('ws-comparison-body');
    if (!body) return;
    const dec = s.appliedScenario;
    if (!dec || !dec.strategies) {
      body.innerHTML = '<div class="po-empty"><p>暂无对比数据,请先运行分析</p></div>';
      return;
    }
    const rows = STRATEGY_ORDER.map(name => {
      const st = dec.strategies[name];
      if (!st) return '';
      // ETO-C 行标"比较基准"+"当前策略"
      const tagHtml = name === 'ETO-C'
        ? ' <span class="po-badge po-badge-info">比较基准</span><span class="po-badge po-badge-success">当前策略</span>'
        : '';
      return '<tr>'
        + '<td>' + esc(st.strategy) + tagHtml + '</td>'
        + '<td class="po-num">' + esc(String(st.optimal_window)) + '</td>'
        + '<td class="po-num">' + API.fmtNum(st.objective_value, 4) + '</td>'
        + '<td class="po-num">' + API.fmtNum(st.expected_cost, 4) + '</td>'
        + '<td class="po-num">' + API.fmtNum(st.expected_total_cost, 4) + '</td>'
        + '<td class="po-num">' + API.fmtNum(st.expected_quality, 4) + '</td>'
        + '<td class="po-num">' + API.fmtNum(st.expected_total_quality, 4) + '</td>'
        + '<td class="po-num">' + API.fmtPct(st.failure_prob) + '</td>'
        + '<td class="po-num">' + API.fmtNum(st.expected_life, 2) + '</td>'
        + '<td class="po-num">' + (st.diff_window_vs_eto !== 0 ? esc(String(st.diff_window_vs_eto)) : '—') + '</td>'
        + '<td class="po-num">' + (st.diff_objective_vs_eto !== 0 ? API.fmtNum(st.diff_objective_vs_eto, 4) : '—') + '</td>'
        + '</tr>';
    }).join('');
    body.innerHTML = '<div class="po-table-scroll"><table class="po-table">'
      + '<thead><tr>'
      + '<th>策略</th><th>推荐窗口 z*</th><th>目标值</th><th>E[C1]</th><th>E[TC]</th>'
      + '<th>E[Q1]</th><th>E[TQ]</th><th>失效概率</th><th>期望寿命</th><th>窗口差</th><th>目标差</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // ───────── 渲染:依据区(假设/Weibull/决策参数/优化运行记录) ─────────
  function statCard(label, value) {
    return '<div class="po-stat-card"><span class="po-stat-label">' + label + '</span>'
      + '<span class="po-stat-value">' + value + '</span></div>';
  }
  function traceRow(label, value) {
    return '<div class="po-trace-row"><span>' + label + '</span><span class="po-trace-val">' + value + '</span></div>';
  }

  function renderEvidence(s) {
    const body = el('ws-evidence-body');
    if (!body) return;
    const pred = s.prediction;
    const dec = s.appliedScenario;
    if (!pred && !dec) {
      body.innerHTML = '<div class="po-empty"><p>暂无依据,请先运行分析</p></div>';
      return;
    }

    const sections = [];

    // 假设(纯文本渲染,含 S00【样本过滤】条)
    const assumptions = []
      .concat((pred && pred.assumptions) || [])
      .concat((dec && dec.assumptions) || []);
    if (assumptions.length) {
      sections.push('<h3 class="po-evidence-title">假设</h3>'
        + '<div class="po-evidence-text">' + assumptions.map(a => '<p>' + esc(a) + '</p>').join('') + '</div>');
    }

    // Weibull 拟合参数(n_samples 标"参与拟合正样本数"并显示零值数)
    if (pred && pred.weibull) {
      const w = pred.weibull;
      const zeroNote = (w.n_zero != null && w.n_zero > 0)
        ? '<span class="po-aux">其中 RUL=0 未参与拟合 ' + esc(String(w.n_zero)) + ' 个</span>'
        : '';
      sections.push('<h3 class="po-evidence-title">Weibull 拟合参数</h3>'
        + '<div class="po-stat-row">'
        + statCard('尺度参数 λ', API.fmtNum(w.lam, 2))
        + statCard('形状参数 k', API.fmtNum(w.k, 4))
        + statCard('对数似然', w.log_likelihood != null && Number.isFinite(w.log_likelihood) ? API.fmtNum(w.log_likelihood, 2) : '不可计算')
        + statCard('参与拟合正样本数', esc(String(w.n_samples)) + (zeroNote ? '<br>' + zeroNote : ''))
        + statCard('参考集规模', esc(String(pred.n_reference ?? '—')))
        + '</div>');
    }

    // 决策参数(已应用方案的参数快照)
    if (dec && dec.params) {
      const p = dec.params;
      sections.push('<h3 class="po-evidence-title">决策参数(已应用)</h3>'
        + '<div class="po-stat-row">'
        + statCard('c_m 计划更换', API.fmtNum(p.cm, 2))
        + statCard('c_d 停机损失', API.fmtNum(p.cd, 2))
        + statCard('c_p 故障更换', API.fmtNum(p.cp, 2))
        + statCard('c_c 劣质产出', API.fmtNum(p.cc, 2))
        + statCard('α 质量权重', API.fmtNum(p.alpha, 4))
        + statCard('h_max', esc(String(p.h_max ?? '—')))
        + '</div>');
    }

    // 优化运行记录(IEO 追踪,"模型可信度"改为"优化运行记录")
    if (dec && dec.ieo_traces) {
      const traceNames = Object.keys(dec.ieo_traces);
      if (traceNames.length) {
        const tracesHtml = traceNames.map(tn => {
          const t = dec.ieo_traces[tn];
          return '<div class="po-trace-block">'
            + '<div class="po-trace-title">' + esc(tn)
            + ' <span class="po-badge ' + (t.converged ? 'po-badge-success' : 'po-badge-warning') + '">'
            + (t.converged ? '已收敛' : '未收敛') + '</span></div>'
            + traceRow('初始方案(ETO)', esc(String(t.initial_window)))
            + traceRow('最终 μ', API.fmtNum(t.final_mu, 2))
            + traceRow('最终 σ', API.fmtNum(t.final_sigma, 2))
            + traceRow('实际步数', esc(String(t.n_steps_actual)))
            + traceRow('训练步数/批大小/MC样本', esc(String(t.config.n_steps)) + ' / ' + esc(String(t.config.batch_size)) + ' / ' + esc(String(t.config.mc_samples)))
            + traceRow('随机种子', t.config.random_seed != null ? esc(String(t.config.random_seed)) : '未固定')
            + '</div>';
        }).join('');
        sections.push('<h3 class="po-evidence-title">优化运行记录</h3>' + tracesHtml);
      }
    }

    body.innerHTML = sections.join('');
  }

  // ───────── 渲染:候选方案面板(S17:挂 scenarioPanel,可重复调用) ─────────
  function renderCandidates(s) {
    const root = el('ws-candidates-body');
    if (!root) return;
    PO.scenarioPanel.render(root, s.candidates);
  }

  // ───────── 渲染:依据图表面板(S17:挂 evidencePanel,仅快照变化时重渲染) ─────────
  function renderEvidenceChart(s) {
    const root = el('ws-evidence-chart');
    if (!root) return;
    // 快照标识:方案版本号变化才重渲染(防展开态被 renderAll 重置)
    const key = String(s.context.scenarioRev ?? 'none');
    if (key === lastEvidenceKey) return;
    lastEvidenceKey = key;
    if (!s.appliedScenario) {
      PO.evidencePanel.unmount();
      root.innerHTML = '';
      return;
    }
    // 快照:顶层完整结果(不受 pruneRuns 释放影响)+ 当前上下文
    PO.evidencePanel.render(root, {
      run: { runId: 'scenario-' + key, kind: 'decision' },
      prediction: s.prediction,
      decision: s.appliedScenario,
      context: s.context,
    });
  }

  // ───────── 总渲染(订阅回调,切页不重置) ─────────
  function renderAll(s) {
    renderMainAction(s);
    renderSummary(s);
    renderComparison(s);
    renderCandidates(s);
    renderEvidence(s);
    renderEvidenceChart(s);
  }

  // ═══════════════ 挂载/卸载 ═══════════════

  function mount(root) {
    if (mounted) return; // 防重复挂载
    mounted = true;
    rootEl = root;

    // 参数表单(一次构建,renderAll 不重建输入控件,防丢焦点)
    const paramFormHtml = PARAM_FIELDS.map(f =>
      '<div class="po-field">'
      + '<label class="po-field-label" for="ws-param-' + f.key + '">' + f.label + ' (' + f.symbol + ')</label>'
      + '<input class="po-input" id="ws-param-' + f.key + '" type="text" inputmode="decimal" autocomplete="off" aria-describedby="ws-err-' + f.key + '">'
      + '<span class="po-aux">' + f.range + '</span>'
      + '<span class="po-field-error" id="ws-err-' + f.key + '" hidden></span>'
      + '</div>'
    ).join('');

    rootEl.innerHTML = ''
      + '<div class="po-layout">'
      // S09 契约阅读顺序:主操作→任务→结论→对比→候选方案→依据(扁平化,加 data-area 供 grid 定位)
      + '  <div class="po-panel" data-area="op">'
      + '      <h2 class="po-panel-title">主操作</h2>'
      + '      <div id="ws-main-body">'
      + '        <div id="ws-empty" class="po-empty" hidden>'
      + '          <p>暂无数据,请先导入数据或使用演示数据</p>'
      + '          <div class="po-empty-actions">'
      + '            <button class="po-btn po-btn-primary" id="workspace-import-btn">导入数据</button>'
      + '            <button class="po-btn po-btn-secondary" id="workspace-demo-btn">使用演示数据</button>'
      + '          </div>'
      + '        </div>'
      + '        <div id="ws-ready" hidden>'
      + '          <div class="po-context-controls">'
      + '            <div class="po-field"><label class="po-field-label" for="ws-unit-select">设备单元</label>'
      + '              <select class="po-select" id="ws-unit-select"></select></div>'
      + '            <div class="po-field"><label class="po-field-label" for="ws-cycle-input">预测时点(周期)</label>'
      + '              <input class="po-input" id="ws-cycle-input" type="text" inputmode="numeric" placeholder="留空取最新" autocomplete="off"></div>'
      + '            <div class="po-field"><label class="po-field-label" for="ws-knn-input">kNN 近邻数</label>'
      + '              <input class="po-input" id="ws-knn-input" type="text" inputmode="numeric" value="50" autocomplete="off"></div>'
      + '            <div class="po-field"><label class="po-field-label" for="ws-seed-input">随机种子</label>'
      + '              <input class="po-input" id="ws-seed-input" type="text" inputmode="numeric" placeholder="留空不固定" autocomplete="off"></div>'
      + '          </div>'
      + '          <div class="po-param-grid">' + paramFormHtml + '</div>'
      + '          <div id="ws-dirty-info" class="po-status-bar po-status-busy" hidden></div>'
      + '          <div id="ws-main-status" class="po-status-bar" hidden aria-live="polite"></div>'
      + '          <div class="po-empty-actions" style="margin-top:var(--po-space-4)">'
      + '            <button class="po-btn po-btn-accent" id="ws-run-btn">分析当前设备</button>'
      + '          </div>'
      + '        </div>'
      + '      </div>'
      + '    </div>'
      + '  <div class="po-panel" data-area="task">'
      + '    <h2 class="po-panel-title">任务</h2>'
      + '    <div id="ws-task-body"></div>'
      + '  </div>'
      + '  <div class="po-panel" data-area="concl">'
      + '    <h2 class="po-panel-title">结论</h2>'
      + '    <div id="ws-summary-body"></div>'
      + '  </div>'
      + '  <div class="po-panel" data-area="compare">'
      + '    <h2 class="po-panel-title">对比</h2>'
      + '    <div id="ws-comparison-body"></div>'
      + '  </div>'
      // S17:候选方案面板(挂 scenarioPanel)
      + '  <div class="po-panel" data-area="candidates">'
      + '    <h2 class="po-panel-title">候选方案</h2>'
      + '    <div id="ws-candidates-body"></div>'
      + '  </div>'
      + '  <div class="po-panel" data-area="evidence">'
      + '    <h2 class="po-panel-title">依据</h2>'
      + '    <div id="ws-evidence-body"></div>'
      // S17:依据图表区(挂 evidencePanel)
      + '    <div id="ws-evidence-chart"></div>'
      + '  </div>'
      + '</div>';

    // ── 事件绑定(一次,不随 renderAll 重建) ──
    // 空态按钮 → 数据页
    const impBtn = el('workspace-import-btn');
    if (impBtn) impBtn.addEventListener('click', () => PO.router.navigate('data'));
    const demoBtn = el('workspace-demo-btn');
    if (demoBtn) demoBtn.addEventListener('click', () => PO.router.navigate('data'));

    // 上下文控件变化 → setContext(contextRev 递增,下游失效)
    ['ws-unit-select', 'ws-cycle-input', 'ws-knn-input', 'ws-seed-input'].forEach(id => {
      const c = el(id);
      if (c) c.addEventListener('change', onContextControlChange);
    });

    // 参数输入 → 只改草稿(不动上下文,不触发分析)
    PARAM_FIELDS.forEach(f => {
      const c = el('ws-param-' + f.key);
      if (c) c.addEventListener('input', onParamInput);
    });

    // 主按钮 → 分析
    const runBtn = el('ws-run-btn');
    if (runBtn) runBtn.addEventListener('click', runAnalysis);

    // S12:任务面板挂载 Agent 视图(输入区 + 时间线)
    PO.agentView.mount(el('ws-task-body'));

    // 常驻订阅:状态变化 → 渲染(切页不重置)
    unsubscribe = PO.subscribe(renderAll);
    renderAll(PO.getState());
  }

  function unmount() {
    PO.agentView.unmount(); // S12:先卸载子视图
    PO.evidencePanel.unmount(); // S17:销毁依据图表实例
    lastEvidenceKey = null;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (rootEl) rootEl.innerHTML = '';
    mounted = false;
    rootEl = null;
  }

  return { mount, unmount };
})();