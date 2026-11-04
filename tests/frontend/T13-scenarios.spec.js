// S13 验收:闭合候选到应用的链路(对话主体版)
// 覆盖:候选显示(变化字段/指标/应用按钮)、应用并重新计算、
//       过期候选不可应用+新参数生效+旧历史不携带、失败保留原方案+可重试

const { test, expect } = require('@playwright/test');
const FX = require('./fixtures/api-fixture');
const NEXT_PAGE = '/static/index.html';

// 构造 cd 翻倍候选(5→10),摘要窗口/成本与默认 fixture 不同(28/380 vs 30/420)
function makeCdDoubleCandidate() {
  const candParams = FX.makeDecisionParams({ cd: 10 });
  return {
    type: 'recompute',
    decision: {
      params: candParams,
      strategies: {
        'ETO-C': { optimal_window: 28, objective_value: 370, expected_cost: 75, expected_total_cost: 380, failure_prob: 0.10, expected_life: 56, diff_window_vs_eto: 0, diff_objective_vs_eto: 0 },
        'IEO-C': { optimal_window: 29, objective_value: 365, expected_cost: 75, expected_total_cost: 378, failure_prob: 0.10, expected_life: 56, diff_window_vs_eto: 1, diff_objective_vs_eto: -2 },
        'ETO-Q': { optimal_window: 24, objective_value: 3.5, expected_cost: 75, expected_total_cost: 380, failure_prob: 0.10, expected_life: 56, diff_window_vs_eto: 0, diff_objective_vs_eto: 0 },
        'IEO-Q': { optimal_window: 26, objective_value: 3.3, expected_cost: 75, expected_total_cost: 378, failure_prob: 0.10, expected_life: 56, diff_window_vs_eto: 1, diff_objective_vs_eto: -0.2 },
      },
      assumptions: ['折现续跑项假设更换后过程重启'],
    },
    changedParams: { cd: 10 },
    sourceRunId: 'run-agent-test',
    contextRev: 0, // 动态设置
    scenarioRev: 0, // 动态设置
  };
}

// 辅助:注入基准方案 + 候选(对话主体:候选以情景比较卡片入流)
async function setupScenario(page, options = {}) {
  const baseDecision = FX.makeDecisionResponse(); // 默认 cd=5
  const candidates = options.candidates || [options.candidate || makeCdDoubleCandidate()];

  await page.route('**/api/health', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', version: 'vtest' }) });
  });
  await page.route('**/api/decision/run', options.decisionHandler || (async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(FX.makeDecisionResponse(FX.makeDecisionParams({ cd: 10 }))) });
  }));

  await page.goto(NEXT_PAGE + '#/chat');
  await page.evaluate(({ baseDec, pred }) => {
    PO.setContext({ sessionId: 'sess-t13', unitId: 1 });
    const s = PO.getState();
    // 注入已提交预测(retryDecision 依赖 s.prediction + committedPrediction run,contextRev 匹配)
    const runId = PO.startRun('predict', { contextRev: s.context.contextRev });
    PO.commitPrediction(runId, pred);
    PO.applyScenario(baseDec);
  }, { baseDec: baseDecision, pred: FX.makeRULResponse('sess-t13', 1, 40) });
  await page.evaluate((cands) => {
    const s = PO.getState();
    cands.forEach(c => {
      c.contextRev = s.context.contextRev;
      c.scenarioRev = s.context.scenarioRev;
    });
    PO.addCandidates(cands);
    // 对话主体:候选以情景比较卡片入流(与 Agent 回包路径一致)
    PO.addMessage({
      type: 'card', cardType: 'compare',
      data: PO.cards.buildCompareData(PO.getState(), cands),
    });
  }, candidates);
  // 等待比较卡片渲染
  await expect(page.locator('.po-chat-card[data-card-type="compare"]')).toBeVisible();
}

