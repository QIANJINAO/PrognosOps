// S11 验收:主操作、参数区与决策摘要(对话主体版)
// 覆盖:分析→读结论(advice 卡片+策略对比抽屉);IEO 与 ETO 同窗口保留真实标签;
//       草稿修改不改变摘要、错误持续可见;依据抽屉零值数与【样本过滤】条

const { test, expect } = require('@playwright/test');
const FX = require('./fixtures/api-fixture');

const NEXT_PAGE = '/static/index.html';

// ───────── 辅助:注入数据状态(对话页自动挂载,上传链路由 T10 覆盖) ─────────
async function setupWorkspace(page, opts = {}) {
  const counters = { predict: 0, decision: 0 };

  await page.route('**/api/health', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', version: 'test' }) });
  });
  await page.route('**/api/rul/predict', async route => {
    counters.predict++;
    const resp = FX.makeRULResponse('sess-t11', 1, 40, opts.rulOverrides || {});
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resp) });
  });
  await page.route('**/api/decision/run', async route => {
    counters.decision++;
    const resp = opts.decisionResp || FX.makeDecisionResponse(null, opts.decisionOverrides || {});
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resp) });
  });

  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await page.evaluate(() => {
    PO.setData({
      overview: { total_rows: 100, unit_count: 2, columns: 26, separator: ' ',
        units: [{ unit_id: 1, cycles: 50 }, { unit_id: 2, cycles: 50 }] },
      qualityReport: { file_name: 't11.csv', file_size_mb: 0.05, file_empty: false,
        total_rows: 100, total_columns: 26, unit_count: 2, is_valid: true, has_critical: false,
        column_mapping: { unit_column: 'unit', cycle_column: 'cycle', setting_columns: [],
          selected_sensors: [], missing_sensors: [], constant_sensors: [], all_columns: [] },
        checks: [], units: [
          { unit_id: 1, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
          { unit_id: 2, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
        ], assumptions: [] },
      unitIds: [1, 2],
    });
    PO.setContext({ sessionId: 'sess-t11', unitId: 1, cycle: 40 });
  });
  return counters;
}

// 辅助:点击快捷任务"分析当前设备"并等待 advice 卡片
async function runAnalysis(page) {
  await page.click('.po-chat-quick-btn[data-action="start-analysis"]');
  await expect(page.locator('.po-chat-card[data-card-type="advice"]')).toBeVisible({ timeout: 10000 });
}

// 辅助:打开详情抽屉
async function openDetail(page, type) {
  await page.click('.po-chat-card[data-card-type="advice"] [data-action="open-detail"][data-detail-type="' + type + '"]');
  await expect(page.locator('#po-dd-overlay')).toBeVisible();
  await expect(page.locator('#po-dd-body')).toBeVisible();
}

test.describe('S11:主操作、参数区与决策摘要', () => {

  test('T11-1:分析→读结论,advice 卡片含当前策略与指标,策略对比抽屉四策略完整', async ({ page }) => {
    await setupWorkspace(page);

    // 对话页就绪:输入框可见 + 快捷任务"分析当前设备"
    await expect(page.locator('#chat-input')).toBeVisible();
    await expect(page.locator('.po-chat-quick-btn[data-action="start-analysis"]')).toContainText('分析当前设备');

    // 运行分析
    await runAnalysis(page);

    // advice 卡片:当前策略/窗口/成本/失效概率/设备时点
    const advice = page.locator('.po-chat-card[data-card-type="advice"]');
    await expect(advice).toContainText('当前策略');
    await expect(advice).toContainText('ETO-C');
    await expect(advice).toContainText('推荐窗口');
    await expect(advice).toContainText('失效概率');
    await expect(advice).toContainText('设备 #1 @ 周期 40');
    await expect(advice).toContainText('420'); // ETO-C expected_total_cost

    // 打开策略对比抽屉
    await openDetail(page, 'strategies');

    // 四策略均渲染,ETO-C 为比较基准(首个)
    const ddBody = page.locator('#po-dd-body');
    for (const name of ['ETO-C', 'IEO-C', 'ETO-Q', 'IEO-Q']) {
      await expect(ddBody).toContainText(name);
    }

    // 对比表 7 列
    const headers = await page.$$eval('#po-dd-body th', els => els.map(e => e.textContent.trim()));
    expect(headers).toEqual(['策略', '推荐窗口 z*', 'E[TC]', '失效概率', '目标值', '与 ETO 窗口差', 'E[C1]']);

    // ETO-C 行:窗口 30 / E[TC] 420 / 窗口差 0
    const etoCRow = page.locator('#po-dd-body tbody tr').first();
    await expect(etoCRow).toContainText('ETO-C 期望总成本');
    await expect(etoCRow).toContainText('30');

    // 关闭抽屉后会话保留
    await page.click('#po-dd-close');
    await expect(page.locator('#po-dd-overlay')).toBeHidden();
    await expect(advice).toBeVisible();
  });

  test('T11-2:IEO 与 ETO 同窗口时仍保留真实策略标签', async ({ page }) => {
    // 构造 IEO-C 窗口 = ETO-C 窗口 = 30;IEO-Q 窗口 27 ≠ ETO-Q 窗口 25
    const decisionResp = FX.makeDecisionResponse(null, {
      strategies: {
        'ETO-C': FX.makeStrategyResult('ETO-C', 30, 415.0),
        'IEO-C': FX.makeStrategyResult('IEO-C', 30, 410.5, { diff_window_vs_eto: 0, diff_objective_vs_eto: -4.5 }),
        'ETO-Q': FX.makeStrategyResult('ETO-Q', 25, 3.8),
        'IEO-Q': FX.makeStrategyResult('IEO-Q', 27, 3.6, { diff_window_vs_eto: 2, diff_objective_vs_eto: -0.2 }),
      },
    });
    await setupWorkspace(page, { decisionResp });
    await runAnalysis(page);
    await openDetail(page, 'strategies');

    // IEO-C 行:策略标签仍为 IEO-C(身份不变),窗口差为 0(同窗口)
    const ieoCRow = page.locator('#po-dd-body tbody tr', { hasText: 'IEO-C' });
    await expect(ieoCRow).toContainText('IEO-C 改进期望成本');
    const ieoCCells = await ieoCRow.locator('td').allTextContents();
    // 列序:策略/窗口/E[TC]/失效概率/目标值/与ETO窗口差/E[C1] → 窗口差为第 6 列(index 5)
    expect(ieoCCells[5].trim()).toBe('0');

    // IEO-Q 窗口不同 → 窗口差为 2
    const ieoQRow = page.locator('#po-dd-body tbody tr', { hasText: 'IEO-Q' });
    const ieoQCells = await ieoQRow.locator('td').allTextContents();
    expect(ieoQCells[5].trim()).toBe('2');
  });

  test('T11-3:草稿修改不改变摘要,错误在对话中持续可见', async ({ page }) => {
    const counters = await setupWorkspace(page);
    await runAnalysis(page);

    // 记录 advice 卡片内容(默认 ETO-C expected_total_cost=420)
    const advice = page.locator('.po-chat-card[data-card-type="advice"]');
    await expect(advice).toContainText('420');
    const summaryBefore = await advice.innerHTML();

    // 修改草稿 cd(5→8):advice 卡片不因草稿修改而变化(仍显示已应用结果)
    await page.evaluate(() => PO.setDraftParams({ cm: 10, cd: 8, cp: 100, cc: 500, alpha: 0.95, h_max: 150 }));
    const summaryAfter = await advice.innerHTML();
    expect(summaryAfter).toBe(summaryBefore);

    // 设置非法草稿 cm=0 → 点分析 → 客户端校验拦截,错误系统消息持续可见
    await page.evaluate(() => PO.setDraftParams({ cm: 0, cd: 5, cp: 50, cc: 200, alpha: 0.01, h_max: 150 }));
    const predictBefore = counters.predict;
    const decisionBefore = counters.decision;
    await page.click('.po-chat-quick-btn[data-action="start-analysis"]');

    const errMsg = page.locator('.po-chat-msg-system.po-chat-sys-error').last();
    await expect(errMsg).toContainText('参数校验失败');
    await expect(errMsg).toContainText('cm 必须大于 0');

    // 未发预测/决策请求(客户端校验在 API 调用前拦截)
    expect(counters.predict).toBe(predictBefore);
    expect(counters.decision).toBe(decisionBefore);

    // 等 1.5s 验证错误非 Toast 自动消失(系统消息持久)
    await page.waitForTimeout(1500);
    await expect(errMsg).toContainText('参数校验失败');

    // advice 卡片仍不变
    const summaryFinal = await advice.innerHTML();
    expect(summaryFinal).toBe(summaryBefore);
  });

  test('T11-4:依据抽屉显示零值数、【样本过滤】条与优化运行记录', async ({ page }) => {
    // 构造含 n_zero=3 与【样本过滤】假设的预测响应
    await setupWorkspace(page, {
      rulOverrides: {
        weibull: FX.makeWeibullFit({ n_samples: 45, n_zero: 3 }),
        assumptions: [
          'Weibull MLE 拟合假设失效时间服从两参数威布尔分布',
          '【样本过滤】kNN 候选样本中有 3 个 RUL=0 未参与拟合',
        ],
      },
    });
    await runAnalysis(page);

    // 打开依据抽屉(分析图表与依据)
    await openDetail(page, 'evidence');
    const ddBody = page.locator('#po-dd-body');

    // n_samples 标"参与拟合正样本数"并显示零值数
    await expect(ddBody).toContainText('参与拟合正样本数');
    await expect(ddBody).toContainText('其中 RUL=0 未参与拟合 3 个');

    // assumptions 纯文本渲染,含【样本过滤】条
    await expect(ddBody).toContainText('【样本过滤】');
    await expect(ddBody).toContainText('kNN 候选样本中有 3 个 RUL=0 未参与拟合');

    // "优化运行记录"(非"模型可信度")+ 收敛标记
    await expect(ddBody).toContainText('优化运行记录');
    await expect(ddBody).not.toContainText('模型可信度');
    await expect(ddBody).toContainText('已收敛');

    // Weibull 参数卡片完整
    await expect(ddBody).toContainText('尺度参数 λ');
    await expect(ddBody).toContainText('形状参数 k');
    await expect(ddBody).toContainText('参考集规模');

    // 决策参数(已应用)显示
    await expect(ddBody).toContainText('决策参数(已应用)');
    await expect(ddBody).toContainText('c_m 计划更换');
    await expect(ddBody).toContainText('h_max');
  });
});