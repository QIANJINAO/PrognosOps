/* ═══════════════════════════════════════════════
   T99:演示全流程截图(桌面+手机)——交付用,非常规回归
   流程:演示数据 → 分析 → 图表抽屉 → 回测
   输出:D:\codex download\desktop-*.png / mobile-*.png
   ═══════════════════════════════════════════════ */
const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const NEXT_URL = 'http://127.0.0.1:8765/static/index.html';
const SHOT_DIR = 'D:\\codex download';

/** 演示数据 → 分析 → 图表 → 回测 全流程,返回页面 */
async function runFullFlow(page, prefix) {
  await page.goto(NEXT_URL);

  // 1. 加载演示数据(快捷按钮,桌面/手机均可见)
  await page.click('.po-chat-quick-btn[data-action="upload-demo"]');
  // 等待上传完成:分析按钮出现(sessionId 已写入)
  await page.waitForSelector('.po-chat-quick-btn[data-action="start-analysis"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOT_DIR, prefix + '01-导入演示数据.png') });

  // 2. 运行分析(预测→决策,方案自动应用)
  await page.click('.po-chat-quick-btn[data-action="start-analysis"]');
  await page.waitForSelector('[data-card-type="advice"]', { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOT_DIR, prefix + '02-分析完成-维修建议.png') });

  // 3. 打开分析图表详情抽屉(传感器趋势/RUL 概率/成本曲线/失效寿命)
  await page.click('[data-action="open-detail"][data-detail-type="evidence"]');
  await page.waitForTimeout(3000); // 等图表渲染稳定
  await page.screenshot({ path: path.join(SHOT_DIR, prefix + '03-分析图表-详情抽屉.png') });

  // 关闭抽屉
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  // 4. 回测页:先截空态,再运行回测截结果(含校准图/敏感性图)
  await page.evaluate(() => PO.router.navigate('validation'));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOT_DIR, prefix + '04-回测页-空态.png') });

  await page.click('#bt-run-btn');
  await page.waitForFunction(() => {
    const el = document.getElementById('bt-status');
    return el && el.textContent.includes('回测完成');
  }, { timeout: 120000 });
  await page.waitForTimeout(3000); // 等校准图/敏感性图渲染
  await page.screenshot({ path: path.join(SHOT_DIR, prefix + '05-回测完成-校准与敏感性图.png') });
}

test('生成演示全流程截图(桌面+手机)', async ({ browser }) => {
  test.setTimeout(300000); // 5 分钟(真实后端计算耗时)
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // ═══ 桌面 1440×900 ═══
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dpage = await desktop.newPage();
  await runFullFlow(dpage, 'desktop-');
  await desktop.close();

  // ═══ 手机 390×844 ═══
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mpage = await mobile.newPage();
  await runFullFlow(mpage, 'mobile-');
  await mobile.close();
});