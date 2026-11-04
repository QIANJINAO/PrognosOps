/* ═══════════════════════════════════════════════
   T15:回测参数与敏感性基点绑定(S15)
   覆盖施工单验收:
   - 已应用 cd=10 → decision_params.cd=10,扫描值 5/7.5/10/15/20
   - alpha=0.8 → 不发大于 1 的扫描值
   - cd=0 → 不发重复扫描(不足两项阻止)
   - 界面设备/参数/模式/种子与请求一致,种子 0 保留
   附加:无方案阻止态+返回入口、结果渲染、旧回测来源标明
   ═══════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');
const apiFx = require('./fixtures/api-fixture.js');

const NEXT_URL = 'http://127.0.0.1:8765/static/index.html';

/**
 * 公共 setup:路由 health/backtest + 设上下文 + (可选)应用方案 + 挂载回测视图
 * @returns {{getCaptured:()=>Object|null}} 捕获的 backtest/run 请求体
 */
async function setupBacktestPage(page, { decisionParams, backtestHandler } = {}) {
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));

  let captured = null;
  await page.route('**/api/backtest/run', async r => {
    captured = JSON.parse(r.request().postData());
    const body = backtestHandler
      ? backtestHandler(captured)
      : apiFx.makeBacktestResponse(captured.config);
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(body),
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

  // 先导航到验证路由(page-validation 默认 hidden,操作前需可见)
  await page.evaluate(() => PO.router.navigate('validation'));
  await page.evaluate(() => PO.backtestView.mount(document.getElementById('page-validation')));
  return { getCaptured: () => captured };
}

// ───────── T15-1 绑定字段 + cd=10 扫描值 ─────────

test('T15-1 已应用 cd=10 时绑定 decision_params.cd=10,扫描值 5/7.5/10/15/20', async ({ page }) => {
  const helper = await setupBacktestPage(page, {
    decisionParams: apiFx.makeDecisionParams({ cd: 10 }),
  });

  // 绑定信息展示当前设备与已应用参数
  await expect(page.locator('#bt-binding')).toContainText('设备 #101');
  await expect(page.locator('#bt-binding')).toContainText('cd=10');
  await expect(page.locator('#bt-binding')).toContainText('h_max=150');

  // 选敏感性参数 cd → 预览扫描值(基点取已应用值 10)
  await page.selectOption('#bt-sens-param', 'cd');
  await expect(page.locator('#bt-sens-info')).toContainText('基点 cd=10');
  await expect(page.locator('#bt-sens-info')).toContainText('5, 7.5, 10, 15, 20');

  // 运行回测
  await page.click('#bt-run-btn');
  await expect(page.locator('#bt-status')).toContainText('回测完成');

  // 请求绑定字段断言
  const body = helper.getCaptured();
  expect(body.session_id).toBe('fx-session');
  expect(body.config.decision_params.cd).toBe(10);
  expect(body.config.decision_params.cm).toBe(10);
  expect(body.config.unit_ids).toEqual([101]);
  expect(body.config.h_max).toBe(150);
  expect(body.config.include_points).toBe(true);
  expect(body.config.sensitivity_param).toBe('cd');
  expect(body.config.sensitivity_values).toEqual([5, 7.5, 10, 15, 20]);
  // 模式与界面一致
  expect(body.config.data_mode).toBe('offline');
});

// ───────── T15-2 alpha 上界 + 种子 0 保留 ─────────

test('T15-2 alpha=0.8 不发大于 1 的扫描值;种子 0 保留', async ({ page }) => {
  const helper = await setupBacktestPage(page, {
    decisionParams: apiFx.makeDecisionParams({ alpha: 0.8 }),
  });

  // 种子输入框默认 0(合法值,不被当空丢弃)
  await expect(page.locator('#bt-seed')).toHaveValue('0');

  // 选 alpha → 预览扫描值不含 >1 的值(1.2/1.6 已剔除)
  await page.selectOption('#bt-sens-param', 'alpha');
  await expect(page.locator('#bt-sens-info')).toContainText('0.4, 0.6, 0.8');
  await expect(page.locator('#bt-sens-info')).toContainText('已剔除');

  await page.click('#bt-run-btn');
  await expect(page.locator('#bt-status')).toContainText('回测完成');

  const body = helper.getCaptured();
  expect(body.config.sensitivity_param).toBe('alpha');
  expect(body.config.sensitivity_values).toEqual([0.4, 0.6, 0.8]);
  expect(body.config.sensitivity_values.every(v => v <= 1)).toBe(true);
  // 种子 0 保留(修复旧页 if(seed) 把 0 当空丢弃的缺陷)
  expect(body.config.random_seed).toBe(0);
});

// ───────── T15-3 无方案阻止态 + cd=0 敏感性不足两项 ─────────

test('T15-3 无方案显示阻止态与返回入口;cd=0 敏感性不足两项不发请求', async ({ page }) => {
  // 场景A:无已应用方案 → 阻止态 + 返回分析入口
  const helper = await setupBacktestPage(page, {});
  await expect(page.locator('#bt-blocked')).toBeVisible();
  await expect(page.locator('#bt-form')).toBeHidden();
  await expect(page.locator('#bt-goto-workspace')).toBeVisible();

  // 返回分析按钮导航对话页
  await page.click('#bt-goto-workspace');
  await expect(page).toHaveURL(/#\/chat/);

  // 导航回验证页,继续场景B
  await page.evaluate(() => PO.router.navigate('validation'));

  // 场景B:应用 cd=0 方案 → 表单出现
  const dec = apiFx.makeDecisionResponse(apiFx.makeDecisionParams({ cd: 0 }));
  await page.evaluate((d) => {
    PO.applyScenario(Object.assign({}, d, {
      _runId: 'run-dec-fx2',
      _contextRev: PO.getState().context.contextRev,
    }));
  }, dec);
  await expect(page.locator('#bt-form')).toBeVisible();
  await expect(page.locator('#bt-binding')).toContainText('cd=0');

  // 选 cd 敏感性 → 基点 0 扫描全 0,去重后仅 1 项,不足两项
  await page.selectOption('#bt-sens-param', 'cd');
  await expect(page.locator('#bt-sens-info')).toContainText('不足两项');

  // 点运行 → 不发 backtest 请求,状态条显示阻止原因
  await page.click('#bt-run-btn');
  await expect(page.locator('#bt-status')).toContainText('不足两项');
  expect(helper.getCaptured()).toBeNull();
});

// ───────── T15-4 结果渲染 + 旧回测来源标明 ─────────

test('T15-4 回测结果渲染含 points;方案变化后标明旧回测来源', async ({ page }) => {
  const helper = await setupBacktestPage(page, {
    decisionParams: apiFx.makeDecisionParams({ cd: 10 }),
  });

  await page.click('#bt-run-btn');
  await expect(page.locator('#bt-status')).toContainText('回测完成');

  // 结果渲染:摘要卡片 + 策略表 + 校准图
  await expect(page.locator('#bt-result-content')).toBeVisible();
  await expect(page.locator('#bt-summary .po-stat-card')).toHaveCount(5);
  await expect(page.locator('#bt-strategy-table tbody tr')).toHaveCount(4);
  await expect(page.locator('#bt-diff-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#chart-bt-calibration')).toBeVisible();

  // 方案未变化 → 无旧来源标记
  await expect(page.locator('#bt-result-stale')).toBeHidden();

  // store.backtest 已写入,含完整 config 与 points(S16 免重算导出唯一来源)
  const bt = await page.evaluate(() => PO.getState().backtest);
  expect(bt).toBeTruthy();
  expect(bt.points.length).toBe(2);
  expect(bt.config.include_points).toBe(true);
  expect(bt.config.decision_params.cd).toBe(10);

  // 应用新方案(scenarioRev 递增)→ 旧回测来源标明,不冒充当前方案验证
  const dec2 = apiFx.makeDecisionResponse(apiFx.makeDecisionParams({ cd: 20 }));
  await page.evaluate((d) => {
    PO.applyScenario(Object.assign({}, d, {
      _runId: 'run-dec-fx3',
      _contextRev: PO.getState().context.contextRev,
    }));
  }, dec2);

  await expect(page.locator('#bt-result-stale')).toBeVisible();
  await expect(page.locator('#bt-result-stale')).toContainText('旧回测来源');
  await expect(page.locator('#bt-result-stale')).toContainText('方案已变化');
  // 标明来源运行 ID(backtest run 的 genRunId,格式 run-*)
  await expect(page.locator('#bt-result-stale')).toContainText(/来源运行 run-/);
});