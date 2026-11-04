/* ═══════════════════════════════════════════════
   T16:从同次结果快照导出(S16)
   覆盖施工单验收:
   - 下载不发新计算(不调 /api/backtest/export-csv)
   - 同 runId 两次导出业务内容相同
   - CSV 行数 = points 数 × 实际返回策略数
   - 逐行核对窗口/成本/regret,null 不转 0
   - 决策 JSON 含 runId/设备/时点/参数/完整 DecisionResult
   - 缺 points 禁用并说明;Agent content_preview 只标"仅预览"
   - 历史下载标明原来源,不替换为当前结果
   ═══════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');
const apiFx = require('./fixtures/api-fixture.js');

const NEXT_URL = 'http://127.0.0.1:8765/static/index.html';

/** 公共 setup:路由 health + export-csv(计数,验证不调用) + 基础上下文 */
async function setupExportPage(page) {
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));

  let exportCsvCalls = 0;
  await page.route('**/api/backtest/export-csv', async r => {
    exportCsvCalls++;
    await r.fulfill({ status: 200, contentType: 'text/csv', body: 'should,not,be,called' });
  });

  await page.goto(NEXT_URL);
  await page.evaluate(() => PO.setContext({ sessionId: 'fx-session', unitId: 101, cycle: 40 }));

  return { getExportCsvCalls: () => exportCsvCalls };
}

/** 在 store 中创建一个成功的回测运行(含 points) */
async function createBacktestRun(page, { points, config } = {}) {
  return await page.evaluate(({ points, config }) => {
    const snapshot = {
      contextRev: PO.getState().context.contextRev,
      scenarioRev: PO.getState().context.scenarioRev,
      sessionId: 'fx-session',
      config: config || { include_points: true, unit_ids: [101], decision_params: { cm: 10, cd: 5, cp: 100, cc: 500, alpha: 0.95, h_max: 150 } },
    };
    const runId = PO.startRun('backtest', snapshot);
    const bt = {
      config: snapshot.config,
      n_points: points.length,
      n_units: 1,
      has_true_rul: true,
      nll_mean: 3.45, nll_std: 0.8,
      mae_mean: 12.5, mae_std: 4.2,
      strategies: {},
      eto_ieo_diff: {},
      sensitivity: [],
      points: points,
      repeat_metrics: [],
      assumptions: [],
      data_sufficiency_note: '',
    };
    PO.finishRun(runId, bt);
    return runId;
  }, { points, config });
}

// ───────── T16-1 回测 CSV:不重算 + 行数 + null 不转 0 ─────────

