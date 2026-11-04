/**
 * S02 统一状态与结果归属:PO.store 接口行为验证
 * 验收断言(施工单 S02):
 *   T02-1 改返回对象不脏 store
 *   T02-2 编辑表单不动运行快照
 *   T02-3 旧版本结果不成为当前结果(乱序回包防护)
 * 附加:subscribe 通知与取消、resetDataset 行为(S20:旧页回归用例随入口切换删除,无重复绑定由 T09-2 覆盖)
 */
const { test, expect } = require('@playwright/test');

// ───────── T02-1:改返回对象不脏 store ─────────
test('T02-1:改返回对象不脏 store', async ({ page }) => {
  await page.goto('/static/index.html');
  await page.evaluate(() => {
    window.PO.setContext({ sessionId: 'sess-001', unitId: 101 });
  });
  // 获取快照后恶意修改,再取一次验证未被污染
  const clean = await page.evaluate(() => {
    const s = window.PO.getState();
    s.context.sessionId = 'HACKED';
    s.context.unitId = 999;
    s.runs.push({ runId: 'FAKE' });
    s.prediction = { lam: 0 };
    return window.PO.getState();
  });
  expect(clean.context.sessionId).toBe('sess-001');
  expect(clean.context.unitId).toBe(101);
  expect(clean.runs).toHaveLength(0);
  expect(clean.prediction).toBeNull();
});

// ───────── T02-2:编辑表单不动运行快照 ─────────
test('T02-2:编辑表单不动运行快照', async ({ page }) => {
  await page.goto('/static/index.html');
  const result = await page.evaluate(() => {
    // 开始决策运行,快照记录当前参数
    const runId = window.PO.startRun('decision', { cm: 1, cd: 5, cp: 50, cc: 200, alpha: 0.01 });
    // 用户编辑表单(草稿变更)
    window.PO.setDraftParams({ cm: 999, cd: 888, cp: 50, cc: 200, alpha: 0.01 });
    const s = window.PO.getState();
    const run = s.runs.find(r => r.runId === runId);
    return { draft: s.draft, snapshot: run.snapshot };
  });
  // 草稿已更新为新值
  expect(result.draft.cm).toBe(999);
  expect(result.draft.cd).toBe(888);
  // 运行快照保持发起时的原值
  expect(result.snapshot.cm).toBe(1);
  expect(result.snapshot.cd).toBe(5);
});

// ───────── T02-3:旧版本结果不成为当前结果(乱序回包防护) ─────────
test('T02-3:旧版本结果不成为当前结果', async ({ page }) => {
  await page.goto('/static/index.html');
  // 场景 A:旧 runA 先完成、新 runB 后完成 → prediction 应为 runB
  const resultA = await page.evaluate(() => {
    const runA = window.PO.startRun('predict', { unitId: 101 });
    const runB = window.PO.startRun('predict', { unitId: 102 });
    window.PO.finishRun(runA, { unit_id: 101, lam: 62.5 });
    window.PO.finishRun(runB, { unit_id: 102, lam: 88.8 });
    const s = window.PO.getState();
    return {
      prediction: s.prediction,
      runAStatus: s.runs.find(r => r.runId === runA).status,
      runBStatus: s.runs.find(r => r.runId === runB).status,
    };
  });
  expect(resultA.prediction.unit_id).toBe(102);
  expect(resultA.prediction.lam).toBe(88.8);
  expect(resultA.runAStatus).toBe('success');
  expect(resultA.runBStatus).toBe('success');
});

// ───────── T02-4:旧结果后完成不覆盖新结果(反向乱序) ─────────
test('T02-4:旧结果后完成不覆盖新结果', async ({ page }) => {
  await page.goto('/static/index.html');
  // 场景 B:新 runB 先完成、旧 runA 后完成 → prediction 仍应为 runB
  const resultB = await page.evaluate(() => {
    const runA = window.PO.startRun('predict', { unitId: 101 });
    const runB = window.PO.startRun('predict', { unitId: 102 });
    window.PO.finishRun(runB, { unit_id: 102, lam: 88.8 }); // 新的先完成
    window.PO.finishRun(runA, { unit_id: 101, lam: 62.5 }); // 旧的后完成
    return window.PO.getState().prediction;
  });
  expect(resultB.unit_id).toBe(102);
  expect(resultB.lam).toBe(88.8);
});

// ───────── T02-5:subscribe 通知与取消订阅 ─────────
test('T02-5:subscribe 通知与取消订阅', async ({ page }) => {
  await page.goto('/static/index.html');
  const result = await page.evaluate(() => {
    // 先触发数据加载检测,避免后续 setContext 级联 addMessage(会话视图对 sessionId 变化追加卡片)
    window.PO.setContext({ sessionId: 'init' });
    let count = 0;
    const unsubscribe = window.PO.subscribe(() => count++);
    window.PO.setContext({ unitId: 1 });      // +1(sessionId 未变,无级联)
    window.PO.setContext({ cycle: 40 });      // +1
    const afterSub = count;
    unsubscribe();
    window.PO.setContext({ cycle: 50 });      // 取消后不触发
    return { afterSub, final: count };
  });
  expect(result.afterSub).toBe(2);
  expect(result.final).toBe(2);
});

// ───────── T02-6:resetDataset 清空结果层且 contextRev 递增 ─────────
test('T02-6:resetDataset 清空结果层且 contextRev 递增', async ({ page }) => {
  await page.goto('/static/index.html');
  const result = await page.evaluate(() => {
    // 建立完整状态
    window.PO.setContext({ sessionId: 'sess-001' });
    const runId = window.PO.startRun('predict', {});
    window.PO.finishRun(runId, { lam: 62.5 });
    window.PO.setDraftParams({ cm: 1 });
    const revBefore = window.PO.getState().context.contextRev;
    // 重置(模拟上传新数据)
    window.PO.resetDataset();
    const after = window.PO.getState();
    return {
      revBefore,
      revAfter: after.context.contextRev,
      predictionCleared: after.prediction === null,
      runsCleared: after.runs.length === 0,
      draftCleared: after.draft === null,
      sessionIdCleared: after.context.sessionId === null,
    };
  });
  expect(result.revAfter).toBeGreaterThan(result.revBefore);
  expect(result.predictionCleared).toBe(true);
  expect(result.runsCleared).toBe(true);
  expect(result.draftCleared).toBe(true);
  expect(result.sessionIdCleared).toBe(true);
});

// S20:旧页回归用例(T02-7)随默认入口切换删除——旧页 DOM(#file-input/.nav-tab/App.syncToStore)
// 已清理,无重复绑定由 T09-2(重复 init 不重复注册)覆盖。