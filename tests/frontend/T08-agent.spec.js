// S08 验收:收口 Agent 提交与会话边界
// 覆盖:按钮/快捷问题/键盘同时触发只发 1 次请求、上下文变化后不携带旧历史、
//       仅有文字无结构化结果不生成候选、HTTP 200 部分失败不标全成功

const { test, expect } = require('@playwright/test');
const apiFx = require('./fixtures/api-fixture');

test.describe('S08:收口 Agent 提交与会话边界', () => {

  test('T08-1:并发提交只发 1 次请求(业务锁,S20 移交浏览器行为用例)', async ({ page }) => {
    let agentCount = 0;
    await page.route('**/api/agent/chat', async route => {
      agentCount++;
      await new Promise(r => setTimeout(r, 600)); // 延迟让并发触发可观测
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeAgentResponse('测试问题')) });
    });
    await page.goto('/static/index.html');
    // S20:旧页 DOM(.nav-tab/#query-input)随入口切换清理,改为模块级并发验证
    const results = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      const p1 = PO.agent.submit('第一个问题');
      const p2 = PO.agent.submit('第二个问题'); // 业务锁应拒绝
      return Promise.all([p1, p2]);
    });
    expect(agentCount).toBe(1); // 只发 1 次请求
    expect(results[1]).toBeNull(); // 第二次被锁拒绝
    expect(results[0]).not.toBeNull(); // 第一次正常执行
  });

  test('T08-2:上下文变化后不携带旧历史', async ({ page }) => {
    let lastPayload = null;
    await page.route('**/api/agent/chat', async route => {
      lastPayload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeAgentResponse(lastPayload.query)) });
    });
    await page.goto('/static/index.html');
    // 第一次提交(无历史)
    await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      await PO.agent.submit('第一个问题');
    });
    expect(lastPayload.history).toEqual([]);
    // 上下文变化(换设备 → contextRev 递增)
    await page.evaluate(() => PO.setContext({ unitId: 2 }));
    // 第二次提交:旧历史不携带(contextRev 已变化)
    await page.evaluate(async () => {
      await PO.agent.submit('第二个问题');
    });
    expect(lastPayload.history).toEqual([]);
    // 同一上下文内第三次提交:应携带第二次的对话(2 条),不含第一次的
    await page.evaluate(async () => {
      await PO.agent.submit('第三个问题');
    });
    expect(lastPayload.history.length).toBe(2);
    expect(lastPayload.history[0].role).toBe('user');
    expect(lastPayload.history[0].content).toBe('第二个问题');
    expect(lastPayload.history[1].role).toBe('assistant');
  });

  test('T08-3:仅有"成本翻倍"文字而无结构化结果时不生成可应用候选', async ({ page }) => {
    await page.route('**/api/agent/chat', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          answer: '如果停机损失翻倍,建议提前更换。成本翻倍后 ETO-C 推荐窗口会前移。',
          tool_calls_log: [
            { tool: 'get_rul_summary', args: {}, result: { mean_rul: 48.5 }, round: 1 },
          ],
          model_used: 'fixture-mock', n_rounds: 1,
        }) });
    });
    await page.goto('/static/index.html');
    await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      await PO.agent.submit('如果停机损失翻倍会怎样?');
    });
    const candidates = await page.evaluate(() => PO.getState().candidates);
    expect(candidates).toEqual([]);
  });

  test('T08-4:HTTP 200 中的部分失败不标全成功', async ({ page }) => {
    await page.route('**/api/agent/chat', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          answer: '部分工具执行失败,请参考以下信息。',
          tool_calls_log: [
            { tool: 'get_rul_summary', args: {}, result: { mean_rul: 48.5 }, round: 1 },
            { tool: 'recompute_decision', args: { cm: 20 }, result: { error: true, tool: 'recompute_decision', message: '计算失败' }, round: 2 },
          ],
          model_used: 'fixture-mock', n_rounds: 2,
        }) });
    });
    await page.goto('/static/index.html');
    // S20:旧页 DOM(#query-response/.tool-call-item)随入口切换清理,改为模块级验证
    const result = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      return await PO.agent.submit('如果停机损失翻倍会怎样?');
    });
    // 成功返回(有 answer,不是 error)
    expect(result.error).toBeUndefined();
    expect(result.result.answer).toContain('部分工具执行失败');
    // tool_calls_log 中失败工具被记录(数据层不丢失失败信息)
    const failed = result.result.tool_calls_log.filter(t => t.result && t.result.error);
    expect(failed).toHaveLength(1);
    expect(failed[0].result.message).toBe('计算失败');
  });

});