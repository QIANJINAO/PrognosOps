/* ═══════════════════════════════════════════════
   PrognosOps 快照导出(export.js)
   职责:从指定运行的不可变快照导出决策 JSON / 回测 CSV / Agent 报告,
        不发新计算,不读当前状态(同 runId 两次导出业务内容相同)
   挂载:window.PO.export
   依赖:state.js(PO)
   设计约束(施工单 S16):
   - 只接指定 run 的不可变快照,不替换为当前结果;
   - 决策 JSON 含 runId/数据/设备/时点/参数/预测配置/生成时间与完整 DecisionResult;
   - 回测 CSV 直接序列化已保存 points,不调用 /api/backtest/export-csv 重算;
     缺 points 则返回 ok:false 由 UI 禁用并说明;
   - CSV 列固定 14 列;每 point 按策略键集展开多行;缺失列留空;null 不转 0;
     数值 6 位小数对齐后端契约;加 UTF-8 BOM;下载后释放 Object URL;
   - Agent 完整 report 可下载标"Agent 报告快照";content_preview 只标"仅预览"。
   ═══════════════════════════════════════════════ */
window.PO.export = (() => {
  'use strict';

  // ───────── 常量 ─────────

  /** CSV 固定列(与后端 export_backtest_csv 契约一致) */
  const CSV_COLUMNS = [
    'unit_id', 'cycle', 'true_rul', 'has_true_rul', 'lam', 'k',
    'predicted_rul_mean', 'nll', 'mae_point', 'strategy',
    'chosen_window', 'failure_prob', 'objective_value', 'regret',
  ];

  /** 策略键来源 dict(展开时取并集) */
  const STRATEGY_DICTS = ['chosen_windows', 'failure_probs', 'objective_values', 'regrets'];

  const UTF8_BOM = '\uFEFF';

  // ───────── 工具 ─────────

  /** 深拷贝快照(导出内容不可变,防止后续状态变化影响已生成文件) */
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /** 数值格式化:6 位小数对齐后端契约;null/undefined → 空串 */
  function fmt6(v) {
    if (v === null || v === undefined) return '';
    const n = Number(v);
    if (!isFinite(n)) return '';
    return n.toFixed(6);
  }

  /** 整数/布尔/空值格式化:null/undefined → 空串 */
  function fmtRaw(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  /**
   * 下载文本为文件(加 UTF-8 BOM,下载后释放 Object URL)
   * @param {string} filename - 文件名
   * @param {string} text - 文本内容(不含 BOM,本函数添加)
   * @param {string} mime - MIME 类型
   */
  function download(filename, text, mime) {
    const blob = new Blob([UTF8_BOM + text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); // 兼容 Firefox:需在 DOM 中触发
    a.click();
    document.body.removeChild(a);
    // 延迟释放:部分浏览器需等待下载启动后才能 revoke
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ───────── 回测 CSV 序列化 ─────────

  /**
   * 收集单个 point 涉及的策略键(4 dict 并集,保持首次出现顺序)
   * @returns {string[]} 策略名列表(稳定顺序)
   */
  function collectStrategyKeys(point) {
    const seen = new Set();
    const keys = [];
    STRATEGY_DICTS.forEach(dk => {
      const dict = point[dk] || {};
      Object.keys(dict).forEach(sn => {
        if (!seen.has(sn)) { seen.add(sn); keys.push(sn); }
      });
    });
    return keys;
  }

  /**
   * 将回测 points 序列化为 CSV 文本
   * 展开规则:每个 point 按策略键集合展开为多行;
   *           某策略在某个 dict 中缺失时该列留空;
   *           nll/mae_point 等逐点字段在每个策略行重复;
   *           null/undefined 留空不转 0。
   * @param {Array} points - BacktestPointResult 列表
   * @returns {string} CSV 文本(不含 BOM)
   */
  function serializeBacktestCsv(points) {
    const lines = [CSV_COLUMNS.join(',')];

    (points || []).forEach(p => {
      const tr = fmtRaw(p.true_rul);
      const nllS = fmt6(p.nll);
      const maeS = fmt6(p.mae_point);
      const strategyKeys = collectStrategyKeys(p);

      // 无策略键时仍输出一行(strategy 列留空),保证 point 不丢失
      if (!strategyKeys.length) {
        lines.push([
          fmtRaw(p.unit_id), fmtRaw(p.cycle), tr, fmtRaw(p.has_true_rul),
          fmt6(p.lam), fmt6(p.k), fmt6(p.predicted_rul_mean),
          nllS, maeS, '', '', '', '', '',
        ].join(','));
        return;
      }

      strategyKeys.forEach(sn => {
        const cw = p.chosen_windows && p.chosen_windows[sn] !== undefined ? fmtRaw(p.chosen_windows[sn]) : '';
        const fp = p.failure_probs && p.failure_probs[sn] !== undefined ? fmt6(p.failure_probs[sn]) : '';
        const ov = p.objective_values && p.objective_values[sn] !== undefined ? fmt6(p.objective_values[sn]) : '';
        const rg = p.regrets && p.regrets[sn] !== undefined ? fmt6(p.regrets[sn]) : '';
        lines.push([
          fmtRaw(p.unit_id), fmtRaw(p.cycle), tr, fmtRaw(p.has_true_rul),
          fmt6(p.lam), fmt6(p.k), fmt6(p.predicted_rul_mean),
          nllS, maeS, sn, cw, fp, ov, rg,
        ].join(','));
      });
    });

    return lines.join('\n');
  }

  // ───────── 决策 JSON 构建 ─────────

  /**
   * 构建决策导出 JSON(含元数据 + 完整 DecisionResult,保留原精度)
   * @param {Object} run - predict 运行记录(含 snapshot + decision)
   * @returns {Object} 导出对象
   */
  function buildDecisionJson(run) {
    const snap = run.snapshot || {};
    return {
      runId: run.runId,
      data: { sessionId: snap.sessionId || null },
      device: snap.unitId != null ? snap.unitId : null,
      cycle: snap.cycle != null ? snap.cycle : null,
      params: snap.params ? clone(snap.params) : null,
      predictionConfig: snap.predictionConfig ? clone(snap.predictionConfig) : null,
      generatedAt: run.finishedAt || run.startedAt || null,
      decision: run.decision ? clone(run.decision) : null,
    };
  }

  // ───────── Agent 报告提取 ─────────

  /**
   * 从 Agent 运行的 tool_calls_log 中提取 export_report 工具结果
   * @param {Object} run - agent 运行记录
   * @returns {{type:'report',report:Object}|{type:'preview',preview:string,fullLength:number}|null}
   *          report=完整 JSON 报告可下载;preview=仅 CSV 前 500 字符不可下载;null=无导出工具调用
   */
  function extractAgentExport(run) {
    const result = run.result;
    if (!result || !result.tool_calls_log) return null;
    // 从后往前找最近一次 export_report 调用
    for (let i = result.tool_calls_log.length - 1; i >= 0; i--) {
      const tc = result.tool_calls_log[i];
      if (tc.tool !== 'export_report' || !tc.result || tc.result.error) continue;
      if (tc.result.report) {
        return { type: 'report', report: clone(tc.result.report) };
      }
      if (tc.result.content_preview !== undefined) {
        return { type: 'preview', preview: tc.result.content_preview, fullLength: tc.result.full_length || 0 };
      }
    }
    return null;
  }

  // ───────── 统一导出入口 ─────────

  /**
   * 从指定运行的不可变快照导出文件
   * @param {string} runId - 运行 ID
   * @param {string} format - 导出格式:'json'(决策/Agent) | 'csv'(回测)
   * @returns {{ok:boolean, filename?:string, error?:string}}
   */
  function downloadRun(runId, format) {
    const s = PO.getState();
    const run = s.runs.find(r => r.runId === runId) || null;
    if (!run) return { ok: false, error: '未找到运行记录:' + runId };
    if (run.status !== 'success') return { ok: false, error: '运行未成功完成,无法导出' };

    // ── 回测 CSV ──
    if (run.kind === 'backtest') {
      const bt = run.result;
      const points = bt && bt.points;
      if (!points || points.length === 0) {
        return { ok: false, error: '本次回测结果无逐时点详情(points),无法导出 CSV。请重新运行回测(确保 include_points=true)' };
      }
      const csv = serializeBacktestCsv(points);
      const unitTag = (run.snapshot && run.snapshot.config && run.snapshot.config.unit_ids)
        ? 'unit' + run.snapshot.config.unit_ids.join('-') : 'backtest';
      const filename = 'backtest_' + unitTag + '_' + runId + '.csv';
      download(filename, csv, 'text/csv;charset=utf-8');
      return { ok: true, filename: filename };
    }

    // ── 决策 JSON ──
    if (run.kind === 'predict' && format === 'json') {
      if (!run.decision) return { ok: false, error: '本次运行无决策结果,无法导出决策 JSON' };
      const obj = buildDecisionJson(run);
      const unitTag = obj.device != null ? 'unit' + obj.device : 'decision';
      const cycleTag = obj.cycle != null ? '_cycle' + obj.cycle : '';
      const filename = 'decision_' + unitTag + cycleTag + '_' + runId + '.json';
      download(filename, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
      return { ok: true, filename: filename };
    }

    // ── Agent 报告 JSON ──
    if (run.kind === 'agent' && format === 'json') {
      const extracted = extractAgentExport(run);
      if (!extracted) return { ok: false, error: '本次 Agent 运行未调用导出工具,无可下载报告' };
      if (extracted.type === 'preview') {
        return { ok: false, error: '导出工具仅返回内容预览(content_preview),不提供完整 CSV 下载' };
      }
      const filename = 'agent_report_' + runId + '.json';
      download(filename, JSON.stringify(extracted.report, null, 2), 'application/json;charset=utf-8');
      return { ok: true, filename: filename };
    }

    return { ok: false, error: '不支持的导出组合:kind=' + run.kind + ', format=' + format };
  }

  /**
   * 检查指定运行的可导出性(供 UI 禁用/说明,不触发下载)
   * @param {string} runId
   * @returns {{available:boolean, formats:string[], reason?:string, agentExport?:Object}}
   */
  function checkExportable(runId) {
    const s = PO.getState();
    const run = s.runs.find(r => r.runId === runId) || null;
    if (!run) return { available: false, formats: [], reason: '未找到运行记录' };
    if (run.status !== 'success') return { available: false, formats: [], reason: '运行未成功完成' };

    if (run.kind === 'backtest') {
      const points = run.result && run.result.points;
      if (!points || points.length === 0) {
        return { available: false, formats: [], reason: '无逐时点详情(points),无法导出 CSV' };
      }
      return { available: true, formats: ['csv'] };
    }
    if (run.kind === 'predict') {
      if (!run.decision) return { available: false, formats: [], reason: '无决策结果' };
      return { available: true, formats: ['json'] };
    }
    if (run.kind === 'agent') {
      const extracted = extractAgentExport(run);
      if (!extracted) return { available: false, formats: [], reason: '未调用导出工具' };
      if (extracted.type === 'preview') {
        return { available: false, formats: [], reason: '仅内容预览,无完整下载', agentExport: { type: 'preview' } };
      }
      return { available: true, formats: ['json'], agentExport: { type: 'report' } };
    }
    return { available: false, formats: [], reason: '该运行类型不支持导出' };
  }

  return { downloadRun, checkExportable, serializeBacktestCsv, buildDecisionJson, extractAgentExport, CSV_COLUMNS };
})();