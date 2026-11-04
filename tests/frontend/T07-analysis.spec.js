// S07 验收:打通草稿与预测—决策链
// 覆盖:决策概率=同次预测返回/参数=开始快照、预测失败不发决策、决策重试不重复预测、
//       非法参数不发请求、编辑草稿不改已应用结果、预测成功决策失败保留预测可重试、
//       空值与 0 分开/保留 random_seed=0

const { test, expect } = require('@playwright/test');
const apiFx = require('./fixtures/api-fixture');

test.describe('S07:打通草稿与预测—决策链', () => {

  test('T07-1:决策概率等于同次预测返回,参数等于开始快照', async ({ page }) => {
    const rulResp = apiFx.makeRULResponse('sess-1', 1, 40);
    let decPayload = null;
    await page.route('**/api/rul/predict', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(rulResp) });
    });
    await page.route('**/api/decision/run', async route => {
      decPayload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeDecisionResponse()) });
    });
    await page.goto('/static/index.html');
    const result = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      PO.setDraftParams({ cm: '2', cd: '10', cp: '60', cc: '250', alpha: '0.05' });
      const r = await PO.analysis.runCurrent({
        sessionId: 'sess-1', unitId: 1, cycle: 40, k_nn: 50,
        params: { cm: '2', cd: '10', cp: '60', cc: '250', alpha: '0.05' },
      });
      return { stale: r.stale, hasDecision: !!r.decision };
    });
    expect(result.stale).toBe(false);
    expect(result.hasDecision).toBe(true);
    // 决策概率等于同次预测返回
    expect(decPayload.probs).toEqual(rulResp.discrete.probs);
    // 参数等于开始快照(校验后的数值)
    expect(decPayload.params.cm).toBe(2);
    expect(decPayload.params.cd).toBe(10);
    expect(decPayload.params.cp).toBe(60);
    expect(decPayload.params.cc).toBe(250);
    expect(decPayload.params.alpha).toBe(0.05);
    // h_max 来自本次预测
    expect(decPayload.params.h_max).toBe(rulResp.discrete.h_max);
  });

  test('T07-2:预测失败不发决策', async ({ page }) => {
    let decCount = 0;
    await page.route('**/api/rul/predict', async route => {
      await route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ detail: '预测服务内部错误' }) });
    });
    await page.route('**/api/decision/run', async route => {
      decCount++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/static/index.html');
    const err = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      try {
        await PO.analysis.runCurrent({
          sessionId: 'sess-1', unitId: 1,
          params: { cm: '1', cd: '5', cp: '50', cc: '200', alpha: '0.01' },
        });
        return null;
      } catch (e) { return { kind: e.kind, status: e.status }; }
    });
    expect(err).not.toBeNull();
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
    expect(decCount).toBe(0); // 预测失败不发决策
  });

  test('T07-3:决策重试不重复预测', async ({ page }) => {
    let predCount = 0;
    await page.route('**/api/rul/predict', async route => {
      predCount++;
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeRULResponse('sess-1', 1, 40)) });
    });
    await page.route('**/api/decision/run', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeDecisionResponse()) });
    });
    await page.goto('/static/index.html');
    const result = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      const params = { cm: '1', cd: '5', cp: '50', cc: '200', alpha: '0.01' };
      const r1 = await PO.analysis.runCurrent({ sessionId: 'sess-1', unitId: 1, params });
      const r2 = await PO.analysis.retryDecision({ params });
      return { run1Ok: !!r1.decision, run2Ok: !!r2.decision };
    });
    expect(result.run1Ok).toBe(true);
    expect(result.run2Ok).toBe(true);
    expect(predCount).toBe(1); // 重试决策不重复预测
  });

  test('T07-4:非法参数不发请求', async ({ page }) => {
    let predCount = 0, decCount = 0;
    await page.route('**/api/rul/predict', async route => { predCount++; await route.fulfill({ status: 200, body: '{}' }); });
    await page.route('**/api/decision/run', async route => { decCount++; await route.fulfill({ status: 200, body: '{}' }); });
    await page.goto('/static/index.html');
    const err = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      try {
        await PO.analysis.runCurrent({
          sessionId: 'sess-1', unitId: 1,
          params: { cm: '0', cd: '5', cp: '50', cc: '200', alpha: '0.01' }, // cm=0 非法
        });
        return null;
      } catch (e) { return { kind: e.kind, fieldErrors: e.fieldErrors }; }
    });
    expect(err).not.toBeNull();
    expect(err.kind).toBe('validation');
    expect(err.fieldErrors.some(fe => fe.field === 'cm')).toBe(true);
    expect(predCount).toBe(0); // 非法参数不发请求
    expect(decCount).toBe(0);
  });

  test('T07-5:编辑草稿不改变已应用结果', async ({ page }) => {
    await page.route('**/api/rul/predict', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeRULResponse('sess-1', 1, 40)) });
    });
    await page.route('**/api/decision/run', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeDecisionResponse()) });
    });
    await page.goto('/static/index.html');
    const result = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      const params = { cm: '1', cd: '5', cp: '50', cc: '200', alpha: '0.01' };
      await PO.analysis.runCurrent({ sessionId: 'sess-1', unitId: 1, params });
      const before = PO.getState().appliedScenario;
      // 编辑草稿(只改 draft,不改 appliedScenario)
      PO.setDraftParams({ cm: '999', cd: '5', cp: '50', cc: '200', alpha: '0.01' });
      const after = PO.getState().appliedScenario;
      const draft = PO.getState().draft;
      return {
        beforeCm: before.params.cm, afterCm: after.params.cm,
        draftCm: Number(draft.cm),
      };
    });
    expect(result.beforeCm).toBe(result.afterCm); // 已应用结果不变
    expect(result.draftCm).toBe(999); // 草稿已更新
  });

  test('T07-6:预测成功决策失败保留预测,可单独重试', async ({ page }) => {
    let decCallCount = 0; // 第 1 次决策失败,第 2 次(重试)成功
    await page.route('**/api/rul/predict', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeRULResponse('sess-1', 1, 40)) });
    });
    await page.route('**/api/decision/run', async route => {
      decCallCount++;
      if (decCallCount === 1) {
        await route.fulfill({ status: 500, contentType: 'application/json',
          body: JSON.stringify({ detail: '决策计算失败' }) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(apiFx.makeDecisionResponse()) });
      }
    });
    await page.goto('/static/index.html');
    const result = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      const params = { cm: '1', cd: '5', cp: '50', cc: '200', alpha: '0.01' };
      const r1 = await PO.analysis.runCurrent({ sessionId: 'sess-1', unitId: 1, params });
      const predRetained = PO.getState().prediction !== null;
      // 单独重试决策(不重新预测)
      const r2 = await PO.analysis.retryDecision({ params });
      return {
        hasDecisionError: !!r1.decisionError,
        predRetained,
        retryOk: !!r2.decision,
        appliedSet: PO.getState().appliedScenario !== null,
      };
    });
    expect(result.hasDecisionError).toBe(true);
    expect(result.predRetained).toBe(true); // 预测保留
    expect(result.retryOk).toBe(true); // 重试成功
    expect(result.appliedSet).toBe(true); // 方案已应用
  });

  test('T07-7:空值与 0 分开,保留 random_seed=0', async ({ page }) => {
    await page.goto('/static/index.html');
    const v = await page.evaluate(() => {
      return PO.parameters.validate({
        cm: '', cd: '0', cp: '1', cc: '1', alpha: '1', random_seed: '0',
      });
    });
    expect(v.valid).toBe(false);
    // cm 空值报"不能为空"(与 0 分开)
    expect(v.fieldErrors.some(fe => fe.field === 'cm' && fe.message.includes('不能为空'))).toBe(true);
    // cd=0 合法(≥0)
    expect(v.params.cd).toBe(0);
    // random_seed=0 保留(不能用 falsy 跳过)
    expect(v.params.random_seed).toBe(0);
  });

});