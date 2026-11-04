// 发布回归：真实后端上传成功后，默认入口应能继续分析且立即展示导入结果。
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function waitForUpload(page) {
  await expect.poll(() => page.evaluate(() => PO.getState().context.sessionId)).toBeTruthy();
  return page.evaluate(() => PO.getState().data.unitIds[0]);
}

test('T21-1 对话页加载演示数据后自动选择设备，可直接分析', async ({ page }) => {
  await page.goto('/static/index.html');
  await page.locator('#sidebar-demo-btn').click();
  const firstUnit = await waitForUpload(page);
  await expect(page.locator('#ctx-unit')).toHaveText(String(firstUnit), { timeout: 3000 });
  await page.locator('[data-action="start-analysis"]').first().click();
  await expect(page.locator('[data-card-type="advice"]')).toBeVisible();
  await expect(page.locator('#ctx-scenario')).toHaveText('已应用');
});

test('T21-2 对话页上传 CSV 后立即保留导入卡片，不被旧状态清空', async ({ page }) => {
  await page.goto('/static/index.html');
  const buffer = fs.readFileSync(path.resolve(__dirname, '../../PrognosOps_FD001_合成演示数据.csv'));
  await page.locator('#chat-file-input').setInputFiles({ name: 'import_test.csv', mimeType: 'text/csv', buffer });
  await waitForUpload(page);
  await expect(page.locator('[data-card-type="data-import"]')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('[data-card-type="data-import"]')).toHaveCount(1);
  await expect(page.locator('#chat-welcome')).toBeHidden();
  await expect(page.locator('#chat-messages')).toContainText('import_test.csv');
});

test('T21-3 数据页导入与对话页保持相同的默认设备选择', async ({ page }) => {
  await page.goto('/static/index.html#data');
  await page.locator('#dv-demo-btn').click();
  const firstUnit = await waitForUpload(page);
  await expect(page.locator('#ctx-unit')).toHaveText(String(firstUnit), { timeout: 3000 });
  await page.locator('#dv-analyze-btn').click();
  await expect(page.locator('#page-chat')).toBeVisible();
  await page.locator('[data-action="start-analysis"]').first().click();
  await expect(page.locator('[data-card-type="advice"]')).toBeVisible();
});
