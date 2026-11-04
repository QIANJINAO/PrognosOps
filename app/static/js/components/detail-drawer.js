/* ═══════════════════════════════════════════════
   PrognosOps 详情抽屉(components/detail-drawer.js)
   职责:按需打开的详情面板,展示分析图表/策略对比/质量详情;
         打开关闭不清空会话;Esc/遮罩/按钮关闭;焦点圈定
   挂载:window.PO.detailDrawer
   依赖:state.js(PO)、evidence-panel.js(PO.evidencePanel)、api.js(API)
   内容类型:
   - evidence:分析图表与依据(复用 evidencePanel,自动展开)
   - strategies:四种策略完整对比表
   - quality:数据质量详情
   ═══════════════════════════════════════════════ */
window.PO.detailDrawer = (() => {
  'use strict';

  let mounted = false, rootEl = null;
  let isOpen = false, lastFocused = null;
  let currentType = null;

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');
  const fmtNum = (v, d) => API.fmtNum(v, d);
  const fmtPct = (v) => API.fmtPct(v);

  const STRATEGY_ORDER = ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q'];
  const STRATEGY_LABEL = {
    'ETO-C': 'ETO-C 期望总成本',
    'IEO-C': 'IEO-C 改进期望成本',
    'ETO-Q': 'ETO-Q 期望产出质量',
    'IEO-Q': 'IEO-Q 改进产出质量',
  };

  // ───────── 内容渲染:evidence(复用 evidencePanel,自动展开 + 依据详情) ─────────

  function statCard(label, value) {
    return '<div class="po-stat-card"><span class="po-stat-label">' + label + '</span>'
      + '<span class="po-stat-value">' + value + '</span></div>';
  }
  function traceRow(label, value) {
    return '<div class="po-trace-row"><span>' + label + '</span><span class="po-trace-val">' + value + '</span></div>';
  }

  // 依据详情:假设/Weibull 拟合参数/决策参数/优化运行记录(移植自 workspace-view,保留信息完整度)
  function buildEvidenceDetail(s) {
    const pred = s.prediction;
    const dec = s.appliedScenario;
    const sections = [];

    // 假设(纯文本渲染,含 S00【样本过滤】条)
    const assumptions = []
      .concat((pred && pred.assumptions) || [])
      .concat((dec && dec.assumptions) || []);
    if (assumptions.length) {
      sections.push('<h3 class="po-section-title">假设</h3>'
        + assumptions.map(a => '<div class="po-assumption-item">' + esc(a) + '</div>').join(''));
    }

    // Weibull 拟合参数(n_samples 标"参与拟合正样本数"并显示零值数)
    if (pred && pred.weibull) {
      const w = pred.weibull;
      const zeroNote = (w.n_zero != null && w.n_zero > 0)
        ? '<span class="po-aux">其中 RUL=0 未参与拟合 ' + esc(String(w.n_zero)) + ' 个</span>'
        : '';
      sections.push('<h3 class="po-section-title">Weibull 拟合参数</h3>'
        + '<div class="po-stat-row">'
        + statCard('尺度参数 λ', fmtNum(w.lam, 2))
        + statCard('形状参数 k', fmtNum(w.k, 4))
        + statCard('对数似然', w.log_likelihood != null && Number.isFinite(w.log_likelihood) ? fmtNum(w.log_likelihood, 2) : '不可计算')
        + statCard('参与拟合正样本数', esc(String(w.n_samples)) + (zeroNote ? '<br>' + zeroNote : ''))
        + statCard('参考集规模', esc(String(pred.n_reference ?? '—')))
        + '</div>');
    }

    // 决策参数(已应用方案的参数快照)
    if (dec && dec.params) {
      const p = dec.params;
      sections.push('<h3 class="po-section-title">决策参数(已应用)</h3>'
        + '<div class="po-stat-row">'
        + statCard('c_m 计划更换', fmtNum(p.cm, 2))
        + statCard('c_d 停机损失', fmtNum(p.cd, 2))
        + statCard('c_p 故障更换', fmtNum(p.cp, 2))
        + statCard('c_c 劣质产出', fmtNum(p.cc, 2))
        + statCard('α 质量权重', fmtNum(p.alpha, 4))
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
            + traceRow('最终 μ', fmtNum(t.final_mu, 2))
            + traceRow('最终 σ', fmtNum(t.final_sigma, 2))
            + traceRow('实际步数', esc(String(t.n_steps_actual)))
            + traceRow('训练步数/批大小/MC样本', esc(String(t.config.n_steps)) + ' / ' + esc(String(t.config.batch_size)) + ' / ' + esc(String(t.config.mc_samples)))
            + traceRow('随机种子', t.config.random_seed != null ? esc(String(t.config.random_seed)) : '未固定')
            + '</div>';
        }).join('');
        sections.push('<h3 class="po-section-title">优化运行记录</h3>' + tracesHtml);
      }
    }

    return sections.join('');
  }

  function renderEvidence(bodyEl, s) {
    if (!s.prediction && !s.appliedScenario) {
      bodyEl.innerHTML = '<div class="po-empty"><p>暂无分析结果,请先运行分析</p></div>';
      return;
    }
    // 定位最新成功的 predict 运行(含决策结果)
    const run = [...s.runs].reverse().find(r => r.kind === 'predict' && r.status === 'success') || {};
    const snapshot = {
      run: run,
      prediction: s.prediction,
      decision: s.appliedScenario,
      context: s.context,
    };
    // 图表与数据表(复用 evidencePanel,独立子容器避免 innerHTML 互扰)
    bodyEl.innerHTML = '';
    const panelWrap = document.createElement('div');
    bodyEl.appendChild(panelWrap);
    PO.evidencePanel.render(panelWrap, snapshot);
    // 自动展开依据(用户点"查看分析图表"即期待看到图表)
    const expandBtn = panelWrap.querySelector('.po-ev-toggle');
    if (expandBtn) expandBtn.click();
    // 依据详情:假设/Weibull/决策参数/优化运行记录
    const detailWrap = document.createElement('div');
    detailWrap.className = 'po-dd-evidence-detail';
    detailWrap.innerHTML = buildEvidenceDetail(s);
    bodyEl.appendChild(detailWrap);
  }

  // ───────── 内容渲染:strategies(四种策略完整对比表) ─────────

  function renderStrategies(bodyEl, s) {
    const d = s.appliedScenario;
    if (!d || !d.strategies) {
      bodyEl.innerHTML = '<div class="po-empty"><p>尚未应用决策方案,请先运行分析</p></div>';
      return;
    }
    const p = d.params || {};
    let html = '<div class="po-dd-meta">'
      + '<span>设备 #' + esc(String(s.context.unitId ?? '—')) + '</span>'
      + '<span>时点 ' + esc(String(s.context.cycle ?? '—')) + '</span>'
      + '<span>参数 cm=' + esc(String(p.cm ?? '—')) + ', cd=' + esc(String(p.cd ?? '—'))
      + ', cp=' + esc(String(p.cp ?? '—')) + ', cc=' + esc(String(p.cc ?? '—'))
      + ', α=' + esc(String(p.alpha ?? '—')) + '</span>'
      + '</div>';

    html += '<div class="po-table-scroll"><table class="po-table"><thead><tr>'
      + '<th>策略</th><th>推荐窗口 z*</th><th>E[TC]</th><th>失效概率</th>'
      + '<th>目标值</th><th>与 ETO 窗口差</th><th>E[C1]</th>'
      + '</tr></thead><tbody>';
    for (const name of STRATEGY_ORDER) {
      const st = d.strategies[name];
      if (!st) continue;
      html += '<tr>'
        + '<td class="po-name">' + esc(STRATEGY_LABEL[name] || name) + '</td>'
        + '<td class="po-num po-num-good">' + esc(String(st.optimal_window ?? '—')) + '</td>'
        + '<td class="po-num">' + (st.expected_total_cost != null ? fmtNum(st.expected_total_cost, 2) : '—') + '</td>'
        + '<td class="po-num">' + (st.failure_prob != null ? fmtPct(st.failure_prob) : '—') + '</td>'
        + '<td class="po-num">' + (st.objective_value != null ? fmtNum(st.objective_value, 4) : '—') + '</td>'
        + '<td class="po-num">' + esc(String(st.diff_window_vs_eto ?? '—')) + '</td>'
        + '<td class="po-num">' + (st.expected_cost != null ? fmtNum(st.expected_cost, 4) : '—') + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div>';

    // 假设说明
    if (d.assumptions && d.assumptions.length) {
      html += '<h3 class="po-section-title">假设</h3>';
      html += d.assumptions.map(a => '<div class="po-assumption-item">' + esc(a) + '</div>').join('');
    }

    bodyEl.innerHTML = html;
  }

  // ───────── 内容渲染:quality(数据质量详情) ─────────

  function renderQuality(bodyEl, s) {
    const qr = s.data.qualityReport;
    if (!qr) {
      bodyEl.innerHTML = '<div class="po-empty"><p>尚未上传数据,无质量报告</p></div>';
      return;
    }
    const ov = s.data.overview || {};
    let html = '<div class="po-dd-meta">'
      + '<span>数据集 ' + esc(s.context.fileName || '—') + '</span>'
      + '<span>' + esc(String(ov.unit_count ?? '—')) + ' 台设备</span>'
      + '<span>' + esc(String(ov.total_rows ?? '—')) + ' 条记录</span>'
      + '<span class="po-badge ' + (qr.is_valid ? 'po-badge-success' : 'po-badge-warning') + '">'
      + (qr.is_valid ? '质量通过' : '质量未通过') + '</span>'
      + (qr.has_critical ? '<span class="po-badge po-badge-warning">存在严重问题</span>' : '')
      + '</div>';

    html += '<div class="po-table-scroll"><table class="po-table"><thead><tr>'
      + '<th>检查项</th><th>结果</th><th>说明</th>'
      + '</tr></thead><tbody>';
    for (const c of qr.checks) {
      html += '<tr>'
        + '<td class="po-name">' + esc(c.name) + '</td>'
        + '<td><span class="po-badge ' + (c.passed ? 'po-badge-success' : 'po-badge-warning') + '">'
        + (c.passed ? '通过' : '未通过') + '</span></td>'
        + '<td>' + esc(c.detail || c.message || '—') + '</td>'
        + '</tr>';
    }
    html += '</tbody></table></div>';

    if (qr.assumptions && qr.assumptions.length) {
      html += '<h3 class="po-section-title">假设</h3>';
      html += qr.assumptions.map(a => '<div class="po-assumption-item">' + esc(a) + '</div>').join('');
    }

    bodyEl.innerHTML = html;
  }

  // ───────── 打开/关闭 ─────────

  function open(type) {
    if (!rootEl || isOpen) return;
    isOpen = true;
    currentType = type;
    lastFocused = document.activeElement;

    const overlay = rootEl.querySelector('#po-dd-overlay');
    if (overlay) overlay.hidden = false;

    const titleEl = rootEl.querySelector('#po-dd-title');
    const bodyEl = rootEl.querySelector('#po-dd-body');
    const s = PO.getState();

    if (type === 'evidence') {
      if (titleEl) titleEl.textContent = '分析图表与依据';
      renderEvidence(bodyEl, s);
    } else if (type === 'strategies') {
      if (titleEl) titleEl.textContent = '四种策略完整对比';
      renderStrategies(bodyEl, s);
    } else if (type === 'quality') {
      if (titleEl) titleEl.textContent = '数据质量详情';
      renderQuality(bodyEl, s);
    }

    const closeBtn = rootEl.querySelector('#po-dd-close');
    if (closeBtn) closeBtn.focus();
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (!rootEl || !isOpen) return;
    isOpen = false;
    currentType = null;
    // 销毁 evidence 面板图表实例(防泄漏)
    try { PO.evidencePanel.unmount(); } catch (_) { /* 未渲染过 */ }
    const overlay = rootEl.querySelector('#po-dd-overlay');
    if (overlay) overlay.hidden = true;
    document.removeEventListener('keydown', onKeydown);
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch (_) { /* 元素已移除 */ }
    }
    lastFocused = null;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = rootEl.querySelectorAll('button, [href], input, select, textarea, details, [tabindex]:not([tabindex="-1"])');
      const visible = Array.from(focusables).filter(f => !f.disabled && f.offsetParent !== null);
      if (!visible.length) return;
      const first = visible[0], last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  // ───────── 挂载/卸载 ─────────

  function mount(root) {
    if (mounted) return;
    mounted = true;
    rootEl = root;
    rootEl.innerHTML = ''
      + '<div class="po-dd-overlay" id="po-dd-overlay" hidden>'
      + '  <div class="po-dd-panel" role="dialog" aria-label="详情面板">'
      + '    <div class="po-dd-header">'
      + '      <h2 class="po-dd-title" id="po-dd-title">详情</h2>'
      + '      <button class="po-btn po-btn-secondary po-btn-sm" id="po-dd-close">关闭</button>'
      + '    </div>'
      + '    <div class="po-dd-body" id="po-dd-body"></div>'
      + '  </div>'
      + '</div>';

    const closeBtn = rootEl.querySelector('#po-dd-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const overlay = rootEl.querySelector('#po-dd-overlay');
    if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  }

  function unmount() {
    close();
    if (rootEl) rootEl.innerHTML = '';
    mounted = false;
    rootEl = null;
  }

  return { mount, unmount, open, close, isOpen: () => isOpen };
})();