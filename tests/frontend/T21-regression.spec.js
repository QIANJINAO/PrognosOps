/* ═══════════════════════════════════════════════
   T21:回测显示修复 + 导入自动选中 + 图表清晰度回归
   覆盖:
   - 回测成功后空态隐藏(hidden 属性生效,不受 display:flex 覆盖)
   - 导入后自动选中首台设备(context.unitId = 首台)
   - 回测失败时保留旧结果并标明来源
   - 图表主题提亮/字号≥12px/深合并不丢失公共配置
   ═══════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');
const apiFx = require('./fixtures/api-fixture.js');

const NEXT_URL = 'http://127.0.0.1:8765/static/index.html';

/** 公共 setup:路由 health/backtest + 设上下文 + 应用方案 + 挂载回测视图 */
async function setupBacktestPage(page, { decisionParams, backtestHandler } = {}) {
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));

  let captured = null;
  await page.route('**/api/backtest/run', async r => {
    captured = JSON.parse(r.request().postData());
    const result = backtestHandler
      ? backtestHandler(captured)
      : apiFx.makeBacktestResponse(captured.config);
    // 支持模拟失败:{ __fail: 500, __errorMessage: '...' }
    if (result && result.__fail) {
      await r.fulfill({
        status: result.__fail, contentType: 'application/json',
        body: JSON.stringify({ detail: result.__errorMessage || '模拟错误' }),
      });
      return;
    }
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(result),
    });
  });

  await page.goto(NEXT_URL);
  await page.evaluate(() => PO.setContext({ sessionId: 'fx-session', unitId: 101, cycle: 40 }));

  if (decisionParams) {
    const dec = apiFx.makeDecisionResponse(decisionParams);
    await page.evaluate((d) => {
      PO.applyScenario(Object.assign({}, d, {
        _runId: 'run-dec-fx',
        _contextRev: PO.getState().context.contextRev,
      }));
    }, dec);
  }

  await page.evaluate(() => PO.router.navigate('validation'));
  await page.evaluate(() => PO.backtestView.mount(document.getElementById('page-validation')));
  return { getCaptured: () => captured };
}

// ───────── T21-1 回测成功后空态隐藏(CSS hidden 修复回归) ─────────

test('T21-1 回测成功后"尚未运行回测"空态隐藏,结果可见', async ({ page }) => {
  await setupBacktestPage(page, {
    decisionParams: apiFx.makeDecisionParams({ cd: 10 }),
  });

  // 运行前:空态可见,结果区隐藏
  await expect(page.locator('#bt-result-empty')).toBeVisible();
  await expect(page.locator('#bt-result-content')).toBeHidden();

  // 运行回测
  await page.click('#bt-run-btn');
  await expect(page.locator('#bt-status')).toContainText('回测完成');

  // 运行后:空态必须隐藏(hidden 属性生效,不受 .po-empty{display:flex} 覆盖)
  await expect(page.locator('#bt-result-empty')).toBeHidden();
  await expect(page.locator('#bt-result-content')).toBeVisible();

  // 计算样式断言:hidden 元素的 display 必须为 none(回归 .po-empty[hidden] 规则)
  const display = await page.evaluate(() => {
    const el = document.getElementById('bt-result-empty');
    return el && el.hasAttribute('hidden') ? getComputedStyle(el).display : 'MISSING';
  });
  expect(display).toBe('none');

  // 切页返回后状态保留(切页不 unmount,订阅常驻)
  await page.evaluate(() => PO.router.navigate('chat'));
  await page.evaluate(() => PO.router.navigate('validation'));
  await expect(page.locator('#bt-result-empty')).toBeHidden();
  await expect(page.locator('#bt-result-content')).toBeVisible();
});

// ───────── T21-2 导入后自动选中首台设备 ─────────

test('T21-2 上传成功后自动选中首台设备,侧栏显示设备编号', async ({ page }) => {
  const units = [
    { unit_id: 1, cycle_count: 60, cycle_min: 1, cycle_max: 60, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
    { unit_id: 2, cycle_count: 55, cycle_min: 1, cycle_max: 55, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
  ];
  const totalRows = units.reduce((a, u) => a + u.cycle_count, 0);
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));
  await page.route('**/api/data/upload', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      session_id: 'sess-t21',
      overview: {
        total_rows: totalRows, unit_count: units.length, columns: 26, separator: ' ',
        units: units.map(u => ({ unit_id: u.unit_id, cycles: u.cycle_count })),
      },
      quality_report: {
        file_name: 'demo.csv', file_size_mb: 0.05, file_empty: false,
        total_rows: totalRows, total_columns: 26, unit_count: units.length,
        is_valid: true, has_critical: false,
        column_mapping: { unit_column: 'unit', cycle_column: 'cycle', setting_columns: [], selected_sensors: ['s2'], missing_sensors: [], constant_sensors: [], all_columns: [] },
        checks: [{ name: '文件非空检查', passed: true, level: 'info', message: 'ok', details: {} }],
        units: units, assumptions: [],
      },
    }),
  }));

  await page.goto(NEXT_URL + '#/data');
  await page.evaluate(() => PO.dataView.mount(document.getElementById('page-data')));
  await page.setInputFiles('#dv-file-input', { name: 'demo.csv', mimeType: 'text/csv', buffer: Buffer.from('test') });
  await expect(page.locator('#dv-status')).toContainText('上传成功');

  // 导入后自动选中首台设备(unitId=1,不再留空)
  const ctx = await page.evaluate(() => PO.getState().context);
  expect(ctx.unitId).toBe(1);
  expect(ctx.sessionId).toBe('sess-t21');

  // 侧栏上下文显示设备编号(不再显示"—")
  await expect(page.locator('#ctx-unit')).toHaveText('1');
});