test.describe('S13:闭合候选到应用的链路', () => {

  test('T13-1:候选显示变化字段与指标,未应用前当前方案不变', async ({ page }) => {
    await setupScenario(page);

    const compareCard = page.locator('.po-chat-card[data-card-type="compare"]');

    // 变化字段:c_d: 5 → 10
    await expect(compareCard.locator('.po-chat-compare-changes')).toContainText('c_d');
    await expect(compareCard.locator('.po-chat-compare-changes')).toContainText('5');
    await expect(compareCard.locator('.po-chat-compare-changes')).toContainText('10');

    // 候选指标:窗口 28(摘要值)
    await expect(compareCard).toContainText('28');

    // 按钮"应用并重新计算"
    await expect(compareCard.locator('[data-action="apply-candidate"]')).toContainText('应用并重新计算');

    // 未应用前当前方案不变(cd 仍为 5)
    const cd = await page.evaluate(() => PO.getState().appliedScenario.params.cd);
    expect(cd).toBe(5);
  });

  test('T13-2:应用并重新计算成功后新参数生效,出现新维修建议卡片', async ({ page }) => {
    let decisionPayload = null;
    await setupScenario(page, {
      decisionHandler: async route => {
        decisionPayload = route.request().postDataJSON();
        // 返回 cd=10 的完整决策(ETO-C 窗口 30 ≠ 候选摘要 28 → 已重新计算)
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(FX.makeDecisionResponse(FX.makeDecisionParams({ cd: 10 }))) });
      },
    });

    const scenarioRevBefore = await page.evaluate(() => PO.getState().context.scenarioRev);

    // 点击"应用并重新计算"
    await page.click('.po-chat-card[data-card-type="compare"] [data-action="apply-candidate"]');

    // 等待应用完成:系统消息"方案已应用,决策已重新计算"
    await expect(page.locator('.po-chat-msg-system').last()).toContainText('方案已应用', { timeout: 10000 });

    // 新维修建议卡片出现(重新计算后的方案)
    await expect(page.locator('.po-chat-card[data-card-type="advice"]').last()).toBeVisible();

    // decision 请求参数:cd=10
    expect(decisionPayload.params.cd).toBe(10);

    // 当前方案已更新:cd=10,scenarioRev 递增
    const s = await page.evaluate(() => PO.getState());
    expect(s.appliedScenario.params.cd).toBe(10);
    expect(s.context.scenarioRev).toBe(scenarioRevBefore + 1);
  });

  test('T13-3:应用成功后其他候选过期不可应用,下次 Agent 请求用新参数且不携带旧历史', async ({ page }) => {
    let agentPayload = null;
    // 两个候选:cand1(cd 翻倍)、cand2(cp 翻倍);应用 cand1 后 cand2 过期
    const cand1 = makeCdDoubleCandidate();
    const cand2 = makeCdDoubleCandidate();
    cand2.decision.params = FX.makeDecisionParams({ cd: 5, cp: 200 });
    cand2.changedParams = { cp: 200 };
    await setupScenario(page, { candidates: [cand1, cand2] });

    const compareCard = page.locator('.po-chat-card[data-card-type="compare"]');

    // 注入旧对话历史(绑定旧 scenarioRev)
    await page.evaluate(() => {
      PO.appendChat('user', '旧问题');
      PO.appendChat('assistant', '旧回答');
    });

    // 应用第一个候选(cd 翻倍)
    await compareCard.locator('[data-action="apply-candidate"]').first().click();
    await expect(page.locator('.po-chat-msg-system').last()).toContainText('方案已应用', { timeout: 10000 });

    // 第二个候选标过期(scenarioRev 已递增):stale 样式 + 不可应用文案,无应用按钮
    const item2 = compareCard.locator('.po-chat-compare-item').nth(1);
    await expect(item2).toHaveClass(/po-chat-compare-stale/);
    await expect(item2).toContainText('上下文已变化');
    await expect(item2.locator('[data-action="apply-candidate"]')).toHaveCount(0);

    // 下次 Agent 请求:current_params.cd=10(新参数),history 为空(scenarioRev 已变,旧历史不携带)
    await page.route('**/api/agent/chat', async route => {
      agentPayload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(FX.makeAgentResponse('新问题')) });
    });
    await page.evaluate(() => PO.agent.submit('新问题'));
    await page.waitForFunction(() => !PO.requests.isBusy('agent'));

    expect(agentPayload.current_params.cd).toBe(10);
    expect(agentPayload.history).toEqual([]);
  });

  test('T13-4:应用失败显示错误消息,原已应用方案保持不变,候选仍可重试', async ({ page }) => {
    await setupScenario(page, {
      decisionHandler: async route => {
        await route.fulfill({ status: 500, contentType: 'application/json',
          body: JSON.stringify({ detail: { code: 'E5001', message: '决策服务不可用' } }) });
      },
    });

    const scenarioRevBefore = await page.evaluate(() => PO.getState().context.scenarioRev);

    // 点击应用 → 失败:系统消息显示应用失败与原因
    await page.click('.po-chat-card[data-card-type="compare"] [data-action="apply-candidate"]');
    await expect(page.locator('.po-chat-msg-system').last()).toContainText('应用失败', { timeout: 10000 });
    await expect(page.locator('.po-chat-msg-system').last()).toContainText('决策服务不可用');

    // 原已应用方案保持不变(cd=5,scenarioRev 不变)
    const s = await page.evaluate(() => PO.getState());
    expect(s.appliedScenario.params.cd).toBe(5);
    expect(s.context.scenarioRev).toBe(scenarioRevBefore);

    // 候选仍可重试(未过期,应用按钮存在)
    const compareCard = page.locator('.po-chat-card[data-card-type="compare"]');
    await expect(compareCard.locator('[data-action="apply-candidate"]')).toBeVisible();
  });

});