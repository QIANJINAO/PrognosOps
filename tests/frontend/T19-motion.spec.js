/* ═══════════════════════════════════════════════
   T19:只保留状态动效(S19)(对话主体版)
   覆盖施工单验收:
   - 真实状态切换淡入 120–160ms、ease-out(.po-status-bar)
   - 候选应用成功高亮 600ms 后 160ms 淡出(760ms 总时长)
   - 请求 spinner 800ms、linear、infinite(.po-status-running::before)
   - Agent 运行中循环动效(.po-chat-dot-anim)
   - prefers-reduced-motion:reduce 关闭循环与位移
   - 动效不改变候选项尺寸、不抢滚动位置
   ═══════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');
const FX = require('./fixtures/api-fixture');

const NEXT_PAGE = '/static/index.html';

// ───────── 辅助:路由 mock ─────────
async function setupRoutes(page) {
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));
  await page.route('**/api/rul/predict', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeRULResponse('sess-t19', 1, 40)),
  }));
  await page.route('**/api/decision/run', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeDecisionResponse(FX.makeDecisionParams({ cd: 10 }))),
  }));
  await page.route('**/api/agent/chat', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeAgentResponse('t19 测试')),
  }));
}

// ───────── 辅助:注入数据状态 ─────────
async function injectData(page) {
  await page.evaluate(() => {
    PO.setData({
      overview: { total_rows: 100, unit_count: 2, columns: 26, separator: ' ',
        units: [{ unit_id: 1, cycles: 50 }, { unit_id: 2, cycles: 50 }] },
      qualityReport: { file_name: 't19.csv', file_size_mb: 0.05, file_empty: false,
        total_rows: 100, total_columns: 26, unit_count: 2, is_valid: true, has_critical: false,
        column_mapping: { unit_column: 'unit', cycle_column: 'cycle', setting_columns: [],
          selected_sensors: [], missing_sensors: [], constant_sensors: [], all_columns: [] },
        checks: [], units: [], assumptions: [] },
      unitIds: [1, 2],
    });
    PO.setContext({ sessionId: 'sess-t19', unitId: 1, cycle: 40 });
  });
}

// ───────── 辅助:基准方案 + cd 翻倍候选(情景比较卡片入流,复用 T13 模式) ─────────
async function setupScenario(page) {
  const baseDecision = FX.makeDecisionResponse();
  const candidate = {
    type: 'recompute',
    decision: {
      params: FX.makeDecisionParams({ cd: 10 }),
      strategies: {
        'ETO-C': { optimal_window: 28, objective_value: 370, expected_cost: 75,
          expected_total_cost: 380, failure_prob: 0.10, expected_life: 56,
          diff_window_vs_eto: 0, diff_objective_vs_eto: 0 },
      },
      assumptions: ['折现续跑项假设更换后过程重启'],
    },
    changedParams: { cd: 10 },
    sourceRunId: 'run-agent-t19',
    contextRev: 0, scenarioRev: 0,
  };
  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await page.evaluate(({ baseDec, pred }) => {
    PO.setContext({ sessionId: 'sess-t19', unitId: 1 });
    const s = PO.getState();
    const runId = PO.startRun('predict', { contextRev: s.context.contextRev });
    PO.commitPrediction(runId, pred);
    PO.applyScenario(baseDec);
  }, { baseDec: baseDecision, pred: FX.makeRULResponse('sess-t19', 1, 40) });
  await page.evaluate((cand) => {
    const s = PO.getState();
    cand.contextRev = s.context.contextRev;
    cand.scenarioRev = s.context.scenarioRev;
    PO.addCandidates([cand]);
    PO.addMessage({ type: 'card', cardType: 'compare', data: PO.cards.buildCompareData(PO.getState(), [cand]) });
  }, candidate);
  await expect(page.locator('.po-chat-card[data-card-type="compare"]')).toBeVisible();
}

// ═══════════════════════════════════════════════
// T19-1 状态切换淡入 120–160ms ease-out
// ═══════════════════════════════════════════════

