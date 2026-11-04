/* ═══════════════════════════════════════════════
   T18:完成移动端、长内容与键盘验收(S18)(对话主体版)
   覆盖施工单验收:
   - 6 视口(3 桌面+3 移动)无整页横滚,对话控件 boundingClientRect 两两不相交
   - 1440×900 走通分析→Agent→导出完整链路
   - 长内容:120 字符文件名/5000 字回答/1000 行表格,正文可选取
   - 键盘全链路:Tab 遍历/上传 Enter+Space/工具日志 details Enter/抽屉 Esc
   - 状态可访问:aria-live polite/失败持久显示/服务不可达界面完整
   ═══════════════════════════════════════════════ */
const { test, expect } = require('@playwright/test');
const FX = require('./fixtures/api-fixture');

const NEXT_PAGE = '/static/index.html';

// 施工单必测视口:桌面 3 + 移动 3
const VIEWPORTS = [
  { name: '桌面 1280×800', width: 1280, height: 800 },
  { name: '桌面 1440×900', width: 1440, height: 900 },
  { name: '桌面 1920×1080', width: 1920, height: 1080 },
  { name: '移动 360×800', width: 360, height: 800 },
  { name: '移动 390×844', width: 390, height: 844 },
  { name: '平板 768×1024', width: 768, height: 1024 },
];

// ───────── 辅助:路由 mock ─────────
async function setupRoutes(page, opts = {}) {
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', version: 'test' }),
  }));
  await page.route('**/api/rul/predict', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeRULResponse('sess-t18', 1, 40)),
  }));
  await page.route('**/api/decision/run', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(opts.decisionResp || FX.makeDecisionResponse()),
  }));
  await page.route('**/api/backtest/run', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FX.makeBacktestResponse()),
  }));
  await page.route('**/api/agent/chat', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(opts.agentResp || FX.makeAgentResponse('t18 测试问题')),
  }));
}

// ───────── 辅助:注入数据状态(上传链路由 T10 覆盖) ─────────
async function injectData(page, opts = {}) {
  await page.evaluate((o) => {
    PO.setData({
      overview: { total_rows: 100, unit_count: 2, columns: 26, separator: ' ',
        units: [{ unit_id: 1, cycles: 50 }, { unit_id: 2, cycles: 50 }] },
      qualityReport: { file_name: o.fileName || 't18.csv', file_size_mb: 0.05, file_empty: false,
        total_rows: 100, total_columns: 26, unit_count: 2, is_valid: true, has_critical: false,
        column_mapping: { unit_column: 'unit', cycle_column: 'cycle', setting_columns: [],
          selected_sensors: [], missing_sensors: [], constant_sensors: [], all_columns: [] },
        checks: [], units: [
          { unit_id: 1, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
          { unit_id: 2, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
        ], assumptions: [] },
      unitIds: [1, 2],
    });
    PO.setContext({ sessionId: 'sess-t18', unitId: 1, cycle: 40 });
  }, opts);
}

// ───────── 辅助:boundingClientRect 两两不相交(Node 侧) ─────────
function intersects(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// ═══════════════════════════════════════════════
// T18-1 六视口无整页横滚、对话控件不相交;1440×900 完整链路
// ═══════════════════════════════════════════════

test('T18-1 六视口无整页横滚、对话控件不相交;1440×900 走通分析→Agent→导出', async ({ page }) => {
  await setupRoutes(page);
  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await injectData(page);

  // 各视口走通分析,断言无横滚 + 对话控件不相交
  for (let vi = 0; vi < VIEWPORTS.length; vi++) {
    const vp = VIEWPORTS[vi];
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.click('.po-chat-quick-btn[data-action="start-analysis"]');
    // 等本次分析完成(predict run 成功数达到期望)
    const expected = vi + 1;
    await page.waitForFunction((n) => {
      const runs = (PO.getState().runs || []).filter(r => r.kind === 'predict' && r.status === 'success');
      return runs.length >= n;
    }, expected, { timeout: 10000 });

    // 无整页横滚
    const noHScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth);
    expect(noHScroll, vp.name + ' 不应整页横滚').toBe(true);

    // 输入框与发送按钮 boundingClientRect 不相交(施工单:不得只查 scrollWidth)
    const btnVsInput = await page.evaluate(() => {
      const b = document.getElementById('chat-send').getBoundingClientRect();
      const a = document.getElementById('chat-input').getBoundingClientRect();
      return b.left < a.right && a.left < b.right && b.top < a.bottom && a.top < b.bottom;
    });
    expect(btnVsInput, vp.name + ' 发送按钮不应与输入框重叠').toBe(false);

    // 快捷任务按钮两两不相交
    const quickRects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.po-chat-quick-btn')).map(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }));
    for (let i = 0; i < quickRects.length; i++) {
      for (let j = i + 1; j < quickRects.length; j++) {
        expect(intersects(quickRects[i], quickRects[j]),
          vp.name + ' 快捷任务按钮 ' + i + ' 与 ' + j + ' 不应相交').toBe(false);
      }
    }
  }

  // ── 1440×900 完整链路:Agent→导出 ──
  await page.setViewportSize({ width: 1440, height: 900 });

  // Agent 提交 → 回答显示
  await page.fill('#chat-input', '为什么推荐这个维修窗口?');
  await page.click('#chat-send');
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('.po-chat-msg-agent .po-chat-msg-text');
    return els.length > 0 && els[els.length - 1].textContent.length > 0;
  }, null, { timeout: 10000 });
  await expect(page.locator('.po-chat-msg-agent .po-chat-msg-text').last()).toContainText('分析');

  // 决策分析后 appliedScenario 已设置
  const applied = await page.evaluate(() => PO.getState().appliedScenario != null);
  expect(applied).toBe(true);

  // 导出:从最近成功 predict run(含 decision)构建导出 JSON,内容非空(不发新计算)
  const exportOk = await page.evaluate(() => {
    const s = PO.getState();
    const runs = (s.runs || []).filter(r => r.kind === 'predict' && r.status === 'success' && r.decision);
    if (!runs.length) return false;
    const obj = PO.export.buildDecisionJson(runs[runs.length - 1]);
    return obj && obj.decision != null;
  });
  expect(exportOk).toBe(true);
});

