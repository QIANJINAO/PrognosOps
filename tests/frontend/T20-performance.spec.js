// S20 验收:固定资源、防重复提交移交与首屏性能
// 覆盖:
//   T20-1 防重复提交(移交 test_boundary test_18):分析链并发只发一次请求
//   T20-2 首屏性能:冷缓存+移动模拟+4x CPU+Fast4G 跑 3 次,记录 LCP 中位数与 CLS
//   T20-3 阻断外部 CDN:拦截非同源请求,页面/图表仍可用(S20 本地化验证)

const { test, expect } = require('@playwright/test');
const apiFx = require('./fixtures/api-fixture');

const PAGE = '/static/index.html';

test.describe('S20:固定资源、防重复提交移交与首屏性能', () => {

  // ───────── T20-1:防重复提交(移交 test_boundary test_18) ─────────
  test('T20-1:分析链并发只发一次请求(链式锁)', async ({ page }) => {
    let predictCount = 0;
    await page.route('**/api/rul/predict', async route => {
      predictCount++;
      await new Promise(r => setTimeout(r, 500)); // 延迟让并发可观测
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeRULResponse('sess-1', 1, 40)) });
    });
    await page.route('**/api/decision/run', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(apiFx.makeDecisionResponse()) });
    });
    await page.goto(PAGE);
    // 并发 runCurrent 两次:链式锁(activeRunId)应拒绝第二次
    const results = await page.evaluate(async () => {
      PO.setContext({ sessionId: 'sess-1', unitId: 1 });
      const input = { sessionId: 'sess-1', unitId: 1, cycle: 40, k_nn: 50,
        params: { cm: '1', cd: '5', cp: '50', cc: '200', alpha: '0.01' } };
      const p1 = PO.analysis.runCurrent(input);
      const p2 = PO.analysis.runCurrent(input); // 链式锁应拒绝
      return Promise.all([p1, p2]);
    });
    expect(predictCount).toBe(1); // 只发一次 predict 请求
    expect(results[1]).toBeNull(); // 第二次被锁拒绝
    expect(results[0]).not.toBeNull(); // 第一次正常完成
    expect(results[0].decision).toBeTruthy(); // 预测→决策链走通
  });

  // ───────── T20-2:首屏性能(冷缓存+移动模拟+4x CPU+Fast4G,3 次取中位数) ─────────
  // 施工单:记录 LCP 中位数与 CLS,目标 LCP≤2.5s / CLS≤0.1;未达标不得写成通过
  test('T20-2:首屏性能 3 次(LCP 中位数≤2.5s,CLS≤0.1)', async ({ browser }) => {
    const lcpValues = [];
    const clsValues = [];
    for (let i = 0; i < 3; i++) {
      // 每次新建 context:冷缓存(无磁盘/内存缓存复用)
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, // 移动模拟
      });
      const page = await context.newPage();
      // 在页面脚本前注入性能观察者(捕获完整 LCP/CLS)
      await context.addInitScript(() => {
        window.__perfLcp = 0;
        window.__perfCls = 0;
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
              if (e.startTime > window.__perfLcp) window.__perfLcp = e.startTime;
            }
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
              if (!e.hadRecentInput) window.__perfCls += e.value;
            }
          }).observe({ type: 'layout-shift', buffered: true });
        } catch (_) { /* 浏览器不支持时跳过 */ }
      });
      // CDP:4 倍 CPU 节流 + Fast4G 网络节流(latency 150ms,下行 1.8Mbps,上行 750Kbps)
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 150,
        downloadThroughput: Math.floor(1.8 * 1024 * 1024 / 8),
        uploadThroughput: Math.floor(750 * 1024 / 8),
      });
      await page.goto(PAGE, { waitUntil: 'networkidle' });
      // 等待首屏渲染稳定(健康检查等异步请求完成后 LCP 不再变化)
      await page.waitForTimeout(800);
      const { lcp, cls } = await page.evaluate(() => ({
        lcp: window.__perfLcp, cls: window.__perfCls,
      }));
      lcpValues.push(lcp);
      clsValues.push(cls);
      await context.close();
    }
    // 取中位数(3 个值排序后取第 2 个)
    lcpValues.sort((a, b) => a - b);
    clsValues.sort((a, b) => a - b);
    const lcpMedian = lcpValues[1];
    const clsMedian = clsValues[1];
    console.log(`[T20-2] LCP 3 次: ${lcpValues.map(v => v.toFixed(0) + 'ms').join(', ')}, 中位数=${lcpMedian.toFixed(0)}ms`);
    console.log(`[T20-2] CLS 3 次: ${clsValues.map(v => v.toFixed(4)).join(', ')}, 中位数=${clsMedian.toFixed(4)}`);
    // 施工单目标:LCP ≤2.5s,CLS ≤0.1
    expect(lcpMedian).toBeLessThanOrEqual(2500);
    expect(clsMedian).toBeLessThanOrEqual(0.1);
  });

  // ───────── T20-3:阻断外部 CDN 后页面仍可用 ─────────
  test('T20-3:阻断外部 CDN,页面与图表仍可用', async ({ page }) => {
    // 拦截所有非同源 http(s) 请求(模拟阻断外部 CDN)
    const blocked = [];
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith('http') && !url.includes('127.0.0.1') && !url.includes('localhost')) {
        blocked.push(url);
        await route.abort();
      } else {
        await route.continue();
      }
    });
    // 页面正常加载
    await page.goto(PAGE);
    await expect(page.locator('#page-chat')).toBeVisible();
    await expect(page.locator('.po-brand')).toContainText('PrognosOps');
    // S20 本地化后所有资源同源:无外部请求被发起
    expect(blocked).toEqual([]);
    // Chart.js 本地可用(阻断 CDN 后图表库仍加载)
    const chartLoaded = await page.evaluate(() =>
      typeof window.Chart === 'function' || typeof window.Chart === 'object');
    expect(chartLoaded).toBe(true);
  });

});