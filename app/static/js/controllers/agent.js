/* ═══════════════════════════════════════════════
   PrognosOps Agent 控制器(controllers/agent.js)
   职责:Agent 提交统一入口、快照构建、历史隔离、候选提取、离线降级
   挂载:window.PO.agent
   依赖:state.js / request-controller.js / api.js
   ═══════════════════════════════════════════════ */
window.PO.agent = (() => {
  'use strict';

  // ───────── 快照构建 ─────────

  /**
   * 构建快照:同一时刻取所有上下文字段,参数只取已应用方案
   * (draft 是未提交草稿,不作为 Agent 上下文)
   */
  function buildSnapshot() {
    const s = PO.getState();
    const scenario = s.appliedScenario;
    return {
      sessionId: s.context.sessionId,
      unitId: s.context.unitId,
      cycle: s.context.cycle,
      probs: s.prediction ? s.prediction.discrete.probs : [],
      h_max: s.prediction ? s.prediction.discrete.h_max : 150,
      current_params: scenario ? scenario.params : {},
      contextRev: s.context.contextRev,
      scenarioRev: s.context.scenarioRev,
    };
  }

  // ───────── 历史隔离 ─────────

  /**
   * 历史过滤:只取与当前上下文版本一致的消息,最多 10 条
   * 与后端 routes.py req.history[-10:] 对齐;上下文变化后旧历史不发送
   */
  function filterHistory(chatHistory, contextRev, scenarioRev) {
    return chatHistory
      .filter(m => m.contextRev === contextRev && m.scenarioRev === scenarioRev)
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));
  }

  // ───────── 候选提取 ─────────

  /**
   * 从工具日志提取候选(仅成功的结构化结果)
   * - recompute_decision 成功项的 result.decision
   * - compare_scenarios 成功项的 result.comparisons(排除含 error 的方案)
   * 每个候选绑定来源 runId 与版本(contextRev/scenarioRev)
   */
  function extractCandidates(toolCallsLog, runId, contextRev, scenarioRev) {
    const candidates = [];
    for (const tc of toolCallsLog || []) {
      if (!tc.result || tc.result.error) continue;
      if (tc.tool === 'recompute_decision' && tc.result.decision) {
        candidates.push({
          type: 'recompute',
          decision: tc.result.decision,
          changedParams: tc.result.changed_params || {},
          sourceRunId: runId,
          contextRev: contextRev,
          scenarioRev: scenarioRev,
        });
      }
      if (tc.tool === 'compare_scenarios' && Array.isArray(tc.result.comparisons)) {
        for (const cmp of tc.result.comparisons) {
          if (cmp.error) continue;
          candidates.push({
            type: 'compare',
            comparison: cmp,
            sourceRunId: runId,
            contextRev: contextRev,
            scenarioRev: scenarioRev,
          });
        }
      }
    }
    return candidates;
  }

  // ───────── 统一入口 ─────────

  /**
   * 提交 Agent 查询(按钮/快捷问题/键盘共用,业务锁保证只发 1 次请求)
   * @param {string} query - 用户问题
   * @param {Function} [onStep] - 步骤回调 (name, status, data, candidates)
   * @returns {Promise<Object|null>} null=已有运行被拒绝;{error}=失败;否则含 result/candidates
   */
  async function submit(query, onStep) {
    if (PO.requests.isBusy('agent')) return null;
    const snapshot = buildSnapshot();
    const history = filterHistory(PO.getState().chatHistory, snapshot.contextRev, snapshot.scenarioRev);
    const payload = {
      session_id: snapshot.sessionId || '',
      query: query,
      probs: snapshot.probs,
      h_max: snapshot.h_max,
      unit_id: snapshot.unitId,
      cycle: snapshot.cycle,
      current_params: snapshot.current_params,
      history: history,
    };
    onStep && onStep('agent', 'running');
    try {
      const r = await PO.requests.runTask('agent', {
        query: query,
        contextRev: snapshot.contextRev,
        scenarioRev: snapshot.scenarioRev,
      }, (signal) => API.agentChat(payload, { signal }));
      if (!r) return null; // 锁占用(防御,单线程下 isBusy 已拦截)
      if (r.stale) {
        // 上下文已变化:只归档,不写入成功消息
        onStep && onStep('agent', 'stale', r.result);
        return { runId: r.runId, stale: true, result: r.result };
      }
      // 成功:写入对话历史(失败/停止等待不会走到这里)
      PO.appendChat('user', query);
      PO.appendChat('assistant', r.result.answer);
      // 提取候选(仅结构化结果,绑定来源 runId 与版本)
      const candidates = extractCandidates(r.result.tool_calls_log, r.runId, snapshot.contextRev, snapshot.scenarioRev);
      if (candidates.length) PO.addCandidates(candidates);
      onStep && onStep('agent', 'success', r.result, candidates);
      return { runId: r.runId, stale: false, result: r.result, candidates: candidates };
    } catch (err) {
      // 失败/超时/停止等待:不写入成功消息
      onStep && onStep('agent', 'error', err);
      return { error: err };
    }
  }

  // ───────── 离线降级(从 app.js answerQuery 迁移) ─────────

  /**
   * 基于当前工作台状态的关键词匹配回答(模型不可用时的降级)
   * 数据不足时如实告知;从 PO.store(单一事实源)读取状态
   */
  function answerOffline(q) {
    const s = PO.getState();
    const has = (...keys) => keys.some(k => q.includes(k));

    if (has('质量', '体检', '检查')) {
      if (!s.data.qualityReport) return '尚未上传数据,无法评估数据质量。请先在"数据上传"页面上传 CSV 或使用演示数据。';
      const qr = s.data.qualityReport;
      const failed = qr.checks.filter(c => !c.passed);
      return `数据质量总体判定:${qr.is_valid ? '通过' : '未通过'}。\n` +
        `共 ${qr.checks.length} 项检查,${qr.checks.length - failed.length} 项通过,${failed.length} 项未通过。\n` +
        (qr.has_critical ? '存在严重问题,建议检查数据格式。\n' : '') +
        (failed.length ? '未通过项:' + failed.map(c => c.name).join('、') : '全部检查通过。');
    }
    if (has('单元', '设备', '发动机')) {
      if (!s.data.overview) return '尚未上传数据。请先上传 CSV 文件。';
      return `数据包含 ${s.data.overview.unit_count} 个设备单元,共 ${s.data.overview.total_rows} 行。\n` +
        s.data.overview.units.map(u => `单元 ${u.unit_id}:${u.cycles} 个周期`).join('\n');
    }
    if (has('维修', '窗口', '推荐', '什么时候')) {
      if (!s.appliedScenario) return s.prediction ? '已预测 RUL 概率,请在"维修决策"页面运行决策分析。' : '请先在"趋势分析"页面预测 RUL 概率分布。';
      const d = s.appliedScenario;
      const etoc = d.strategies['ETO-C'];
      const ieoc = d.strategies['IEO-C'];
      return `基于当前 RUL 分布的推荐维修窗口:\n` +
        `ETO-C(期望总成本最优):${etoc.optimal_window} 周期,E[TC]=${API.fmtNum(etoc.expected_total_cost, 2)},失效概率=${API.fmtPct(etoc.failure_prob)}\n` +
        `IEO-C(改进策略):${ieoc.optimal_window} 周期,E[TC]=${API.fmtNum(ieoc.expected_total_cost, 2)},失效概率=${API.fmtPct(ieoc.failure_prob)}\n` +
        `成本参数:cm=${d.params.cm}, cd=${d.params.cd}, cp=${d.params.cp}, cc=${d.params.cc}, alpha=${d.params.alpha}`;
    }
    if (has('ETO', 'IEO', '差异', '对比', '比较')) {
      if (!s.appliedScenario) return '请先运行维修决策分析。';
      const d = s.appliedScenario;
      const lines = ['ETO 与 IEO 并排对比:'];
      for (const name of ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q']) {
        const st = d.strategies[name];
        if (st) lines.push(`${name}:z*=${st.optimal_window},目标值=${API.fmtNum(st.objective_value, 4)},与ETO窗口差=${st.diff_window_vs_eto}`);
      }
      return lines.join('\n');
    }
    if (has('回测', 'regret', 'NLL', 'MAE', '校准')) {
      if (!s.backtest) return '尚未运行回测。请在"离线回测"页面配置参数并运行。';
      const bt = s.backtest;
      let ans = `回测结果:${bt.n_points} 个时点,${bt.n_units} 个单元。\n`;
      ans += bt.has_true_rul ? `NLL 均值=${API.fmtNum(bt.nll_mean, 4)},MAE 均值=${API.fmtNum(bt.mae_mean, 2)}\n` : '无真实 RUL 标签,regret/NLL/MAE 不可计算。\n';
      for (const sn of Object.keys(bt.strategies)) {
        const st = bt.strategies[sn];
        ans += `${sn}:regret均值=${st.regret_mean !== null ? API.fmtNum(st.regret_mean, 4) : '—'},ECE=${st.ece !== null ? API.fmtNum(st.ece, 4) : '—'}\n`;
      }
      if (bt.data_sufficiency_note) ans += `\n${bt.data_sufficiency_note}`;
      return ans;
    }
    if (has('RUL', '寿命', '剩余', 'Weibull', '概率')) {
      if (!s.prediction) return '尚未预测 RUL。请在"趋势分析"页面选择单元并点击"预测 RUL"。';
      const r = s.prediction;
      return `RUL 预测结果(单元 ${r.unit_id},周期 ${r.cycle}):\n` +
        `Weibull 参数:λ=${API.fmtNum(r.weibull.lam, 2)},k=${API.fmtNum(r.weibull.k, 4)}\n` +
        `参与拟合正样本数:${r.weibull.n_samples}(排除 RUL=0 ${(r.weibull.n_zero || 0)} 个),参考集规模:${r.n_reference}\n` +
        `离散概率分布已生成(h_max=${r.discrete.h_max},归一化=${r.discrete.is_normalized})。`;
    }
    if (has('假设', '可信度', '收敛')) {
      const all = [];
      if (s.data.qualityReport) all.push('【数据体检】', ...s.data.qualityReport.assumptions);
      if (s.prediction) all.push('【RUL 预测】', ...s.prediction.assumptions);
      if (s.appliedScenario) all.push('【维修决策】', ...s.appliedScenario.assumptions);
      if (s.backtest) all.push('【离线回测】', ...s.backtest.assumptions);
      if (s.appliedScenario && Object.keys(s.appliedScenario.ieo_traces).length) {
        for (const [tn, t] of Object.entries(s.appliedScenario.ieo_traces)) {
          all.push(`【IEO 可信度·${tn}】${t.converged ? '已收敛' : '未收敛'},实际步数 ${t.n_steps_actual},最终 σ=${API.fmtNum(t.final_sigma, 2)}`);
        }
      }
      return all.length ? all.join('\n') : '尚无假设说明。请先上传数据并执行分析。';
    }
    if (has('导出', '下载', 'JSON', 'CSV')) {
      return '导出方式:\n· 维修决策结果:在"维修决策"页面点击"导出 JSON"\n· 回测结果:在"离线回测"页面点击"导出 CSV"';
    }
    if (has('成本', '期望', '费用')) {
      if (!s.appliedScenario) return '请先运行维修决策分析。';
      const d = s.appliedScenario;
      const etoc = d.strategies['ETO-C'];
      return `当前成本参数:cm=${d.params.cm}, cd=${d.params.cd}, cp=${d.params.cp}, cc=${d.params.cc}, alpha=${d.params.alpha}\n` +
        `ETO-C 推荐窗口 ${etoc.optimal_window}:单次期望成本 E[C1]=${API.fmtNum(etoc.expected_cost, 4)},期望总成本 E[TC]=${API.fmtNum(etoc.expected_total_cost, 4)}`;
    }
    return '当前为离线问答模式,支持的问题主题:数据质量、设备单元、RUL 预测、维修窗口、成本、ETO/IEO 对比、回测指标、假设说明、导出方式。\n请尝试快捷问题或换一种问法。';
  }

  function isRunning() {
    return PO.requests.isBusy('agent');
  }

  return { submit, answerOffline, extractCandidates, isRunning };
})();