/* ═══════════════════════════════════════════════
   PrognosOps 回测视图(views/backtest-view.js)
   职责:回测配置表单(绑定已应用方案)、阻止态、结果渲染、旧回测来源标明
   挂载:window.PO.backtestView
   依赖:state.js(PO)、controllers/backtest.js(PO.backtest)、
         charts.js(Charts)、api.js(API)、router.js(PO.router)
   设计约束(施工单 S15):
   - 无已应用方案时阻止回测,给"返回分析"入口;
   - 界面展示绑定信息(设备/参数/h_max/来源运行),与请求一致;
   - 敏感性参数选择时实时预览扫描值(含被剔除值标明);
   - 上下文/方案变化后标明旧回测来源,不冒充当前方案验证;
   - 无真值时禁用依赖真值的比较并说明原因;
   - 输入控件一次构建不重建(防丢焦点);切页不重置状态。
   公共接线(路由切换自动挂载)由 S17 合入,本模块仅提供 mount/unmount。
   ═══════════════════════════════════════════════ */
window.PO.backtestView = (() => {
  'use strict';

  let mounted = false, rootEl = null, unsubscribe = null;

  // ───────── 工具 ─────────

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');
  function el(id) { return document.getElementById(id); }
  const fmtNum = (v, d) => API.fmtNum(v, d);
  const fmtPct = (v) => API.fmtPct(v);

  const STRATEGY_ORDER = ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q'];
  const CHART_CAL = 'chart-bt-calibration';
  const CHART_SENS = 'chart-bt-sensitivity';

  // ───────── 旧回测来源判定 ─────────

  /** 最新成功的回测运行记录 */
  function latestBacktestRun(s) {
    for (let i = s.runs.length - 1; i >= 0; i--) {
      const r = s.runs[i];
      if (r.kind === 'backtest' && r.status === 'success') return r;
    }
    return null;
  }

  /**
   * 判断当前 store.backtest 是否来自旧方案/旧上下文
   * @returns {{runId:string, reason:string}|null} 非 null 时需标明旧来源
   */
  function backtestStaleInfo(s) {
    const run = latestBacktestRun(s);
    if (!run || !run.snapshot) return null;
    const snap = run.snapshot;
    if (snap.scenarioRev !== undefined && snap.scenarioRev !== s.context.scenarioRev) {
      return { runId: run.runId, reason: '决策方案已变化(已应用新参数)' };
    }
    if (snap.contextRev !== undefined && snap.contextRev !== s.context.contextRev) {
      return { runId: run.runId, reason: '上下文已变化(设备/数据)' };
    }
    return null;
  }

  // ───────── UI 配置读取 ─────────

  /**
   * 从表单读取回测配置(不含绑定字段,由 PO.backtest.runCurrent 注入)
   * random_seed: 空串→null(不固定);'0'→0(保留,修复旧页 if(seed) 丢 0 缺陷)
   */
  function readUiConfig() {
    const seedRaw = el('bt-seed').value.trim();
    return {
      data_mode: el('bt-mode').value,
      step: parseInt(el('bt-step').value, 10) || 10,
      min_cycle: parseInt(el('bt-min-cycle').value, 10) || 30,
      k_nn: parseInt(el('bt-knn').value, 10) || 50,
      n_repeats: parseInt(el('bt-repeats').value, 10) || 1,
      n_calibration_bins: parseInt(el('bt-bins').value, 10) || 10,
      random_seed: seedRaw !== '' ? parseInt(seedRaw, 10) : null,
      sensitivity_param: el('bt-sens-param').value || null,
    };
  }

  // ───────── 绑定信息 ─────────

  function bindingText(s) {
    const a = s.appliedScenario;
    const p = a.params || {};
    const hMax = a.h_max != null ? a.h_max : (p.h_max != null ? p.h_max : 150);
    return '设备 #' + s.context.unitId
      + ' | h_max=' + hMax
      + ' | 参数 cm=' + p.cm + ', cd=' + p.cd + ', cp=' + p.cp + ', cc=' + p.cc + ', α=' + p.alpha
      + (a._runId ? ' | 来源 ' + a._runId : '');
  }

  // ───────── 渲染:配置区 ─────────

  function renderConfig(s) {
    const blocked = el('bt-blocked');
    const form = el('bt-form');
    const applied = s.appliedScenario;

    // 无已应用方案 → 阻止态 + 返回分析入口
    if (!applied || !applied.params) {
      if (blocked) blocked.hidden = false;
      if (form) form.hidden = true;
      return;
    }
    if (blocked) blocked.hidden = true;
    if (form) form.hidden = false;

    // 绑定信息(设备/参数/h_max/来源运行)
    const bind = el('bt-binding');
    if (bind) bind.textContent = '绑定:' + bindingText(s);

    // 运行按钮:回测进行中禁用
    const btn = el('bt-run-btn');
    if (btn) btn.disabled = !!PO.requests.isBusy('backtest');

    renderSensInfo(s);
  }

  /** 敏感性参数选择时实时预览扫描值(含被剔除值与不足两项提示) */
  function renderSensInfo(s) {
    const info = el('bt-sens-info');
    if (!info) return;
    const sel = el('bt-sens-param');
    const param = sel ? sel.value : '';
    if (!param || !s.appliedScenario || !s.appliedScenario.params) { info.hidden = true; return; }
    const sens = PO.backtest.buildSensitivityValues(param, s.appliedScenario.params);
    let text = '基点 ' + param + '=' + Number(s.appliedScenario.params[param])
      + ',扫描值 [' + sens.values.join(', ') + ']';
    if (sens.invalid.length) text += '(已剔除:' + sens.invalid.join(', ') + ')';
    if (sens.values.length < 2) text += ' — 有效值不足两项,无法运行敏感性,请调整参数或关闭';
    info.textContent = text;
    info.hidden = false;
  }

  // ───────── 渲染:结果区 ─────────

  function renderResult(s) {
    const emptyEl = el('bt-result-empty');
    const contentEl = el('bt-result-content');
    const staleEl = el('bt-result-stale');
    const bt = s.backtest;

    if (!bt) {
      if (emptyEl) emptyEl.hidden = false;
      if (contentEl) contentEl.hidden = true;
      if (staleEl) staleEl.hidden = true;
      Charts.destroy(CHART_CAL);
      Charts.destroy(CHART_SENS);
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (contentEl) contentEl.hidden = false;

    // 旧回测来源标明(不冒充当前方案验证)
    const stale = backtestStaleInfo(s);
    if (staleEl) {
      if (stale) {
        staleEl.textContent = '旧回测来源:' + stale.reason + '(来源运行 ' + stale.runId + '),不代表当前方案验证结果';
        staleEl.hidden = false;
      } else {
        staleEl.hidden = true;
      }
    }

    renderSummary(bt);
    renderStrategyTable(bt);
    renderDiffTable(bt);
    renderCalibration(bt);
    renderSensitivity(bt);
    renderAssumptions(bt);
  }

  /** 摘要卡片 + 无真值禁用说明 */
  function renderSummary(bt) {
    const box = el('bt-summary');
    if (!box) return;
    const cards = [
      { label: '回测时点数', value: String(bt.n_points), cls: 'po-stat-accent' },
      { label: '回测单元数', value: String(bt.n_units), cls: '' },
      {
        label: '真实 RUL',
        value: bt.has_true_rul ? '有' : '无',
        cls: bt.has_true_rul ? 'po-stat-accent' : 'po-stat-warn',
        aux: bt.has_true_rul ? '可计算 regret' : 'regret 不可用',
      },
      {
        label: 'NLL 均值',
        value: bt.nll_mean !== null && bt.nll_mean !== undefined ? fmtNum(bt.nll_mean, 4) : '—',
        cls: '',
        aux: bt.nll_std !== null && bt.nll_std !== undefined ? 'std=' + fmtNum(bt.nll_std, 4) : '',
      },
      {
        label: 'MAE 均值',
        value: bt.mae_mean !== null && bt.mae_mean !== undefined ? fmtNum(bt.mae_mean, 2) : '—',
        cls: '',
        aux: bt.mae_std !== null && bt.mae_std !== undefined ? 'std=' + fmtNum(bt.mae_std, 2) : '',
      },
    ];
    box.innerHTML = cards.map(c =>
      '<div class="po-stat-card ' + c.cls + '">'
      + '<div class="po-stat-value">' + c.value + '</div>'
      + '<div class="po-stat-label">' + esc(c.label) + '</div>'
      + (c.aux ? '<div class="po-stat-aux">' + esc(c.aux) + '</div>' : '')
      + '</div>'
    ).join('');

    // 无真值时禁用依赖真值的比较并说明原因
    const note = el('bt-truerul-note');
    if (note) {
      if (!bt.has_true_rul) {
        note.textContent = '无真实 RUL 标签:regret / NLL / MAE / 校准依赖真值,已禁用并以"—"标注';
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    }

    // 数据充分性说明
    const suf = el('bt-sufficiency-note');
    if (suf) {
      if (bt.data_sufficiency_note) { suf.textContent = bt.data_sufficiency_note; suf.hidden = false; }
      else suf.hidden = true;
    }
  }

  /** 策略汇总表(regret 等真值指标无真值时为 null → 显示"—") */
  function renderStrategyTable(bt) {
    const box = el('bt-strategy-table');
    if (!box) return;
    const names = Object.keys(bt.strategies || {});
    const rows = names.map(sn => {
      const r = bt.strategies[sn];
      return '<tr>'
        + '<td class="po-name">' + esc(r.strategy || sn) + '</td>'
        + '<td class="po-num">' + r.n_points + '</td>'
        + '<td class="po-num">' + (r.regret_mean !== null && r.regret_mean !== undefined ? fmtNum(r.regret_mean, 4) : '—') + '</td>'
        + '<td class="po-num">' + (r.regret_median !== null && r.regret_median !== undefined ? fmtNum(r.regret_median, 4) : '—') + '</td>'
        + '<td class="po-num">' + (r.regret_std !== null && r.regret_std !== undefined ? fmtNum(r.regret_std, 4) : '—') + '</td>'
        + '<td class="po-num">' + (r.failure_frequency !== null && r.failure_frequency !== undefined ? fmtPct(r.failure_frequency) : '—') + '</td>'
        + '<td class="po-num">' + fmtPct(r.mean_failure_prob) + '</td>'
        + '<td class="po-num">' + (r.ece !== null && r.ece !== undefined ? fmtNum(r.ece, 4) : '—') + '</td>'
        + '</tr>';
    }).join('');
    box.innerHTML = '<table class="po-table"><thead><tr>'
      + '<th>策略</th><th>时点数</th><th>regret均值</th><th>regret中位数</th><th>regret标准差</th>'
      + '<th>失效频率</th><th>平均预测失效概率</th><th>ECE</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /** ETO-IEO 差异表 */
  function renderDiffTable(bt) {
    const box = el('bt-diff-table');
    if (!box) return;
    const keys = Object.keys(bt.eto_ieo_diff || {});
    if (!keys.length) { box.innerHTML = '<p class="po-aux">无 ETO/IEO 差异数据</p>'; return; }
    const rows = keys.map(dk => {
      const d = bt.eto_ieo_diff[dk];
      return '<tr>'
        + '<td class="po-name">' + esc(d.target || dk) + '</td>'
        + '<td class="po-num">' + fmtNum(d.window_diff_mean, 2) + '</td>'
        + '<td class="po-num">' + fmtNum(d.window_diff_std, 2) + '</td>'
        + '<td class="po-num">' + fmtNum(d.objective_diff_mean, 4) + '</td>'
        + '<td class="po-num">' + fmtNum(d.objective_diff_std, 4) + '</td>'
        + '<td class="po-num po-num-good">' + d.n_ieo_better + '</td>'
        + '<td class="po-num po-num-bad">' + d.n_ieo_worse + '</td>'
        + '<td class="po-num">' + d.n_ieo_same + '</td>'
        + '</tr>';
    }).join('');
    box.innerHTML = '<table class="po-table"><thead><tr>'
      + '<th>目标</th><th>窗口差均值</th><th>窗口差标准差</th><th>目标差均值</th><th>目标差标准差</th>'
      + '<th>IEO更优</th><th>IEO更差</th><th>相同</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /** 校准图(取第一个有校准数据的策略;空 bins 由 Charts.calibration S14 空态处理) */
  function renderCalibration(bt) {
    Charts.destroy(CHART_CAL);
    const names = Object.keys(bt.strategies || {});
    const calName = names.find(sn => bt.strategies[sn].calibration_bins && bt.strategies[sn].calibration_bins.length > 0);
    Charts.calibration(CHART_CAL, calName ? bt.strategies[calName].calibration_bins : [], calName || '');
  }

  /** 敏感性图(无敏感性数据时隐藏区域) */
  function renderSensitivity(bt) {
    const section = el('bt-sens-section');
    if (!section) return;
    if (bt.sensitivity && bt.sensitivity.length > 0) {
      section.hidden = false;
      Charts.destroy(CHART_SENS);
      Charts.sensitivity(CHART_SENS, bt.sensitivity, (bt.config && bt.config.sensitivity_param) || '');
    } else {
      section.hidden = true;
      Charts.destroy(CHART_SENS);
    }
  }

  /** 假设列表 */
  function renderAssumptions(bt) {
    const box = el('bt-assumptions');
    if (!box) return;
    const list = bt.assumptions || [];
    box.innerHTML = list.length
      ? list.map(a => '<div class="po-assumption-item">' + esc(a) + '</div>').join('')
      : '<p class="po-aux">无假设说明</p>';
  }

  // ───────── 运行回测 ─────────

  async function runBacktest() {
    const statusEl = el('bt-status');
    const btn = el('bt-run-btn');
    if (btn) btn.disabled = true;
    if (statusEl) { statusEl.textContent = '回测运行中...'; statusEl.hidden = false; }

    try {
      const r = await PO.backtest.runCurrent(readUiConfig());
      if (!r.ok) {
        // 阻止原因(无方案/敏感性不足两项/锁占用等)
        if (statusEl) { statusEl.textContent = r.error || '无法运行回测'; statusEl.hidden = false; }
        return;
      }
      if (r.stale) {
        // 迟到回包仅归档:方案/上下文已变化,结果不作为当前验证
        if (statusEl) { statusEl.textContent = '方案/上下文已变化,本次回测结果仅归档,未更新当前结果'; statusEl.hidden = false; }
        return;
      }
      if (statusEl) {
        statusEl.textContent = '回测完成:' + r.result.n_points + ' 个时点,' + r.result.n_units + ' 个单元';
        statusEl.hidden = false;
      }
    } catch (err) {
      // API 错误(API.showApiError 归一化对象)
      const msg = err && err.message ? err.message : '回测失败';
      if (statusEl) { statusEl.textContent = '回测失败:' + msg; statusEl.hidden = false; }
    } finally {
      if (btn) btn.disabled = !!PO.requests.isBusy('backtest');
    }
  }

  // ───────── 统一渲染 ─────────

  function renderAll(s) {
    renderConfig(s);
    renderResult(s);
    renderArtifact(s);
  }

  // ───────── 渲染:产物下载(S17:挂 artifactList,从最新回测 run 快照导出) ─────────
  function renderArtifact(s) {
    const root = el('bt-artifact-body');
    if (!root) return;
    // 找最新 backtest success run(有完整 result,未被 pruneRuns 释放)
    const btRun = s.runs
      .filter(r => r.kind === 'backtest' && r.status === 'success' && r.result)
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0] || null;
    if (!btRun) {
      root.innerHTML = '<div class="po-empty"><p>运行回测后可从结果快照导出 CSV</p></div>';
      return;
    }
    PO.artifactList.render(root, btRun);
  }

  // ═══════════════ 挂载/卸载 ═══════════════

  function mount(root) {
    if (mounted) return; // 防重复挂载
    mounted = true;
    rootEl = root;

    // 壳:配置面板 + 结果面板(输入控件一次构建,renderAll 不重建)
    rootEl.innerHTML = ''
      + '<div class="po-panel">'
      + '  <h2 class="po-panel-title">回测验证</h2>'
      + '  <div id="bt-config-body">'
      // 阻止态:无已应用方案
      + '    <div id="bt-blocked" class="po-empty" hidden>'
      + '      <p>尚未应用决策方案,无法绑定回测参数。</p>'
      + '      <p class="po-aux">回测以已应用方案的参数为基准,请先在工作台完成分析并应用方案。</p>'
      + '      <div class="po-empty-actions">'
      + '        <button class="po-btn po-btn-primary" id="bt-goto-workspace">返回分析</button>'
      + '      </div>'
      + '    </div>'
      // 配置表单
      + '    <div id="bt-form" hidden>'
      + '      <div id="bt-binding" class="po-binding-bar"></div>'
      + '      <div class="po-form-grid">'
      + '        <div class="po-field"><label class="po-field-label" for="bt-mode">数据模式</label>'
      + '          <select class="po-select" id="bt-mode">'
      + '            <option value="offline">offline(有真实 RUL)</option>'
      + '            <option value="online">online(无真实 RUL)</option>'
      + '          </select></div>'
      + '        <div class="po-field"><label class="po-field-label" for="bt-step">决策时点间隔(周期)</label>'
      + '          <input class="po-input" id="bt-step" type="text" inputmode="numeric" value="10" autocomplete="off"></div>'
      + '        <div class="po-field"><label class="po-field-label" for="bt-min-cycle">最早决策时点</label>'
      + '          <input class="po-input" id="bt-min-cycle" type="text" inputmode="numeric" value="30" autocomplete="off"></div>'
      + '        <div class="po-field"><label class="po-field-label" for="bt-knn">kNN 近邻数</label>'
      + '          <input class="po-input" id="bt-knn" type="text" inputmode="numeric" value="50" autocomplete="off"></div>'
      + '        <div class="po-field"><label class="po-field-label" for="bt-repeats">重复实验次数</label>'
      + '          <input class="po-input" id="bt-repeats" type="text" inputmode="numeric" value="1" autocomplete="off"></div>'
      + '        <div class="po-field"><label class="po-field-label" for="bt-seed">随机种子</label>'
      + '          <input class="po-input" id="bt-seed" type="text" inputmode="numeric" value="0" autocomplete="off">'
      + '          <span class="po-aux">留空不固定;0 为合法值</span></div>'
      + '        <div class="po-field"><label class="po-field-label" for="bt-bins">校准分箱数</label>'
      + '          <input class="po-input" id="bt-bins" type="text" inputmode="numeric" value="10" autocomplete="off"></div>'
      + '        <div class="po-field"><label class="po-field-label" for="bt-sens-param">敏感性分析参数</label>'
      + '          <select class="po-select" id="bt-sens-param">'
      + '            <option value="">不分析</option>'
      + '            <option value="cm">cm(计划更换成本)</option>'
      + '            <option value="cd">cd(停机损失成本)</option>'
      + '            <option value="cp">cp(故障更换成本)</option>'
      + '            <option value="cc">cc(劣质产出成本)</option>'
      + '            <option value="alpha">alpha(质量劣化权重)</option>'
      + '          </select></div>'
      + '      </div>'
      + '      <div id="bt-sens-info" class="po-status-bar po-status-info" hidden></div>'
      + '      <div id="bt-status" class="po-status-bar" hidden aria-live="polite"></div>'
      + '      <div class="po-empty-actions" style="margin-top:var(--po-space-4)">'
      + '        <button class="po-btn po-btn-accent" id="bt-run-btn">运行回测</button>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      + '<div class="po-panel">'
      + '  <h2 class="po-panel-title">回测结果</h2>'
      + '  <div id="bt-result-body">'
      + '    <div id="bt-result-empty" class="po-empty"><p>尚未运行回测</p></div>'
      + '    <div id="bt-result-stale" class="po-stale-bar" hidden></div>'
      + '    <div id="bt-result-content" hidden>'
      + '      <div id="bt-summary" class="po-stat-row"></div>'
      + '      <div id="bt-truerul-note" class="po-status-bar po-status-warn" hidden></div>'
      + '      <div id="bt-sufficiency-note" class="po-status-bar po-status-info" hidden></div>'
      + '      <h3 class="po-section-title">策略汇总</h3>'
      + '      <div id="bt-strategy-table" class="po-table-scroll"></div>'
      + '      <h3 class="po-section-title">ETO / IEO 差异</h3>'
      + '      <div id="bt-diff-table" class="po-table-scroll"></div>'
      + '      <h3 class="po-section-title">校准</h3>'
      + '      <div class="po-chart-wrap"><canvas id="chart-bt-calibration"></canvas></div>'
      + '      <div id="bt-sens-section" hidden>'
      + '        <h3 class="po-section-title">敏感性</h3>'
      + '        <div class="po-chart-wrap"><canvas id="chart-bt-sensitivity"></canvas></div>'
      + '      </div>'
      + '      <h3 class="po-section-title">假设</h3>'
      + '      <div id="bt-assumptions"></div>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      // S17:产物下载面板(挂 artifactList)
      + '<div class="po-panel">'
      + '  <h2 class="po-panel-title">产物下载</h2>'
      + '  <div id="bt-artifact-body"></div>'
      + '</div>';

    // ── 事件绑定(一次,不随 renderAll 重建) ──
    const gotoBtn = el('bt-goto-workspace');
    if (gotoBtn) gotoBtn.addEventListener('click', () => PO.router.navigate('chat'));
    const runBtn = el('bt-run-btn');
    if (runBtn) runBtn.addEventListener('click', runBacktest);
    const sensSel = el('bt-sens-param');
    if (sensSel) sensSel.addEventListener('change', () => renderSensInfo(PO.getState()));

    // 常驻订阅:状态变化 → 渲染(切页不重置)
    unsubscribe = PO.subscribe(renderAll);
    renderAll(PO.getState());
  }

  function unmount() {
    Charts.destroy(CHART_CAL);
    Charts.destroy(CHART_SENS);
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (rootEl) rootEl.innerHTML = '';
    mounted = false;
    rootEl = null;
  }

  return { mount, unmount };
})();