// ───────── T21-3 回测失败后保留旧结果并标明来源 ─────────

test('T21-3 回测失败后保留旧结果并标明来源', async ({ page }) => {
  let failNext = false;
  await setupBacktestPage(page, {
    decisionParams: apiFx.makeDecisionParams({ cd: 10 }),
    backtestHandler: (captured) => {
      if (failNext) return { __fail: 500, __errorMessage: '模拟服务内部错误' };
      return apiFx.makeBacktestResponse(captured.config);
    },
  });

  // 第一次运行成功 → 结果可见
  await page.click('#bt-run-btn');
  await expect(page.locator('#bt-status')).toContainText('回测完成');
  await expect(page.locator('#bt-result-content')).toBeVisible();

  // 第二次运行失败(500 → API 层抛错 → catch 分支)
  failNext = true;
  await page.click('#bt-run-btn');
  await expect(page.locator('#bt-status')).toContainText('回测失败');

  // 旧结果保留可见,且状态条标明来源(不冒充本次结果)
  await expect(page.locator('#bt-result-content')).toBeVisible();
  await expect(page.locator('#bt-result-empty')).toBeHidden();
  await expect(page.locator('#bt-status')).toContainText('上次成功回测');
});

// ───────── T21-4 图表清晰度配置(提亮/字号/深合并) ─────────

test('T21-4 图表主题提亮、字号≥12px、深合并不丢失公共配置', async ({ page }) => {
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));
  await page.goto(NEXT_URL);

  const checks = await page.evaluate(() => {
    const r = {};
    // 1) THEME 提亮:muted 不再是过暗的 #6B7F99,secondary 提亮至 #C7D6EA
    r.mutedBright = Charts.THEME.muted !== '#6B7F99';
    r.secondaryIsBright = Charts.THEME.secondary === '#C7D6EA';
    // 2) 旧深色传感器色已全部替换(#4f46e5/#7c3aed/#9333ea/#65a30d/#ca8a04)
    const oldDark = ['#4f46e5', '#7c3aed', '#9333ea', '#65a30d', '#ca8a04'];
    r.noOldDarkColors = Charts.SENSOR_COLORS.every(c => oldDark.indexOf(c.toLowerCase()) === -1);
    r.colorMapNoOldDark = Object.values(Charts.SENSOR_COLOR_MAP).every(c => oldDark.indexOf(c.toLowerCase()) === -1);
    // resizeAll 已导出(切页 canvas 尺寸修复)
    r.hasResizeAll = typeof Charts.resizeAll === 'function';

    // 3) RUL 概率图:传入自定义 plugins(legend.display=false)与 scales
    let c = document.createElement('canvas');
    c.id = 't21-rul';
    document.body.appendChild(c);
    Charts.rulProbability('t21-rul', [0.1, 0.2, 0.3, 0.4], 3);
    const rulChart = Chart.getChart(document.getElementById('t21-rul'));
    r.rulTickFont = rulChart.options.scales.x.ticks.font.size;
    // 深合并:子图传 legend.display=false,公共 tooltip 配置必须保留(浅展开会丢失)
    r.rulTooltipBg = rulChart.options.plugins.tooltip.backgroundColor;
    r.rulTooltipTitleColor = rulChart.options.plugins.tooltip.titleColor;
    r.rulLegendLabelsFont = rulChart.options.plugins.legend.labels.font.size;
    Charts.destroy('t21-rul');
    c.remove();

    // 4) 双 Y 轴图(failLifeCurve):x 轴继承基础刻度字号,不出现空闲 y 轴
    c = document.createElement('canvas');
    c.id = 't21-fail';
    document.body.appendChild(c);
    Charts.failLifeCurve('t21-fail', [0, 10, 20, 30], [0.1, 0.3, 0.6, 0.9], [60, 57, 54, 51]);
    const failChart = Chart.getChart(document.getElementById('t21-fail'));
    r.failXTickFont = failChart.options.scales.x.ticks.font.size;
    r.failTooltipBg = failChart.options.plugins.tooltip.backgroundColor;
    r.hasIdleYAxis = 'y' in failChart.options.scales; // 双 Y 轴图不应有基础 y
    r.hasYFail = 'yFail' in failChart.options.scales;
    r.hasYLife = 'yLife' in failChart.options.scales;
    Charts.destroy('t21-fail');
    c.remove();

    return r;
  });

  // 主题提亮
  expect(checks.mutedBright).toBe(true);
  expect(checks.secondaryIsBright).toBe(true);
  // 旧深色已替换
  expect(checks.noOldDarkColors).toBe(true);
  expect(checks.colorMapNoOldDark).toBe(true);
  expect(checks.hasResizeAll).toBe(true);
  // 字号 ≥12px
  expect(checks.rulTickFont).toBeGreaterThanOrEqual(12);
  expect(checks.rulLegendLabelsFont).toBeGreaterThanOrEqual(12);
  expect(checks.failXTickFont).toBeGreaterThanOrEqual(12);
  // 深合并:公共 tooltip 配置保留(浅展开会丢失)
  expect(checks.rulTooltipBg).toBeTruthy();
  expect(checks.rulTooltipTitleColor).toBe('#F3F7FC');
  expect(checks.failTooltipBg).toBeTruthy();
  // 双 Y 轴:有 yFail/yLife,无空闲基础 y
  expect(checks.hasIdleYAxis).toBe(false);
  expect(checks.hasYFail).toBe(true);
  expect(checks.hasYLife).toBe(true);
});