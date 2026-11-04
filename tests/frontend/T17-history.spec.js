/* ═══════════════════════════════════════════════
   T17:接通预览页与当前会话记录(S17)
   覆盖施工单验收:
   - 预览页走通分析→回测→产物下载,模块接口与实际 DOM 连通(自动 mount)
   - 25 次运行后仅留 20 条摘要与 5 条完整结果,当前已应用仍能查看
   - 抽屉交互:打开/关闭/Esc/焦点归还;摘要含类型/时间/状态/设备/时点/参数版本;已释放标"明细已释放"
   - 看旧记录不影响当前状态;刷新空态准确
   ═══════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');
const FX = require('./fixtures/api-fixture');

const NEXT_PAGE = '/static/index.html';

// ───────── 辅助:注入数据状态(上传链路由 T10 覆盖) ─────────
async function injectData(page, opts = {}) {
  await page.evaluate(() => {
    PO.setData({
      overview: { total_rows: 100, unit_count: 2, columns: 26, separator: ' ',
        units: [{ unit_id: 1, cycles: 50 }, { unit_id: 2, cycles: 50 }] },
      qualityReport: { file_name: 't17.csv', file_size_mb: 0.05, file_empty: false,
        total_rows: 100, total_columns: 26, unit_count: 2, is_valid: true, has_critical: false,
        column_mapping: { unit_column: 'unit', cycle_column: 'cycle', setting_columns: [],
          selected_sensors: [], missing_sensors: [], constant_sensors: [], all_columns: [] },
        checks: [], units: [
          { unit_id: 1, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
          { unit_id: 2, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
        ], assumptions: [] },
      unitIds: [1, 2],
    });
    PO.setContext({ sessionId: 'sess-t17', unitId: 1, cycle: 40 });
  });
}

// 辅助:产生 n 条 success 运行(evaluate 内循环 startRun+finishRun)
async function produceRuns(page, n, kind = 'predict') {
  await page.evaluate(({ n, kind }) => {
    const s = PO.getState();
    for (let i = 0; i < n; i++) {
      const runId = PO.startRun(kind, {
        sessionId: s.context.sessionId, unitId: s.context.unitId, cycle: s.context.cycle,
        contextRev: s.context.contextRev, scenarioRev: s.context.scenarioRev,
      });
      PO.finishRun(runId, { marker: 'run-' + i });
    }
  }, { n, kind });
}

// ───────── T17-1 端到端:自动 mount + 分析→回测→产物下载 DOM 连通 ─────────

test('T17-1 预览页走通分析→回测→产物下载,自动 mount 三页视图 DOM 连通', async ({ page }) => {
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));
  await page.route('**/api/rul/predict', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeRULResponse('sess-t17', 1, 40)),
  }));
  await page.route('**/api/decision/run', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeDecisionResponse()),
  }));
  await page.route('**/api/backtest/run', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeBacktestResponse()),
  }));

  // 默认 chat 路由 → 自动 mount chatView(对话主体)
  await page.goto(NEXT_PAGE + '#/chat');
  await injectData(page);

  // chatView DOM 连通:对话输入框 + 发送按钮
  await expect(page.locator('#chat-input')).toBeVisible();
  await expect(page.locator('#chat-send')).toBeVisible();

  // 快捷任务"分析当前设备" → 等 decision 完成(参数取后端默认)
  await page.click('.po-chat-quick-btn[data-action="start-analysis"]');
  await page.waitForFunction(() => PO.getState().appliedScenario != null, null, { timeout: 10000 });

  // 维修建议卡片入流,含当前策略与推荐窗口
  const adviceCard = page.locator('.po-chat-card[data-card-type="advice"]');
  await expect(adviceCard).toBeVisible();
  await expect(adviceCard).toContainText('当前策略');

  // validation 路由 → 自动 mount backtestView
  await page.evaluate(() => PO.router.navigate('validation'));
  await expect(page.locator('#bt-run-btn')).toBeVisible();
  await expect(page.locator('#bt-artifact-body')).toBeAttached();

  // 运行回测 → 等结果 → 产物下载卡出现
  await page.click('#bt-run-btn');
  await page.waitForFunction(() => PO.getState().backtest != null, null, { timeout: 10000 });
  await expect(page.locator('#bt-artifact-body .po-artifact-card')).toBeVisible();

  // data 路由 → 自动 mount dataView
  await page.evaluate(() => PO.router.navigate('data'));
  await expect(page.locator('#dv-drop-zone')).toBeVisible();
});

// ───────── T17-2 25 次运行后仅留 20 摘要 + 5 完整,当前已应用仍能查看 ─────────

