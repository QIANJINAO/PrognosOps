/* ═══════════════════════════════════════════════
   PrognosOps 候选方案面板(components/scenario-panel.js)
   职责:显示基准与候选参数、变化字段、工具返回结果摘要;
         "应用并重新计算"调用 applyCandidate 取完整结果
   挂载:window.PO.scenarioPanel
   依赖:state.js(PO)、controllers/analysis.js(PO.analysis)、api.js(API)
   设计约束(施工单 S13):
   - 仅有摘要时标"候选摘要",不补曲线;
   - 按钮命名"应用并重新计算",调用 S07 的 applyCandidate,生成新 runId;
   - 重算中保留原方案;成功后更新当前方案与 scenarioRev;
   - 与摘要不同则显示新结果并标"已重新计算";
   - 应用成功使旧候选失效(scenarioRev 递增),过期候选不可应用;
   - 应用失败只在该候选显示错误与重试,原已应用方案保持不变。
   注:公共接线由 S17 合入,本组件仅提供 render 接口。
   ═══════════════════════════════════════════════ */
window.PO.scenarioPanel = (() => {
  'use strict';

  // 内部状态:按候选索引记录应用结果/错误/运行中(render 重渲染不丢)
  let internal = { applied: {}, errors: {}, running: {} };
  let currentRoot = null, currentCandidates = [];

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  const SYMBOLS = { cm: 'c_m', cd: 'c_d', cp: 'c_p', cc: 'c_c', alpha: 'α' };
  const PARAM_KEYS = ['cm', 'cd', 'cp', 'cc', 'alpha'];

  // ───────── 候选数据提取 ─────────

  // 候选完整参数(recompute: decision.params;compare: comparison.params)
  function candidateParams(candidate) {
    if (candidate.type === 'recompute' && candidate.decision) return candidate.decision.params;
    if (candidate.type === 'compare' && candidate.comparison) return candidate.comparison.params;
    return null;
  }

  // 变化字段(候选参数 vs 基准参数,五字段数值比较)
  function changedFields(candidate, baseParams) {
    const params = candidateParams(candidate);
    if (!params || !baseParams) return [];
    return PARAM_KEYS
      .filter(k => Number(params[k]) !== Number(baseParams[k]))
      .map(k => ({ key: k, symbol: SYMBOLS[k], from: baseParams[k], to: params[k] }));
  }

  // 工具返回结果摘要(recompute: 四策略;compare: ETO-C/IEO-C)
  function summaryLines(candidate) {
    if (candidate.type === 'recompute' && candidate.decision && candidate.decision.strategies) {
      return Object.keys(candidate.decision.strategies).map(name => {
        const st = candidate.decision.strategies[name];
        return name + ': 窗口 ' + st.optimal_window + ', E[TC]=' + API.fmtNum(st.expected_total_cost, 2)
          + ', 失效概率=' + API.fmtPct(st.failure_prob);
      });
    }
    if (candidate.type === 'compare' && candidate.comparison) {
      const cmp = candidate.comparison;
      const lines = [cmp.name || '未命名方案'];
      if (cmp['ETO-C']) lines.push('ETO-C: 窗口 ' + cmp['ETO-C'].optimal_window + ', E[TC]=' + API.fmtNum(cmp['ETO-C'].expected_total_cost, 2));
      if (cmp['IEO-C']) lines.push('IEO-C: 窗口 ' + cmp['IEO-C'].optimal_window + ', E[TC]=' + API.fmtNum(cmp['IEO-C'].expected_total_cost, 2));
      return lines;
    }
    return [];
  }

  // ───────── 过期与重算判定 ─────────

  // 过期:候选来源版本(contextRev/scenarioRev)与当前不一致 → 不可应用
  function isStale(candidate, s) {
    return candidate.contextRev !== s.context.contextRev
      || candidate.scenarioRev !== s.context.scenarioRev;
  }

  // 新结果与摘要比较:窗口或成本不同 → 标"已重新计算"
  function isRecalculated(newDecision, candidate) {
    if (!newDecision || !newDecision.strategies) return false;
    if (candidate.type === 'recompute' && candidate.decision && candidate.decision.strategies) {
      for (const name of Object.keys(candidate.decision.strategies)) {
        const old = candidate.decision.strategies[name];
        const neu = newDecision.strategies[name];
        if (!neu) continue;
        if (old.optimal_window !== neu.optimal_window
          || Math.abs(Number(old.expected_total_cost) - Number(neu.expected_total_cost)) > 1e-6) return true;
      }
      return false;
    }
    if (candidate.type === 'compare' && candidate.comparison) {
      const cmp = candidate.comparison;
      const etoc = newDecision.strategies['ETO-C'];
      if (cmp['ETO-C'] && etoc
        && (cmp['ETO-C'].optimal_window !== etoc.optimal_window
          || Math.abs(Number(cmp['ETO-C'].expected_total_cost) - Number(etoc.expected_total_cost)) > 1e-6)) return true;
      return false;
    }
    return false;
  }

  // ───────── 应用候选(调用 applyCandidate,成功才提交) ─────────
  async function applyCandidateAt(idx, candidate) {
    const params = candidateParams(candidate);
    if (!params) return;
    internal.running[idx] = true;
    internal.errors[idx] = null;
    render(currentRoot, currentCandidates); // 重算中(原方案保留,applyScenario 只在成功后调用)

    try {
      const r = await PO.analysis.applyCandidate(candidate, { params, useCache: false });
      // 成功:applyScenario 已写新方案 + scenarioRev 递增(旧候选/旧历史自动失效)
      internal.applied[idx] = {
        recalculated: isRecalculated(r.decision, candidate),
        runId: r.runId,
        appliedAt: Date.now(), // S19:应用成功高亮动效触发标记
      };
    } catch (err) {
      // 失败:只记该候选错误,原已应用方案保持不变
      internal.errors[idx] = err;
    } finally {
      internal.running[idx] = false;
      render(currentRoot, currentCandidates);
      // S19:高亮动效 760ms 后移除 class(重新 render 不再加 justApplied)
      if (internal.applied[idx] && internal.applied[idx].appliedAt) {
        const elapsed = Date.now() - internal.applied[idx].appliedAt;
        const remain = Math.max(0, 780 - elapsed);
        setTimeout(() => {
          if (!internal.running[idx]) render(currentRoot, currentCandidates);
        }, remain);
      }
    }
  }

  // ───────── 渲染 ─────────
  function render(root, candidates) {
    if (!root) return;
    currentRoot = root;
    currentCandidates = candidates || [];
    const s = PO.getState();
    const baseParams = s.appliedScenario ? s.appliedScenario.params : null;

    if (!currentCandidates.length) {
      root.innerHTML = '<div class="po-empty"><p>暂无候选方案,向 AI 助手提问可生成参数重算候选</p></div>';
      return;
    }

    root.innerHTML = currentCandidates.map((cand, idx) => {
      const stale = isStale(cand, s);
      const running = !!internal.running[idx];
      const applied = internal.applied[idx];
      const error = internal.errors[idx];
      const params = candidateParams(cand);
      const changes = changedFields(cand, baseParams);
      const summaries = summaryLines(cand);

      // 类型标签
      const typeLabel = cand.type === 'recompute' ? '参数重算候选' : '方案对比候选';

      // 变化字段(基准值 → 候选值)
      const changesHtml = changes.length
        ? '<div class="po-cand-changes">' + changes.map(ch =>
            '<span class="po-cand-change">' + esc(ch.symbol) + ': '
            + esc(String(ch.from)) + ' → ' + esc(String(ch.to)) + '</span>'
          ).join('') + '</div>'
        : '';

      // 候选参数(与基准对比后展示完整值)
      const paramsHtml = params
        ? '<div class="po-cand-params">' + PARAM_KEYS.map(k =>
            '<span class="po-cand-param">' + esc(SYMBOLS[k]) + '=' + esc(String(params[k] ?? '—')) + '</span>'
          ).join('') + '</div>'
        : '';

      // 工具返回结果摘要(候选摘要,不补曲线)
      const summaryHtml = summaries.length
        ? '<div class="po-cand-summary">' + summaries.map(l => '<div>' + esc(l) + '</div>').join('') + '</div>'
        : '';

      // 状态标签:默认"候选摘要"(仅有摘要,不补曲线)
      let statusHtml = '<span class="po-badge po-badge-info">候选摘要</span>';
      if (stale) statusHtml = '<span class="po-badge po-badge-warning">已过期</span>';
      if (running) statusHtml = '<span class="po-badge po-badge-warning">重算中...</span>';
      if (applied) {
        statusHtml = '<span class="po-badge po-badge-success">已应用</span>'
          + (applied.recalculated ? '<span class="po-badge po-badge-info">已重新计算</span>' : '');
      }

      // 按钮:过期/已应用不显示;重算中禁用
      let btnHtml = '';
      if (!stale && !applied) {
        btnHtml = running
          ? '<button class="po-btn po-btn-accent po-btn-sm" disabled>重算中...</button>'
          : '<button class="po-btn po-btn-accent po-btn-sm po-cand-apply" data-idx="' + idx + '">应用并重新计算</button>';
      }

      // 错误(只在该候选显示,附重试按钮)
      const errorHtml = error
        ? '<div class="po-cand-error">' + esc(error.message || '应用失败')
          + ' <button class="po-btn po-btn-secondary po-btn-sm po-cand-retry" data-idx="' + idx + '">重试</button></div>'
        : '';

      // S19:应用成功后 760ms 内加高亮动效 class(由真实状态变化触发)
      const justApplied = applied && (Date.now() - (applied.appliedAt || 0) < 760);
      return '<div class="po-cand-card' + (stale ? ' po-cand-stale' : '') + (justApplied ? ' po-cand-just-applied' : '') + '">'
        + '<div class="po-cand-header"><span class="po-cand-type">' + typeLabel + '</span>'
        + '<span class="po-cand-badges">' + statusHtml + '</span></div>'
        + changesHtml + paramsHtml + summaryHtml + errorHtml
        + '<div class="po-cand-actions">' + btnHtml + '</div>'
        + '</div>';
    }).join('');

    // 事件绑定(应用/重试共用入口)
    root.querySelectorAll('.po-cand-apply, .po-cand-retry').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        if (currentCandidates[idx]) applyCandidateAt(idx, currentCandidates[idx]);
      });
    });
  }

  return { render };
})();