test('T16-1 回测 CSV 从快照序列化,不调 export-csv;行数=points×策略数,null 留空', async ({ page }) => {
  const helper = await setupExportPage(page);

  // 构造 points:2 个时点,策略键集合不同,含 null/缺失
  const points = [
    {
      unit_id: 101, cycle: 40, true_rul: 8, has_true_rul: true,
      lam: 55.0, k: 2.1, predicted_rul_mean: 48.5, nll: 3.2, mae_point: 40.5,
      chosen_windows: { 'ETO-C': 30, 'IEO-C': 32 },
      failure_probs: { 'ETO-C': 0.15 },           // IEO-C 缺失
      objective_values: { 'ETO-C': 415.0, 'IEO-C': 410.5 },
      regrets: { 'ETO-C': 10.0, 'IEO-C': null },   // IEO-C regret=null
    },
    {
      unit_id: 101, cycle: 50, true_rul: null, has_true_rul: false,
      lam: 68.0, k: 2.5, predicted_rul_mean: 60.2, nll: null, mae_point: null,
      chosen_windows: { 'ETO-Q': 25 },
      failure_probs: { 'ETO-Q': 0.08 },
      objective_values: { 'ETO-Q': 3.8 },
      regrets: { 'ETO-Q': null },  // 无真值 → regret=null
    },
  ];

  const runId = await createBacktestRun(page, { points });

  // serializeBacktestCsv 直接验证(纯函数)
  const csv = await page.evaluate((rid) => {
    const run = PO.getState().runs.find(r => r.runId === rid);
    return PO.export.serializeBacktestCsv(run.result.points);
  }, runId);

  const lines = csv.split('\n');
  // 表头 1 行 + point1 展开策略键并集 {ETO-C,IEO-C} 2 行 + point2 {ETO-Q} 1 行 = 4 行
  expect(lines.length).toBe(4);
  expect(lines[0]).toBe('unit_id,cycle,true_rul,has_true_rul,lam,k,predicted_rul_mean,nll,mae_point,strategy,chosen_window,failure_prob,objective_value,regret');

  // point1 ETO-C 行:窗口 30、失效概率 0.15、目标 415、regret 10
  const row1 = lines[1].split(',');
  expect(row1[9]).toBe('ETO-C');
  expect(row1[10]).toBe('30');
  expect(row1[11]).toBe('0.150000');
  expect(row1[12]).toBe('415.000000');
  expect(row1[13]).toBe('10.000000');

  // point1 IEO-C 行:failure_probs 缺失 → 留空;regret=null → 留空不转 0
  const row2 = lines[2].split(',');
  expect(row2[9]).toBe('IEO-C');
  expect(row2[10]).toBe('32');
  expect(row2[11]).toBe('');        // failure_prob 缺失留空
  expect(row2[12]).toBe('410.500000');
  expect(row2[13]).toBe('');        // regret=null 留空,不转 0

  // point2 ETO-Q 行:true_rul=null → 留空;nll=null → 留空
  const row3 = lines[3].split(',');
  expect(row3[2]).toBe('');          // true_rul null 留空
  expect(row3[3]).toBe('false');
  expect(row3[7]).toBe('');          // nll null 留空
  expect(row3[8]).toBe('');          // mae_point null 留空
  expect(row3[13]).toBe('');         // regret null 留空

  // downloadRun 不触发 export-csv
  const r = await page.evaluate((rid) => PO.export.downloadRun(rid, 'csv'), runId);
  expect(r.ok).toBe(true);
  expect(helper.getExportCsvCalls()).toBe(0);

  // 同 runId 两次导出业务内容相同
  const csv2 = await page.evaluate((rid) => {
    const run = PO.getState().runs.find(r => r.runId === rid);
    return PO.export.serializeBacktestCsv(run.result.points);
  }, runId);
  expect(csv2).toBe(csv);
});

// ───────── T16-2 决策 JSON:元数据完整 + 保留原精度 ─────────

