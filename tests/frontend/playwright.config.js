// PrognosOps 前端行为回归测试配置(Playwright Chromium)
// 施工单 S01:webServer 指向 uvicorn 127.0.0.1:8765,双视口截图,失败留 trace
const { defineConfig } = require('@playwright/test');
const path = require('path');

const authStatePath = path.join(__dirname, 'test-results', '.auth-state.json');

module.exports = defineConfig({
  // 启动测试前通过真实登录接口获取演示令牌，避免认证守卫把业务测试重定向到登录页。
  globalSetup: require.resolve('./global-setup.js'),
  // 测试文件目录(当前 tests/frontend/)
  testDir: '.',
  // 测试文件匹配模式
  testMatch: '**/*.spec.js',
  // 单测试超时(回测等操作较慢,给足余量)
  timeout: 60_000,
  // expect 断言超时
  expect: { timeout: 10_000 },
  // 并发工作进程数(行为测试涉及后端会话状态,串行更稳定)
  workers: 1,
  // 重试次数(失败留 trace 依赖此项)
  retries: 1,
  // 测试报告
  reporter: [['list'], ['html', { open: 'never' }]],
  // 输出目录(trace/截图/视频存放处)
  outputDir: path.join(__dirname, 'test-results'),

  use: {
    // 后端基础地址(webServer 启动的 uvicorn 实例)
    baseURL: 'http://127.0.0.1:8765',
    // 桌面视口(施工单要求 1440×900)
    viewport: { width: 1440, height: 900 },
    // 失败时截图
    screenshot: 'only-on-failure',
    // 首次重试时记录 trace(施工单:失败留 trace)
    trace: 'on-first-retry',
    // 导航超时
    navigationTimeout: 15_000,
    // 忽略 HTTPS 证书错误(本地开发无需)
    ignoreHTTPSErrors: true,
    // 全部业务测试复用由 globalSetup 生成的 localStorage 登录态。
    storageState: authStatePath,
  },

  // 后端服务:uvicorn 启动 FastAPI 应用
  // 使用本机 anaconda Python 解释器(含 fastapi 依赖)
  // cwd 指向项目根目录,确保 app.main 可导入、.env 可加载
  webServer: {
    command: 'D:\\PYthon_install\\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8765',
    cwd: path.resolve(__dirname, '..', '..'),
    url: 'http://127.0.0.1:8765/api/health',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