test('T19-1 状态切换淡入:animationName=po-fade-in,时长 120–160ms,ease-out', async ({ page }) => {
  await setupRoutes(page);
  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();

  // data 页状态条(#dv-status)带 .po-status-bar class → 淡入动效
  await page.evaluate(() => PO.router.navigate('data'));
  await expect(page.locator('#dv-drop-zone')).toBeVisible();
  const anim = await page.evaluate(() => {
    const bar = document.getElementById('dv-status');
    bar.hidden = false;
    bar.className = 'po-status-bar'; // 确保带淡入 class
    const cs = getComputedStyle(bar);
    return { name: cs.animationName, duration: cs.animationDuration, timing: cs.animationTimingFunction };
  });
  expect(anim.name).toBe('po-fade-in');
  const durSec = parseFloat(anim.duration); // '0.14s' → 0.14
  expect(durSec).toBeGreaterThanOrEqual(0.12);
  expect(durSec).toBeLessThanOrEqual(0.16);
  expect(anim.timing).toContain('ease-out');
});

// ═══════════════════════════════════════════════
// T19-2 候选应用成功高亮 600ms 后 160ms 淡出
// ═══════════════════════════════════════════════

test('T19-2 应用成功高亮:候选项加 po-cand-just-applied,760ms 动画,结束后 class 移除', async ({ page }) => {
  await setupRoutes(page);
  await setupScenario(page);

  // 点击"应用并重新计算" → 等成功 → 已应用项有高亮 class + 760ms 动画
  await page.click('.po-chat-card[data-card-type="compare"] [data-action="apply-candidate"]');
  await page.waitForFunction(() =>
    document.querySelector('.po-chat-compare-item.po-cand-just-applied') != null, null, { timeout: 10000 });

  const anim = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.po-chat-compare-item.po-cand-just-applied'));
    return { name: cs.animationName, duration: cs.animationDuration };
  });
  expect(anim.name).toBe('po-apply-highlight');
  expect(parseFloat(anim.duration)).toBeCloseTo(0.76, 1); // 760ms

  // 动效不改变尺寸:高亮播放中连续两次采样,尺寸不变
  const sizeA = await page.evaluate(() => {
    const el = document.querySelector('.po-chat-compare-item.po-cand-just-applied');
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  await page.waitForTimeout(100); // 高亮播放中再采样
  const sizeB = await page.evaluate(() => {
    const el = document.querySelector('.po-chat-compare-item.po-cand-just-applied');
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  expect(sizeB.w).toBe(sizeA.w);
  expect(sizeB.h).toBe(sizeA.h);

  // 等 850ms(760ms 动画 + 余量)后 class 移除
  await page.waitForFunction(() => {
    const el = document.querySelector('.po-chat-compare-item');
    return el && !el.classList.contains('po-cand-just-applied');
  }, null, { timeout: 5000 });
});

// ═══════════════════════════════════════════════
// T19-3 spinner 800ms linear infinite;reduced-motion 关闭循环
// ═══════════════════════════════════════════════

test('T19-3 spinner 800ms linear infinite;Agent 循环动效;reduced-motion 下 animationName=none', async ({ page }) => {
  await setupRoutes(page);
  // agent/chat 加延迟,确保 running 态可观测(mock 立即返回会导致状态瞬间过去)
  await page.route('**/api/agent/chat', async r => {
    await new Promise(res => setTimeout(res, 1500));
    await r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(FX.makeAgentResponse('t19 测试')) });
  });
  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await injectData(page);

  // ── 请求 spinner:.po-status-running::before = po-spin / 0.8s / linear / infinite ──
  // data 页状态条(#dv-status)带 .po-status-bar class
  await page.evaluate(() => PO.router.navigate('data'));
  await expect(page.locator('#dv-drop-zone')).toBeVisible();
  const spin = await page.evaluate(() => {
    const bar = document.getElementById('dv-status');
    bar.hidden = false;
    bar.className = 'po-status-bar po-status-running'; // 运行中状态(请求 spinner)
    const cs = getComputedStyle(bar, '::before');
    return { name: cs.animationName, duration: cs.animationDuration,
      timing: cs.animationTimingFunction, count: cs.animationIterationCount };
  });
  expect(spin.name).toBe('po-spin');
  expect(parseFloat(spin.duration)).toBeCloseTo(0.8, 1);
  expect(spin.timing).toBe('linear');
  expect(spin.count).toBe('infinite');

  // ── Agent 运行中循环动效:.po-chat-dot-anim(三点弹跳) ──
  await page.evaluate(() => PO.router.navigate('chat'));
  await page.fill('#chat-input', '测试问题');
  await page.click('#chat-send');
  await page.waitForFunction(() =>
    document.querySelector('.po-chat-dot-anim') != null, null, { timeout: 10000 });
  const agentAnim = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.po-chat-dot-anim'));
    return { name: cs.animationName, count: cs.animationIterationCount };
  });
  expect(agentAnim.name).toBe('po-chat-bounce');
  expect(agentAnim.count).toBe('infinite');

  // ── reduced-motion:关闭所有循环与位移 ──
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => {
    // 临时元素验证 CSS 规则在 reduced-motion 下生效(不依赖实际运行状态)
    const tmp = document.createElement('div');
    tmp.className = 'po-status-bar po-status-running';
    document.body.appendChild(tmp);
    const dot = document.createElement('span');
    dot.className = 'po-chat-dot-anim';
    tmp.appendChild(dot);
    const applied = document.createElement('div');
    applied.className = 'po-cand-just-applied';
    tmp.appendChild(applied);
    const res = {
      fadeName: getComputedStyle(tmp).animationName,             // 淡入关闭
      spinName: getComputedStyle(tmp, '::before').animationName,  // 请求 spinner 循环关闭
      dotName: getComputedStyle(dot).animationName,               // Agent 弹跳循环关闭
      appliedName: getComputedStyle(applied).animationName,       // 应用高亮关闭
    };
    tmp.remove();
    return res;
  });
  expect(reduced.fadeName).toBe('none');
  expect(reduced.spinName).toBe('none');
  expect(reduced.dotName).toBe('none');
  expect(reduced.appliedName).toBe('none');

  // 等 agent 完成,恢复媒体偏好
  await page.waitForFunction(() => !PO.agent.isRunning(), null, { timeout: 10000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

// ═══════════════════════════════════════════════
// T19-4 动效不改变候选项尺寸、不抢滚动位置
// ═══════════════════════════════════════════════

test('T19-4 动效不改变候选项尺寸、不抢滚动位置;高亮结束不产生布局位移', async ({ page }) => {
  await setupRoutes(page);
  await setupScenario(page);

  // 应用 → 高亮动效出现(内容此时已稳定:按钮已替换为"已应用"徽章)
  await page.click('.po-chat-card[data-card-type="compare"] [data-action="apply-candidate"]');
  await page.waitForFunction(() =>
    document.querySelector('.po-chat-compare-item.po-cand-just-applied') != null, null, { timeout: 10000 });

  // 高亮播放中:尺寸与滚动位置(内容稳定后基准)
  const during = await page.evaluate(() => {
    const c = document.querySelector('.po-chat-compare-item.po-cand-just-applied');
    return { w: c.offsetWidth, h: c.offsetHeight, scrollY: window.scrollY };
  });
  await page.waitForTimeout(100); // 播放中再采样
  const during2 = await page.evaluate(() => {
    const c = document.querySelector('.po-chat-compare-item.po-cand-just-applied');
    return { w: c.offsetWidth, h: c.offsetHeight, scrollY: window.scrollY };
  });
  expect(during2.w).toBe(during.w);
  expect(during2.h).toBe(during.h);
  expect(during2.scrollY).toBe(during.scrollY);

  // 高亮 class 移除后:尺寸与滚动位置仍不变(动效结束不产生布局位移)
  await page.waitForFunction(() => {
    const c = document.querySelector('.po-chat-compare-item');
    return c && !c.classList.contains('po-cand-just-applied');
  }, null, { timeout: 5000 });
  const after = await page.evaluate(() => {
    const c = document.querySelector('.po-chat-compare-item');
    return { w: c.offsetWidth, h: c.offsetHeight, scrollY: window.scrollY };
  });
  expect(after.w).toBe(during.w);
  expect(after.h).toBe(during.h);
  expect(after.scrollY).toBe(during.scrollY);
});