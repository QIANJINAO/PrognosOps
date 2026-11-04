// S12 验收:接入任务输入与真实运行时间线(对话主体版)
// 覆盖:中文输入法/换行/快捷提交/连点锁、回包前无虚构步骤、
//       部分失败标注/折叠/键盘展开、错误摘要/重试/失败草稿保留

const { test, expect } = require('@playwright/test');
const FX = require('./fixtures/api-fixture');
const NEXT_PAGE = '/static/index.html';

// 辅助:进入对话页(默认路由自动 mount chatView)+ 注入会话上下文
async function setupAgent(page) {
  await page.route('**/api/health', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', version: 'vtest' }) });
  });
  await page.goto(NEXT_PAGE + '#/chat');
  await page.evaluate(() => {
    PO.setContext({ sessionId: 'sess-t12', unitId: 1 });
  });
  // 对话输入框挂载就绪
  await expect(page.locator('#chat-input')).toBeVisible();
}

test.describe('S12:接入任务输入与真实运行时间线', () => {

  test('T12-1:中文输入法不提交,Enter 换行,Ctrl+Enter 提交,连点只发 1 次', async ({ page }) => {
    let agentCount = 0;
    await page.route('**/api/agent/chat', async route => {
      agentCount++;
      await new Promise(r => setTimeout(r, 400));
      const req = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(FX.makeAgentResponse(req.query)) });
    });
    await setupAgent(page);

    // 1. isComposing 期间 Ctrl+Enter 不提交
    await page.fill('#chat-input', '中文输入测试');
    await page.evaluate(() => {
      document.getElementById('chat-input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })
      );
    });
    await page.waitForTimeout(150);
    expect(agentCount).toBe(0);

    // 2. Enter(无修饰)换行,不提交
    await page.press('#chat-input', 'Enter');
    await page.waitForTimeout(150);
    expect(agentCount).toBe(0);
    const val = await page.inputValue('#chat-input');
    expect(val).toContain('\n'); // 换行了

    // 3. Ctrl+Enter 提交
    await page.press('#chat-input', 'Control+Enter');
    await page.waitForFunction(() => !PO.agent.isRunning());
    expect(agentCount).toBe(1);
    await expect(page.locator('#chat-input')).toHaveValue(''); // 提交后清空

    // 4. 连点锁:请求中发送按钮禁用,直调 submit 被锁拦截,只发 1 次
    await page.fill('#chat-input', '第二个问题');
    await page.click('#chat-send');
    await page.waitForFunction(() => PO.agent.isRunning());
    // 发送按钮禁用 + 文案"处理中..."
    await expect(page.locator('#chat-send')).toBeDisabled();
    await expect(page.locator('#chat-send')).toContainText('处理中');
    // 业务锁:运行中直调 PO.agent.submit 返回 null(不发出请求)
    const blocked = await page.evaluate(() => PO.agent.submit('连点测试'));
    expect(blocked).toBeNull();
    await page.waitForFunction(() => !PO.agent.isRunning());
    expect(agentCount).toBe(2); // 只多发了 1 次(第二个问题)
  });

  test('T12-2:回包前只显示"正在分析"无虚构步骤,回包后按顺序显示真实记录', async ({ page }) => {
    let resolveAgent;
    const agentPromise = new Promise(r => { resolveAgent = r; });
    await page.route('**/api/agent/chat', async route => {
      await agentPromise;
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(FX.makeAgentResponse('测试问题')) });
    });
    await setupAgent(page);

    await page.fill('#chat-input', '测试问题');
    await page.click('#chat-send');
    await page.waitForFunction(() => PO.agent.isRunning());

    // 回包前:Agent 消息显示"正在分析问题",无工具日志(不编造步骤)
    await expect(page.locator('.po-chat-msg-agent').last()).toContainText('正在分析问题');
    await expect(page.locator('.po-chat-tool-log')).toHaveCount(0);

    // 回包
    resolveAgent();
    await page.waitForFunction(() => !PO.agent.isRunning());

    // 回包后:按 tool_calls_log 顺序显示真实记录
    const tools = await page.$$eval('.po-chat-tool-log .po-chat-tool-name', els => els.map(e => e.textContent));
    expect(tools).toEqual(['get_rul_summary', 'compare_strategies']);
    await expect(page.locator('.po-chat-tool-log')).toContainText('完成');
    await expect(page.locator('.po-chat-msg-agent .po-chat-msg-text').last()).toContainText('ETO-C');
  });

  test('T12-3:部分工具失败标注,缺 result 标"无结果",工具日志折叠键盘可展开', async ({ page }) => {
    await page.route('**/api/agent/chat', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          answer: '部分工具执行失败,请参考以下信息。',
          tool_calls_log: [
            { tool: 'get_rul_summary', args: { unit_id: 1 }, result: { mean_rul: 48.5 }, round: 1 },
            { tool: 'recompute_decision', args: { cm: 20 }, result: { error: true, message: '计算失败' }, round: 2 },
            { tool: 'no_result_tool', args: {}, round: 3 },
          ],
          model_used: 'fixture-mock', n_rounds: 3,
        }) });
    });
    await setupAgent(page);
    await page.fill('#chat-input', '测试');
    await page.click('#chat-send');
    await page.waitForFunction(() => !PO.agent.isRunning());

    // meta 标注部分工具失败
    await expect(page.locator('.po-chat-msg-agent .po-chat-meta-warn').last()).toContainText('部分工具执行失败');

    // 工具日志:三种状态(完成/失败/无结果)
    const statuses = await page.$$eval('.po-chat-tool-log .po-chat-tool-status', els => els.map(e => e.textContent));
    expect(statuses).toEqual(['完成', '失败', '无结果']);

    // 工具日志默认折叠(details 未 open)
    const openBefore = await page.$$eval('.po-chat-tool-log', els => els.map(e => e.open));
    expect(openBefore).toContain(false);

    // 键盘展开:focus summary + Enter → open
    await page.locator('.po-chat-tool-log summary').first().focus();
    await page.keyboard.press('Enter');
    const openAfter = await page.$$eval('.po-chat-tool-log', els => els.map(e => e.open));
    expect(openAfter[0]).toBe(true);
  });

  test('T12-4:错误消息含摘要,重试发新请求,失败草稿保留', async ({ page }) => {
    let agentCount = 0;
    await page.route('**/api/agent/chat', async route => {
      agentCount++;
      await route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ detail: { code: 'E5001', message: '模型服务不可用' } }) });
    });
    await setupAgent(page);

    // 1. 提交 → 500 错误:错误文本 + 重试按钮(data-query 保留原问题)+ 失败草稿回到输入框
    await page.fill('#chat-input', '第一个问题');
    await page.click('#chat-send');
    await page.waitForFunction(() => !PO.agent.isRunning());
    expect(agentCount).toBe(1);
    await expect(page.locator('.po-chat-msg-agent .po-chat-text-error').last()).toContainText('模型服务不可用');
    const retryBtn = page.locator('[data-action="retry-agent"]').last();
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toHaveAttribute('data-query', '第一个问题');
    // 失败草稿保留在输入框
    await expect(page.locator('#chat-input')).toHaveValue('第一个问题');

    // 2. 点击重试 → 发新请求(仍 500)
    await retryBtn.click();
    await page.waitForFunction(() => !PO.agent.isRunning());
    expect(agentCount).toBe(2);
    await expect(page.locator('.po-chat-msg-agent .po-chat-text-error').last()).toContainText('模型服务不可用');
    await expect(page.locator('[data-action="retry-agent"]').last()).toBeVisible();
  });

});