test('T16-2 决策 JSON 含 runId/设备/时点/参数/预测配置/完整 DecisionResult', async ({ page }) => {
  await setupExportPage(page);

  // 创建 predict 运行(含 decision)
  const runId = await page.evaluate(() => {
    const snap = {
      sessionId: 'fx-session', unitId: 101, cycle: 40,
      predictionConfig: { k_nn: 50, random_seed: 42 },
      contextRev: PO.getState().context.contextRev,
      scenarioRev: PO.getState().context.scenarioRev,
      params: { cm: 10, cd: 5, cp: 100, cc: 500, alpha: 0.95, h_max: 150 },
    };
    const runId = PO.startRun('predict', snap);
    const pred = { sessionId: 'fx-session', unitId: 101, cycle: 40,
      weibull: { lam: 55.0, k: 2.1 }, discrete: { h_max: 150, probs: [0.01, 0.02] },
      n_reference: 120, assumptions: [] };
    PO.commitPrediction(runId, pred);
    const dec = { params: snap.params, windows: [0, 5, 10], cost_curve: [1.0], total_cost_curve: [2.0],
      quality_curve: [0.5], total_quality_curve: [1.0], failure_prob_curve: [0.1], expected_life_curve: [50],
      strategies: { 'ETO-C': { strategy: 'ETO-C', optimal_window: 30, objective_value: 415.0,
        expected_cost: 415.0, expected_total_cost: 415.0, expected_quality: 0.85,
        expected_total_quality: 4.2, failure_prob: 0.12, expected_life: 55.0,
        diff_window_vs_eto: 0, diff_objective_vs_eto: 0.0 } },
      ieo_traces: {}, assumptions: ['假设1'] };
    PO.updateRun(runId, { decision: dec });
    PO.finishRun(runId, pred);
    return runId;
  });

  // buildDecisionJson 验证
  const obj = await page.evaluate((rid) => {
    const run = PO.getState().runs.find(r => r.runId === rid);
    return PO.export.buildDecisionJson(run);
  }, runId);

  expect(obj.runId).toBe(runId);
  expect(obj.data.sessionId).toBe('fx-session');
  expect(obj.device).toBe(101);
  expect(obj.cycle).toBe(40);
  expect(obj.params.cm).toBe(10);
  expect(obj.params.cd).toBe(5);
  expect(obj.predictionConfig.k_nn).toBe(50);
  expect(obj.generatedAt).toBeTruthy();
  // 完整 DecisionResult 保留原精度
  expect(obj.decision.strategies['ETO-C'].objective_value).toBe(415.0);
  expect(obj.decision.strategies['ETO-C'].failure_prob).toBe(0.12);
  expect(obj.decision.windows).toEqual([0, 5, 10]);

  // downloadRun 文件名含设备/时点/runId
  const r = await page.evaluate((rid) => PO.export.downloadRun(rid, 'json'), runId);
  expect(r.ok).toBe(true);
  expect(r.filename).toContain('unit101');
  expect(r.filename).toContain('cycle40');
  expect(r.filename).toContain(runId);
  expect(r.filename.endsWith('.json')).toBe(true);
});

// ───────── T16-3 缺 points 禁用 + Agent content_preview 仅预览 ─────────

test('T16-3 回测缺 points 禁用导出;Agent content_preview 标"仅预览"无下载入口', async ({ page }) => {
  await setupExportPage(page);

  // 场景A:回测无 points(include_points=false)
  const btRunId = await page.evaluate(() => {
    const snap = { contextRev: PO.getState().context.contextRev, scenarioRev: null,
      sessionId: 'fx-session', config: { include_points: false } };
    const runId = PO.startRun('backtest', snap);
    PO.finishRun(runId, { config: snap.config, n_points: 12, n_units: 3, has_true_rul: true,
      nll_mean: 3.45, nll_std: 0.8, mae_mean: 12.5, mae_std: 4.2,
      strategies: {}, eto_ieo_diff: {}, sensitivity: [], points: [], repeat_metrics: [],
      assumptions: [], data_sufficiency_note: '' });
    return runId;
  });

  const btCheck = await page.evaluate((rid) => PO.export.checkExportable(rid), btRunId);
  expect(btCheck.available).toBe(false);
  expect(btCheck.reason).toContain('points');

  const btDownload = await page.evaluate((rid) => PO.export.downloadRun(rid, 'csv'), btRunId);
  expect(btDownload.ok).toBe(false);
  expect(btDownload.error).toContain('points');

  // 场景B:Agent content_preview(仅预览,不可下载)
  const agentRunId = await page.evaluate(() => {
    const snap = { contextRev: PO.getState().context.contextRev, scenarioRev: null,
      sessionId: 'fx-session', unitId: 101, cycle: 40, probs: [], h_max: 150, current_params: {} };
    const runId = PO.startRun('agent', snap);
    PO.finishRun(runId, {
      answer: '已生成导出预览',
      tool_calls_log: [
        { tool: 'export_report', args: { format: 'csv' }, result: {
          tool: 'export_report', format: 'csv',
          content_preview: 'unit_id,cycle,true_rul...', full_length: 500,
          note: '完整 CSV 可通过 /api/backtest/export-csv 端点下载',
        }, round: 1 },
      ],
      model_used: 'fixture-mock', n_rounds: 1,
    });
    return runId;
  });

  const agentCheck = await page.evaluate((rid) => PO.export.checkExportable(rid), agentRunId);
  expect(agentCheck.available).toBe(false);
  expect(agentCheck.agentExport.type).toBe('preview');

  // 渲染下载卡:显示"仅预览",无下载按钮
  await page.evaluate(() => PO.router.navigate('validation'));
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'test-artifact-root';
    document.getElementById('page-validation').appendChild(root);
  });
  const agentRun = await page.evaluate((rid) => PO.getState().runs.find(r => r.runId === rid), agentRunId);
  await page.evaluate((run) => {
    PO.artifactList.render(document.getElementById('test-artifact-root'), run);
  }, agentRun);

  await expect(page.locator('#test-artifact-root .po-artifact-preview-tag')).toBeVisible();
  await expect(page.locator('#test-artifact-root .po-artifact-preview-tag')).toContainText('仅预览');
  // 无下载按钮
  await expect(page.locator('#test-artifact-root .po-artifact-btn')).toHaveCount(0);
});

