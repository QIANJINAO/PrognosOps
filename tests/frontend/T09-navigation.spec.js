// S09 验收:三页导航与默认入口(信息架构重构后)
// 覆盖:直接访问/刷新/前进后退/未知 hash、无重叠视图与重复监听器、
//       1440×900 侧栏+主体/390×844 移动端、空态主操作首屏可触达、默认入口可用

const { test, expect } = require('@playwright/test');

const NEXT_PAGE = '/static/index.html';

test.describe('S09:三页导航与新版入口', () => {

  test('T09-1:直接访问/刷新/前进后退/未知 hash', async ({ page }) => {
    // 直接访问 chat
    await page.goto(NEXT_PAGE + '#/chat');
    await expect(page.locator('#page-chat')).toBeVisible();
    await expect(page.locator('#page-data')).toBeHidden();
    expect(await page.evaluate(() => PO.router.current())).toBe('chat');

    // navigate 到 data
    await page.evaluate(() => PO.router.navigate('data'));
    await expect(page.locator('#page-data')).toBeVisible();
    await expect(page.locator('#page-chat')).toBeHidden();
    expect(await page.evaluate(() => location.hash)).toBe('#/data');

    // navigate 到 validation
    await page.evaluate(() => PO.router.navigate('validation'));
    await expect(page.locator('#page-validation')).toBeVisible();

    // 浏览器后退 → 回 data
    await page.goBack();
    await expect(page.locator('#page-data')).toBeVisible();
    expect(await page.evaluate(() => PO.router.current())).toBe('data');

    // 浏览器前进 → 回 validation
    await page.goForward();
    await expect(page.locator('#page-validation')).toBeVisible();
    expect(await page.evaluate(() => PO.router.current())).toBe('validation');

    // 未知 hash → 回对话页(默认路由)
    await page.goto(NEXT_PAGE + '#/unknown-route');
    await expect(page.locator('#page-chat')).toBeVisible();
    expect(await page.evaluate(() => PO.router.current())).toBe('chat');

    // 刷新保持路由
    await page.evaluate(() => PO.router.navigate('data'));
    await page.reload();
    await expect(page.locator('#page-data')).toBeVisible();
    expect(await page.evaluate(() => PO.router.current())).toBe('data');
  });

  test('T09-2:无重叠视图与重复监听器', async ({ page }) => {
    await page.goto(NEXT_PAGE + '#/chat');
    // 注册计数回调
    await page.evaluate(() => {
      window.__routeCalls = 0;
      PO.router.onRouteChange(() => { window.__routeCalls++; });
    });
    // 切到 data:回调 +1
    await page.evaluate(() => PO.router.navigate('data'));
    expect(await page.evaluate(() => window.__routeCalls)).toBe(1);
    // 只有一个 page 可见(无重叠视图)
    const visiblePages = await page.locator('.po-page:not([hidden])').count();
    expect(visiblePages).toBe(1);
    // 侧栏导航激活态唯一
    const activeNavs = await page.locator('.po-sidebar-link.is-active').count();
    expect(activeNavs).toBe(1);

    // 重复 init 不重复注册(无重复监听器)
    await page.evaluate(() => PO.bootstrap.init());
    await page.evaluate(() => PO.bootstrap.init());
    await page.evaluate(() => { window.__routeCalls = 0; });
    await page.evaluate(() => PO.router.navigate('validation'));
    expect(await page.evaluate(() => window.__routeCalls)).toBe(1); // 仍然只触发一次

    // 同 hash navigate 不重复触发
    await page.evaluate(() => { window.__routeCalls = 0; });
    await page.evaluate(() => PO.router.navigate('validation'));
    expect(await page.evaluate(() => window.__routeCalls)).toBe(0);
  });

  test('T09-3:1440×900 侧栏+主体、390×844 移动端', async ({ page }) => {
    await page.goto(NEXT_PAGE + '#/chat');
    // 1440×900(默认视口):侧栏在左,主体在右,不重叠
    const sidebarBox = await page.locator('.po-sidebar').boundingBox();
    const mainBox = await page.locator('.po-main').boundingBox();
    expect(mainBox.x).toBeGreaterThan(sidebarBox.x); // 主体在侧栏右侧
    expect(sidebarBox.x + sidebarBox.width).toBeLessThanOrEqual(mainBox.x); // 不重叠
    // 侧栏宽度约 232px
    expect(sidebarBox.width).toBeGreaterThanOrEqual(220);
    expect(sidebarBox.width).toBeLessThanOrEqual(245);

    // 390×844:移动端侧栏可折叠,主体占满
    await page.setViewportSize({ width: 390, height: 844 });
    // 侧栏开关可见
    await expect(page.locator('#po-sidebar-toggle')).toBeVisible();
  });

  test('T09-4:空态主操作首屏可触达,默认入口可用', async ({ page }) => {
    // 新页空态:侧栏导入与演示入口首屏可见可触达
    await page.goto(NEXT_PAGE + '#/chat');
    await expect(page.locator('#sidebar-import-btn')).toBeVisible();
    await expect(page.locator('#sidebar-demo-btn')).toBeVisible();
    // 空态按钮在首屏内(不超出视口)
    const btnBox = await page.locator('#sidebar-import-btn').boundingBox();
    expect(btnBox.y).toBeGreaterThanOrEqual(0);
    expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(900);
    // 对话页欢迎屏可见(空态)
    await expect(page.locator('.po-chat-welcome')).toBeVisible();

    // 侧栏上下文存在且展示
    await expect(page.locator('#ctx-dataset')).toContainText('未导入');
    await expect(page.locator('#ctx-unit')).toContainText('—');
    await expect(page.locator('#ctx-scenario')).toContainText('未应用');

    // 默认入口已切换为对话页,直接访问即对话页
    await page.goto('/static/index.html');
    await expect(page).toHaveTitle(/PrognosOps/);
    await expect(page.locator('#page-chat')).toBeVisible();
  });

});