// ═══════════════════════════════════════════════
// T18-2 长内容:120 字符文件名/5000 字回答/1000 行表格,正文可选取
// ═══════════════════════════════════════════════

test('T18-2 长内容折行完整可见、表格仅局部滚动,正文可选取', async ({ page }) => {
  // 120 字符无空格文件名(同时覆盖"120 字符文件名"与"长无空格字符串"两项)
  const LONG_NAME = 'a'.repeat(120) + '.csv';
  // 5000+ 字回答(约 5300 字)
  const LONG_ANSWER = '针对当前设备退化趋势的综合分析建议:基于威布尔拟合与离散RUL估计结果,推荐在窗口30执行预防性更换,以平衡期望成本与质量损失。'.repeat(90);

  await setupRoutes(page, {
    agentResp: FX.makeAgentResponse('长内容问题', { answer: LONG_ANSWER }),
  });
  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await injectData(page, { fileName: LONG_NAME });

  // ── 120 字符文件名:数据页状态条折行完整可见,无横向溢出 ──
  await page.evaluate(() => PO.router.navigate('data'));
  await expect(page.locator('#dv-drop-zone')).toBeVisible();
  await page.evaluate((name) => {
    const bar = document.getElementById('dv-status');
    bar.hidden = false;
    bar.textContent = '已导入:' + name;
  }, LONG_NAME);
  await expect(page.locator('#dv-status')).toContainText('aaaa'); // 文件名片段可见
  const nameNoOverflow = await page.evaluate(() => {
    const bar = document.getElementById('dv-status');
    return bar.scrollWidth <= bar.clientWidth + 1; // po-status-bar overflow-wrap:anywhere 折行生效
  });
  expect(nameNoOverflow).toBe(true);

  // ── 5000 字回答:完整显示且正文可选取复制 ──
  await page.evaluate(() => PO.router.navigate('chat'));
  await page.fill('#chat-input', '请给出长篇分析');
  await page.click('#chat-send');
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('.po-chat-msg-agent .po-chat-msg-text');
    return els.length > 0 && els[els.length - 1].textContent.length >= 5000;
  }, null, { timeout: 10000 });
  const selectable = await page.evaluate(() => {
    const els = document.querySelectorAll('.po-chat-msg-agent .po-chat-msg-text');
    const el = els[els.length - 1];
    return getComputedStyle(el).userSelect !== 'none';
  });
  expect(selectable).toBe(true);

  // ── 1000 行表格:仅挂当前页 50 行 + 分页 + 局部滚动不撑破页面 ──
  await page.evaluate(() => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ unit: i + 1, cycle: i * 10, rul: Math.max(0, 100 - i * 0.1) }));
    const root = document.createElement('div');
    root.id = 't18-rt-root';
    document.getElementById('page-chat').appendChild(root);
    PO.resultTable.render(root, {
      columns: [{ key: 'unit', label: '设备' }, { key: 'cycle', label: '时点' }, { key: 'rul', label: 'RUL' }],
      rows,
    });
  });
  const rowCount = await page.evaluate(() => document.querySelectorAll('#t18-rt-root tbody tr').length);
  expect(rowCount).toBeLessThanOrEqual(50); // 仅当前页
  await expect(page.locator('#t18-rt-root .po-rt-pager')).toContainText('共 1000 行');
  await page.click('#t18-rt-root .po-rt-next'); // 翻页后仍仅 50 行
  const rowCount2 = await page.evaluate(() => document.querySelectorAll('#t18-rt-root tbody tr').length);
  expect(rowCount2).toBeLessThanOrEqual(50);
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noHScroll).toBe(true); // 表格局部滚动,不产生整页横滚
});

// ═══════════════════════════════════════════════
// T18-3 键盘全链路:Tab/上传 Enter+Space/工具日志 details Enter/抽屉 Esc
// ═══════════════════════════════════════════════

