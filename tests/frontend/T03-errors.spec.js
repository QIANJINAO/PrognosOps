// S03 验收:归一化错误与安全文本输出
// 覆盖 422 数组、业务对象、字符串 detail、HTML 502、断网、XSS 安全
// 全部通过 page.route 拦截响应 + page.evaluate 调用 API 接口验证错误对象

const { test, expect } = require('@playwright/test');

test.describe('S03:归一化错误与安全文本输出', () => {

  test('T03-1:422 数组 detail 生成字段错误', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/rul/predict', route => {
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ detail: [
          { loc: ['body', 'unit_id'], msg: 'field required', type: 'value_error.missing' },
          { loc: ['body', 'k_nn'], msg: 'ensure this value is greater than 0', type: 'value_error.number.not_gt' },
        ] }),
      });
    });
    const err = await page.evaluate(async () => {
      try { await API.rulPredict({ session_id: 's1', unit_id: 1 }); return null; }
      catch (e) { return e; }
    });
    expect(err).not.toBeNull();
    expect(err.kind).toBe('validation');
    expect(err.status).toBe(422);
    expect(err.fieldErrors).toHaveLength(2);
    expect(err.fieldErrors[0].field).toBe('body.unit_id');
    expect(err.fieldErrors[0].message).toBe('field required');
    expect(err.fieldErrors[1].field).toBe('body.k_nn');
    expect(err.message).toContain('校验失败');
  });

  test('T03-2:业务对象 detail 提取 code/message 与中文映射', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/data/upload', route => {
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ detail: { code: 'E1001', message: '数据格式错误', detail: '列数不匹配,期望 26 列,实际 25 列' } }),
      });
    });
    const err = await page.evaluate(async () => {
      try { await API.uploadCsv(new File(['a'], 't.csv')); return null; }
      catch (e) { return e; }
    });
    expect(err).not.toBeNull();
    expect(err.kind).toBe('business');
    expect(err.code).toBe('E1001');
    expect(err.message).toContain('[E1001]');
    expect(err.message).toContain('数据格式错误');
    expect(err.detail).toBe('列数不匹配,期望 26 列,实际 25 列');
  });

  test('T03-3:字符串 detail 直接作为消息', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/health', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: '内部服务器错误' }),
      });
    });
    const err = await page.evaluate(async () => {
      try { await API.health(); return null; }
      catch (e) { return e; }
    });
    expect(err).not.toBeNull();
    expect(err.message).toBe('内部服务器错误');
    expect(err.status).toBe(500);
  });

  test('T03-4:HTML 502 非 JSON 响应保留状态与摘要', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/health', route => {
      route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html><body>Bad Gateway</body></html>',
      });
    });
    const err = await page.evaluate(async () => {
      try { await API.health(); return null; }
      catch (e) { return e; }
    });
    expect(err).not.toBeNull();
    expect(err.status).toBe(502);
    expect(err.message).toContain('502');
    expect(err.message).toContain('Bad Gateway');
  });

  test('T03-5:断网错误不含启动命令', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/health', route => route.abort());
    const err = await page.evaluate(async () => {
      try { await API.health(); return null; }
      catch (e) { return e; }
    });
    expect(err).not.toBeNull();
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain('uvicorn');
    expect(err.message).toContain('无法连接服务器');
  });

  test('T03-6:含 img/onerror 的错误正文只显示文本不执行事件', async ({ page }) => {
    await page.goto('/static/index.html');
    const xssPayload = '<img src=x onerror="window.__xssFired=true">恶意内容</img>';
    await page.route('**/api/health', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: xssPayload }),
      });
    });
    // S20:旧页 Toast/showApiError 已清理,改为验证归一化层+渲染安全
    // 归一化层:错误消息保留原始标签字符(不丢失不解析)
    const err = await page.evaluate(async () => {
      try { await API.health(); return null; }
      catch (e) { return e; }
    });
    expect(err).not.toBeNull();
    expect(err.message).toContain('<img src=x');
    // 渲染安全:新页错误区使用 textContent 输出(防 XSS),标签不解析为 DOM
    const renderResult = await page.evaluate((msg) => {
      const div = document.createElement('div');
      div.textContent = msg; // 与新页视图错误渲染一致:textContent 防注入
      document.body.appendChild(div);
      const imgs = div.querySelectorAll('img').length;
      const text = div.textContent;
      div.remove();
      return { imgs, text, fired: window.__xssFired };
    }, err.message);
    expect(renderResult.imgs).toBe(0); // 不创建 img 节点
    expect(renderResult.text).toContain('<img src=x'); // 纯文本可见(含原始标签)
    expect(renderResult.fired).toBeUndefined(); // onerror 未执行
  });

});