// ───────── T16-4 Agent 完整 report 可下载 + 历史来源标明 ─────────

test('T16-4 Agent report 可下载标"Agent 报告快照";历史下载标明原来源不替换当前', async ({ page }) => {
  await setupExportPage(page);

  // 创建 Agent 运行(含完整 report)
  const agentRunId = await page.evaluate(() => {
    const snap = { contextRev: PO.getState().context.contextRev, scenarioRev: null,
      sessionId: 'fx-session', unitId: 101, cycle: 40, probs: [], h_max: 150, current_params: {} };
    const runId = PO.startRun('agent', snap);
    PO.finishRun(runId, {
      answer: '已生成报告',
      tool_calls_log: [
        { tool: 'export_report', args: { format: 'json' }, result: {
          tool: 'export_report', format: 'json',
          report: { session_id: 'fx-session', quality_report: { file_name: 'test.csv',
            total_rows: 100, unit_count: 4, is_valid: true },
            decision: { strategy: 'ETO-C', window: 30 } },
        }, round: 1 },
      ],
      model_used: 'fixture-mock', n_rounds: 1,
    });
    return runId;
  });

  // 可下载
  const check = await page.evaluate((rid) => PO.export.checkExportable(rid), agentRunId);
  expect(check.available).toBe(true);
  expect(check.formats).toEqual(['json']);
  expect(check.agentExport.type).toBe('report');

  const r = await page.evaluate((rid) => PO.export.downloadRun(rid, 'json'), agentRunId);
  expect(r.ok).toBe(true);
  expect(r.filename).toContain('agent_report');
  expect(r.filename).toContain(agentRunId);

  // 渲染下载卡:标"Agent 报告快照" + 来源含原 runId
  await page.evaluate(() => PO.router.navigate('validation'));
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'test-artifact-root2';
    document.getElementById('page-validation').appendChild(root);
  });
  const agentRun = await page.evaluate((rid) => PO.getState().runs.find(r => r.runId === rid), agentRunId);
  await page.evaluate((run) => {
    PO.artifactList.render(document.getElementById('test-artifact-root2'), run);
  }, agentRun);

  await expect(page.locator('#test-artifact-root2 .po-artifact-name')).toContainText('Agent 报告快照');
  await expect(page.locator('#test-artifact-root2 .po-artifact-source')).toContainText(agentRunId);
  await expect(page.locator('#test-artifact-root2 .po-artifact-btn')).toBeVisible();

  // 历史下载标明原来源:状态变化后重新渲染同一 run,来源仍为原 runId
  await page.evaluate(() => PO.setContext({ unitId: 202, cycle: 99 }));
  const agentRunAfter = await page.evaluate((rid) => PO.getState().runs.find(r => r.runId === rid), agentRunId);
  await page.evaluate((run) => {
    PO.artifactList.render(document.getElementById('test-artifact-root2'), run);
  }, agentRunAfter);

  await expect(page.locator('#test-artifact-root2 .po-artifact-source')).toContainText(agentRunId);
  // 下载内容仍来自该 run 的快照(不替换为当前结果)
  const r2 = await page.evaluate((rid) => PO.export.downloadRun(rid, 'json'), agentRunId);
  expect(r2.ok).toBe(true);
});