test('T17-2 产生 25 次运行后仅留 20 条摘要与 5 条完整结果,当前已应用结果不受影响', async ({ page }) => {
  await page.goto(NEXT_PAGE);
  await injectData(page);

  // 注入已应用方案(顶层单独持有)
  const dec = FX.makeDecisionResponse();
  await page.evaluate((d) => PO.applyScenario(d), dec);

  // 产生 25 次 success predict 运行
  await produceRuns(page, 25, 'predict');

  const stats = await page.evaluate(() => {
    const s = PO.getState();
    const withResult = s.runs.filter(r => r.status === 'success' && r.result != null);
    const released = s.runs.filter(r => r.released === true);
    return {
      total: s.runs.length,
      withResult: withResult.length,
      released: released.length,
      hasApplied: s.appliedScenario != null,
      appliedStrategies: s.appliedScenario ? Object.keys(s.appliedScenario.strategies || {}).length : 0,
    };
  });
  expect(stats.total).toBe(20);        // 仅留 20 条摘要
  expect(stats.withResult).toBe(5);    // 最多 5 条完整结果
  expect(stats.released).toBe(15);     // 其余 15 条已释放
  expect(stats.hasApplied).toBe(true); // 当前已应用结果不受历史淘汰失效
  expect(stats.appliedStrategies).toBeGreaterThan(0);
});

// ───────── T17-3 抽屉交互:打开/关闭/Esc/焦点归还 + 摘要内容 + 已释放标记 ─────────

test('T17-3 抽屉打开/关闭/Esc/焦点归还;摘要含类型/状态/设备/时点/参数版本;已释放标"明细已释放"', async ({ page }) => {
  await page.goto(NEXT_PAGE);
  await injectData(page);

  // 产生 7 次 success 运行(确保有 released)
  await produceRuns(page, 7, 'predict');

  // 点击侧栏"运行记录" → 抽屉打开
  await page.click('#sidebar-runs-btn');
  await expect(page.locator('#po-rh-overlay')).toBeVisible();

  // 标题固定
  await expect(page.locator('.po-rh-title')).toContainText('当前会话运行记录');

  // 摘要行数 = 7;最新行含类型/状态/设备/时点/参数版本
  await expect(page.locator('.po-rh-row')).toHaveCount(7);
  const firstRow = page.locator('.po-rh-row').first();
  await expect(firstRow).toContainText('RUL 预测');
  await expect(firstRow).toContainText('成功');
  await expect(firstRow).toContainText('设备 1');
  await expect(firstRow).toContainText('时点 40');
  await expect(firstRow).toContainText('参数版本');

  // 有"明细已释放"标记(7 条中 5 条有 result,2 条 released)
  await expect(page.locator('.po-rh-released')).toHaveCount(2);
  await expect(page.locator('.po-rh-row.po-rh-released .po-badge-warning').last()).toContainText('明细已释放');

  // Esc 关闭 → 抽屉隐藏 + 焦点归还到 #sidebar-runs-btn
  await page.keyboard.press('Escape');
  await expect(page.locator('#po-rh-overlay')).toBeHidden();
  const focusedId = await page.evaluate(() => document.activeElement ? document.activeElement.id : '');
  expect(focusedId).toBe('sidebar-runs-btn');

  // 重新打开 → 关闭按钮关闭
  await page.click('#sidebar-runs-btn');
  await expect(page.locator('#po-rh-overlay')).toBeVisible();
  await page.click('#po-rh-close');
  await expect(page.locator('#po-rh-overlay')).toBeHidden();
});

// ───────── T17-4 看旧记录不影响当前状态;换数据清空;刷新空态 ─────────

test('T17-4 看旧记录不影响当前设备与参数;换数据清空记录;刷新从空态开始', async ({ page }) => {
  await page.goto(NEXT_PAGE);
  await injectData(page);

  // 注入已应用方案
  const dec = FX.makeDecisionResponse();
  await page.evaluate((d) => PO.applyScenario(d), dec);
  await produceRuns(page, 3, 'predict');

  // 记录当前状态
  const before = await page.evaluate(() => ({
    unitId: PO.getState().context.unitId,
    cycle: PO.getState().context.cycle,
    scenarioRev: PO.getState().context.scenarioRev,
    appliedCm: PO.getState().appliedScenario ? PO.getState().appliedScenario.params.cm : null,
  }));

  // 打开抽屉看旧记录 → 关闭
  await page.click('#sidebar-runs-btn');
  await expect(page.locator('#po-rh-overlay')).toBeVisible();
  await expect(page.locator('.po-rh-row')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('#po-rh-overlay')).toBeHidden();

  // 当前设备与参数未变(历史只读,不回写)
  const after = await page.evaluate(() => ({
    unitId: PO.getState().context.unitId,
    cycle: PO.getState().context.cycle,
    scenarioRev: PO.getState().context.scenarioRev,
    appliedCm: PO.getState().appliedScenario ? PO.getState().appliedScenario.params.cm : null,
  }));
  expect(after).toEqual(before);

  // 换数据清空记录
  await page.evaluate(() => PO.resetDataset());
  const cleared = await page.evaluate(() => ({
    runs: PO.getState().runs.length,
    applied: PO.getState().appliedScenario,
  }));
  expect(cleared.runs).toBe(0);
  expect(cleared.applied).toBeNull();

  // 刷新从空态开始(不声称跨刷新恢复)
  await page.reload();
  const fresh = await page.evaluate(() => PO.getState().runs.length);
  expect(fresh).toBe(0);
  // 打开抽屉确认空态提示
  await page.click('#sidebar-runs-btn');
  await expect(page.locator('#po-rh-overlay')).toBeVisible();
  await expect(page.locator('.po-empty')).toContainText('暂无运行记录');
});