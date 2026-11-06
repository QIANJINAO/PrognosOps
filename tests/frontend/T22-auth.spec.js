// T22:登录页、错误提示、工作台用户信息与登出闭环。
const { test, expect } = require('@playwright/test');


test('T22-1 未登录跳转登录页，错误密码可见，正确登录后可登出', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('#po-login-form')).toBeVisible();
  await expect(page.locator('#po-health-text')).toHaveText('服务正常');

  await page.fill('#po-login-username', 'admin');
  await page.fill('#po-login-password', 'wrong');
  await page.click('#po-login-submit');
  await expect(page.locator('#po-login-error')).toHaveText('用户名或密码错误');

  await page.fill('#po-login-password', 'admin123');
  await page.click('#po-login-submit');
  await expect(page).toHaveURL(/\/#\/chat$/);
  await expect(page.locator('#po-user-name')).toHaveText('管理员');
  await expect(page.locator('#chat-input')).toBeVisible();

  await page.click('#po-logout-btn');
  await expect(page).toHaveURL(/\/login$/);
  const token = await page.evaluate(() => localStorage.getItem('po_auth_token'));
  expect(token).toBeNull();

  await context.close();
});