test('T18-3 键盘全链路:Tab 遍历、上传 Enter+Space、工具日志 details Enter、抽屉 Esc', async ({ page }) => {
  await setupRoutes(page);
  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await injectData(page);

  // ── Tab 遍历:从 body 起 Tab 能到达发送按钮 ──
  await page.focus('body');
  let reachedSendBtn = false;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement ? document.activeElement.id : '');
    if (id === 'chat-send') { reachedSendBtn = true; break; }
  }
  expect(reachedSendBtn).toBe(true);

  // ── 上传区 Enter/Space 触发文件选择(spy click 计数) ──
  await page.evaluate(() => PO.router.navigate('data'));
  await expect(page.locator('#dv-drop-zone')).toBeVisible();
  await page.evaluate(() => {
    const fi = document.getElementById('dv-file-input');
    window.__t18FileClicks = 0;
    fi.click = () => { window.__t18FileClicks++; };
  });
  await page.focus('#dv-drop-zone');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__t18FileClicks)).toBeGreaterThanOrEqual(1);
  await page.keyboard.press(' ');
  expect(await page.evaluate(() => window.__t18FileClicks)).toBeGreaterThanOrEqual(2);

  // ── 对话输入框可访问名(aria-label)存在 ──
  await page.evaluate(() => PO.router.navigate('chat'));
  await expect(page.locator('#chat-input')).toHaveAttribute('aria-label', '对话输入框');

  // ── details Enter:工具日志键盘展开 ──
  await page.fill('#chat-input', '测试问题');
  await page.click('#chat-send');
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('.po-chat-msg-agent .po-chat-msg-text');
    return els.length > 0 && els[els.length - 1].textContent.length > 0;
  }, null, { timeout: 10000 });
  const toolLogSummary = page.locator('.po-chat-tool-log summary').first();
  await expect(toolLogSummary).toBeVisible();
  await toolLogSummary.focus();
  await page.keyboard.press('Enter');
  const opened = await page.evaluate(() => {
    const d = document.querySelector('.po-chat-tool-log');
    return d ? d.open === true : false;
  });
  expect(opened).toBe(true);

  // ── 抽屉 Esc 关闭 ──
  await page.evaluate(() => PO.runHistory.open());
  await expect(page.locator('#po-rh-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  const drawerClosed = await page.evaluate(() => {
    const overlay = document.getElementById('po-rh-overlay');
    return !overlay || overlay.hidden;
  });
  expect(drawerClosed).toBe(true);
});

// ═══════════════════════════════════════════════
// T18-4 状态可访问:aria-live polite/失败持久/服务不可达界面完整
// ═══════════════════════════════════════════════

test('T18-4 状态区 aria-live polite、失败持久显示、服务不可达界面完整', async ({ page }) => {
  await setupRoutes(page);
  await page.goto(NEXT_PAGE + '#/chat');
  await expect(page.locator('#chat-input')).toBeVisible();
  await injectData(page);

  // ── aria-live=polite:三状态区(对话消息流/data/backtest) ──
  await expect(page.locator('#chat-messages')).toHaveAttribute('aria-live', 'polite');
  await page.evaluate(() => PO.router.navigate('data'));
  await expect(page.locator('#dv-status')).toHaveAttribute('aria-live', 'polite');
  await page.evaluate(() => PO.router.navigate('validation'));
  await expect(page.locator('#bt-status')).toHaveAttribute('aria-live', 'polite');

  // ── 失败持久:决策 500 后错误系统消息持续显示,不自动消失 ──
  await page.evaluate(() => PO.router.navigate('chat'));
  await page.route('**/api/decision/run', r => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ detail: '服务内部错误' }),
  }));
  await page.click('.po-chat-quick-btn[data-action="start-analysis"]');
  // 等错误系统消息出现(含"失败"字样)
  const errMsg = page.locator('.po-chat-msg-system.po-chat-sys-error').last();
  await expect(errMsg).toContainText('失败', { timeout: 10000 });
  const errText1 = await errMsg.textContent();
  await page.waitForTimeout(1500); // 等 1.5s 验证非 Toast 自动消失
  const errText2 = await errMsg.textContent();
  expect(errText2).toBe(errText1); // 文本不变,仍持续显示

  // ── 服务不可达:全部 API 失败,界面仍完整可操作(健康检查不阻断) ──
  await page.route('**/api/**', r => r.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ detail: '服务不可达' }),
  }));
  await page.reload();
  // 侧栏导航三入口可见
  await expect(page.locator('.po-sidebar-link[data-route="chat"]')).toBeVisible();
  await expect(page.locator('.po-sidebar-link[data-route="data"]')).toBeVisible();
  await expect(page.locator('.po-sidebar-link[data-route="validation"]')).toBeVisible();
  // 对话页主体可见(刷新后无数据,显示欢迎屏,界面完整不白屏)
  await expect(page.locator('#page-chat')).toBeVisible();
  await expect(page.locator('#chat-input')).toBeVisible();
  await page.evaluate(() => PO.router.navigate('data')); // 可切换页面
  await expect(page.locator('#dv-drop-zone')).toBeVisible();
});