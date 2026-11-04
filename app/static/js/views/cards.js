/* ═══════════════════════════════════════════════
   PrognosOps 会话结果卡片(views/cards.js)
   职责:渲染嵌入对话的四类结果卡片(数据导入/维修建议/情景比较/回测);
         卡片按钮通过 data-action 属性由 chat-view 事件委托处理
   挂载:window.PO.cards
   依赖:api.js(API)
   卡片类型:
   - data-import:数据导入结果(文件/设备数/记录数/质量)
   - advice:维修建议(设备时点/策略/窗口/E[TC]/失效概率)
   - compare:情景比较(变化参数/当前与候选对比/应用)
   - backtest:回测结果(对象/方案/关键指标/导出)
   ═══════════════════════════════════════════════ */
window.PO.cards = (() => {
  'use strict';

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');
  const fmtNum = (v, d) => API.fmtNum(v, d);
  const fmtPct = (v) => API.fmtPct(v);

  const PARAM_SYMBOLS = { cm: 'c_m', cd: 'c_d', cp: 'c_p', cc: 'c_c', alpha: 'α' };
  const PARAM_KEYS = ['cm', 'cd', 'cp', 'cc', 'alpha'];
  const STRATEGY_ORDER = ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q'];

  // ───────── A. 数据导入卡片 ─────────

  function renderDataImport(data) {
    const d = data || {};
    const qualityBadge = d.qualityValid
      ? '<span class="po-badge po-badge-success">质量通过</span>'
      : '<span class="po-badge po-badge-warning">质量未通过</span>';
    return '<div class="po-chat-card po-chat-card-data" data-card-type="data-import">'
      + '<div class="po-chat-card-head">'
      + '<span class="po-chat-card-icon" aria-hidden="true">📁</span>'
      + '<span class="po-chat-card-title">数据已导入</span>'
      + qualityBadge
      + '</div>'
      + '<div class="po-chat-card-body">'
      + '<div class="po-chat-card-grid">'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + esc(String(d.unitCount ?? '—')) + '</div><div class="po-chat-card-label">设备数</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + esc(String(d.totalRows ?? '—')) + '</div><div class="po-chat-card-label">记录数</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + esc(String(d.qualityPassedCount ?? '—')) + '/' + esc(String(d.qualityTotalCount ?? '—')) + '</div><div class="po-chat-card-label">质量检查</div></div>'
      + '</div>'
      + '<div class="po-chat-card-meta">'
      + '<span>文件:' + esc(d.fileName || '—') + '</span>'
      + (d.source === 'demo' ? '<span class="po-badge po-badge-info">合成演示数据</span>' : '')
      + '</div>'
      + '</div>'
      + '<div class="po-chat-card-actions">'
      + '<button class="po-btn po-btn-primary po-btn-sm" data-action="start-analysis">开始分析</button>'
      + '<button class="po-btn po-btn-secondary po-btn-sm" data-action="open-detail" data-detail-type="quality">查看质量详情</button>'
      + '</div>'
      + '</div>';
  }

  // ───────── B. 维修建议卡片 ─────────

  function renderAdvice(data) {
    const d = data || {};
    const st = d.strategy || {};
    return '<div class="po-chat-card po-chat-card-advice" data-card-type="advice">'
      + '<div class="po-chat-card-head">'
      + '<span class="po-chat-card-icon" aria-hidden="true">🔧</span>'
      + '<span class="po-chat-card-title">维修建议</span>'
      + '<span class="po-badge po-badge-info">设备 #' + esc(String(d.unitId ?? '—')) + ' @ 周期 ' + esc(String(d.cycle ?? '—')) + '</span>'
      + '</div>'
      + '<div class="po-chat-card-body">'
      + '<div class="po-chat-card-grid po-chat-card-grid-4">'
      + '<div class="po-chat-card-cell po-chat-card-accent"><div class="po-chat-card-value">' + esc(String(st.optimal_window ?? '—')) + '</div><div class="po-chat-card-label">推荐窗口 z*</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + (st.expected_total_cost != null ? fmtNum(st.expected_total_cost, 2) : '—') + '</div><div class="po-chat-card-label">E[TC]</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + (st.failure_prob != null ? fmtPct(st.failure_prob) : '—') + '</div><div class="po-chat-card-label">失效概率</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + esc(d.strategyName || '—') + '</div><div class="po-chat-card-label">当前策略</div></div>'
      + '</div>'
      + '</div>'
      + '<div class="po-chat-card-actions">'
      + '<button class="po-btn po-btn-secondary po-btn-sm" data-action="ask-agent" data-query="为什么推荐在 ' + esc(String(st.optimal_window ?? '')) + ' 周期进行维修?依据是什么?">解释推荐依据</button>'
      + '<button class="po-btn po-btn-secondary po-btn-sm" data-action="open-detail" data-detail-type="strategies">比较四种策略</button>'
      + '<button class="po-btn po-btn-secondary po-btn-sm" data-action="open-detail" data-detail-type="evidence">查看分析图表</button>'
      + '<button class="po-btn po-btn-accent po-btn-sm" data-action="run-backtest">运行回测</button>'
      + '</div>'
      + '</div>';
  }

  // ───────── C. 情景比较卡片 ─────────

  // 候选参数提取
  function candidateParams(c) {
    if (c.type === 'recompute' && c.decision) return c.decision.params;
    if (c.type === 'compare' && c.comparison) return c.comparison.params;
    return null;
  }

  // 变化字段列表
  function changedFields(c, baseParams) {
    const params = candidateParams(c);
    if (!params || !baseParams) return [];
    return PARAM_KEYS
      .filter(k => Number(params[k]) !== Number(baseParams[k]))
      .map(k => ({ key: k, symbol: PARAM_SYMBOLS[k], from: baseParams[k], to: params[k] }));
  }

  // 候选关键指标(ETO-C)
  function candidateMetrics(c) {
    if (c.type === 'recompute' && c.decision && c.decision.strategies) {
      const st = c.decision.strategies['ETO-C'];
      if (st) return { window: st.optimal_window, etc: st.expected_total_cost, fp: st.failure_prob };
    }
    if (c.type === 'compare' && c.comparison) {
      const cmp = c.comparison;
      return { window: cmp.optimal_window, etc: cmp.expected_total_cost, fp: cmp.failure_prob };
    }
    return null;
  }

  function renderCompare(data) {
    const d = data || {};
    const candidates = d.candidates || [];
    const baseParams = d.baseParams || {};
    const currentRev = d.contextRev;
    const scenarioRev = d.scenarioRev;
    // 已应用候选索引(应用成功后由 chat-view 设置,760ms 动效播完后清除)
    const appliedIdx = (d.appliedIndex != null) ? d.appliedIndex : -1;

    let html = '<div class="po-chat-card po-chat-card-compare" data-card-type="compare">'
      + '<div class="po-chat-card-head">'
      + '<span class="po-chat-card-icon" aria-hidden="true">⚖️</span>'
      + '<span class="po-chat-card-title">情景比较</span>'
      + '</div>'
      + '<div class="po-chat-card-body">';

    candidates.forEach((c, i) => {
      const fields = changedFields(c, baseParams);
      const metrics = candidateMetrics(c);
      const isApplied = (i === appliedIdx) || c.applied === true;
      // 高亮动效仅在 appliedIndex 命中时触发(800ms 窗口,播完清除);"已应用"徽章由 c.applied 持久保留
      const isJustApplied = (i === appliedIdx);
      // 已应用项不标过期(其版本已随 applyCandidate 推进)
      const isStale = !isApplied && ((c.contextRev !== currentRev) || (c.scenarioRev !== scenarioRev));
      const paramLabel = fields.length
        ? fields.map(f => esc(f.symbol) + ': ' + esc(String(f.from)) + ' → ' + esc(String(f.to))).join(',&nbsp; ')
        : '(无变化)';

      html += '<div class="po-chat-compare-item' + (isJustApplied ? ' po-cand-just-applied' : '') + (isStale ? ' po-chat-compare-stale' : '') + '">'
        + '<div class="po-chat-compare-changes">' + paramLabel + '</div>';

      if (metrics) {
        html += '<div class="po-chat-card-grid po-chat-card-grid-3">'
          + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + esc(String(metrics.window ?? '—')) + '</div><div class="po-chat-card-label">窗口 z*</div></div>'
          + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + (metrics.etc != null ? fmtNum(metrics.etc, 2) : '—') + '</div><div class="po-chat-card-label">E[TC]</div></div>'
          + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + (metrics.fp != null ? fmtPct(metrics.fp) : '—') + '</div><div class="po-chat-card-label">失效概率</div></div>'
          + '</div>';
      }

      html += '<div class="po-chat-card-actions">'
        + (isApplied
          ? '<span class="po-badge po-badge-success">已应用</span>'
          : isStale
            ? '<span class="po-aux">上下文已变化,此候选不可应用</span>'
            : '<button class="po-btn po-btn-primary po-btn-sm" data-action="apply-candidate" data-candidate-index="' + i + '">应用并重新计算</button>')
        + '</div>'
        + '</div>';
    });

    html += '</div></div>';
    return html;
  }

  // ───────── D. 回测结果卡片 ─────────

  function renderBacktest(data) {
    const d = data || {};
    const hasTrueRul = d.hasTrueRul;
    let html = '<div class="po-chat-card po-chat-card-backtest" data-card-type="backtest">'
      + '<div class="po-chat-card-head">'
      + '<span class="po-chat-card-icon" aria-hidden="true">🔬</span>'
      + '<span class="po-chat-card-title">回测结果</span>'
      + '<span class="po-badge po-badge-info">设备 #' + esc(String(d.unitId ?? '—')) + '</span>'
      + '</div>'
      + '<div class="po-chat-card-body">'
      + '<div class="po-chat-card-grid po-chat-card-grid-4">'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + esc(String(d.nPoints ?? '—')) + '</div><div class="po-chat-card-label">回测时点数</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + esc(String(d.nUnits ?? '—')) + '</div><div class="po-chat-card-label">回测单元数</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + (d.nllMean != null ? fmtNum(d.nllMean, 4) : '—') + '</div><div class="po-chat-card-label">NLL 均值</div></div>'
      + '<div class="po-chat-card-cell"><div class="po-chat-card-value">' + (d.maeMean != null ? fmtNum(d.maeMean, 2) : '—') + '</div><div class="po-chat-card-label">MAE 均值</div></div>'
      + '</div>';

    // 策略关键结果(最多 4 行)
    if (d.strategySummary && d.strategySummary.length) {
      html += '<div class="po-chat-bt-strategies">';
      for (const ss of d.strategySummary) {
        html += '<div class="po-chat-bt-row">'
          + '<span class="po-chat-bt-name">' + esc(ss.name) + '</span>'
          + '<span class="po-chat-bt-metric">窗口 ' + esc(String(ss.window ?? '—')) + '</span>'
          + '<span class="po-chat-bt-metric">失效频率 ' + (ss.failFreq != null ? fmtPct(ss.failFreq) : '—') + '</span>'
          + '<span class="po-chat-bt-metric">regret ' + (ss.regretMean != null ? fmtNum(ss.regretMean, 4) : '—') + '</span>'
          + '</div>';
      }
      html += '</div>';
    }
    if (!hasTrueRul) {
      html += '<div class="po-status-bar po-status-warn">无真实 RUL 标签:regret/NLL/MAE/校准依赖真值,相关指标以"—"标注</div>';
    }
    html += '</div>'
      + '<div class="po-chat-card-actions">'
      + '<button class="po-btn po-btn-primary po-btn-sm" data-action="export-backtest" data-run-id="' + esc(d.runId || '') + '">导出 CSV</button>'
      + '<button class="po-btn po-btn-secondary po-btn-sm" data-action="goto-validation">查看完整结果</button>'
      + '</div>'
      + '</div>';
    return html;
  }

  // ───────── 统一入口 ─────────

  /**
   * 渲染结果卡片 HTML
   * @param {Object} msg - 会话消息(type='card')
   * @returns {string} 卡片 HTML
   */
  function render(msg) {
    if (!msg || msg.type !== 'card') return '';
    if (msg.cardType === 'data-import') return renderDataImport(msg.data);
    if (msg.cardType === 'advice') return renderAdvice(msg.data);
    if (msg.cardType === 'compare') return renderCompare(msg.data);
    if (msg.cardType === 'backtest') return renderBacktest(msg.data);
    return '';
  }

  // ───────── 卡片数据构建(供 chat-view 在操作完成时调用) ─────────

  /** 数据导入卡片数据(从当前状态构建) */
  function buildDataImportData(s, fileName, source) {
    const ov = s.data.overview || {};
    const qr = s.data.qualityReport || {};
    const passed = (qr.checks || []).filter(c => c.passed).length;
    return {
      fileName: fileName || s.context.fileName,
      source: source,
      unitCount: ov.unit_count,
      totalRows: ov.total_rows,
      qualityValid: qr.is_valid,
      hasCritical: qr.has_critical,
      qualityPassedCount: passed,
      qualityTotalCount: (qr.checks || []).length,
      contextRev: s.context.contextRev,
    };
  }

  /** 维修建议卡片数据(从当前状态构建) */
  function buildAdviceData(s) {
    const d = s.appliedScenario;
    if (!d || !d.strategies) return null;
    const st = d.strategies['ETO-C'] || {};
    return {
      unitId: s.context.unitId,
      cycle: s.context.cycle,
      strategyName: 'ETO-C',
      strategy: st,
      params: d.params,
      runId: d._runId,
      contextRev: s.context.contextRev,
      scenarioRev: s.context.scenarioRev,
    };
  }

  /** 情景比较卡片数据(从候选列表构建) */
  function buildCompareData(s, candidates) {
    const baseParams = s.appliedScenario ? s.appliedScenario.params : {};
    return {
      candidates: candidates,
      baseParams: baseParams,
      contextRev: s.context.contextRev,
      scenarioRev: s.context.scenarioRev,
    };
  }

  /** 回测结果卡片数据(从回测结果构建) */
  function buildBacktestData(s, runId) {
    const bt = s.backtest;
    if (!bt) return null;
    const strategySummary = Object.keys(bt.strategies || {}).map(name => {
      const st = bt.strategies[name];
      return {
        name: name,
        window: st.chosen_window_mean != null ? st.chosen_window_mean : null,
        failFreq: st.failure_frequency,
        regretMean: st.regret_mean,
      };
    });
    return {
      unitId: s.context.unitId,
      nPoints: bt.n_points,
      nUnits: bt.n_units,
      hasTrueRul: bt.has_true_rul,
      nllMean: bt.nll_mean,
      maeMean: bt.mae_mean,
      strategySummary: strategySummary,
      runId: runId,
      contextRev: s.context.contextRev,
      scenarioRev: s.context.scenarioRev,
    };
  }

  return { render, buildDataImportData, buildAdviceData, buildCompareData, buildBacktestData };
})();