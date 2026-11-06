// Playwright 全局登录初始化:使用真实认证接口生成业务测试所需的 localStorage 状态。
const fs = require('fs');
const path = require('path');
const { request } = require('@playwright/test');

const ORIGIN = 'http://127.0.0.1:8765';
const AUTH_STATE_PATH = path.join(__dirname, 'test-results', '.auth-state.json');

module.exports = async function globalSetup() {
  const api = await request.newContext({ baseURL: ORIGIN });
  try {
    const response = await api.post('/api/auth/login', {
      data: { username: 'admin', password: 'admin123' },
    });
    if (!response.ok()) {
      throw new Error('测试登录失败:HTTP ' + response.status());
    }

    const data = await response.json();
    if (!data.token) throw new Error('测试登录失败:响应中缺少令牌');

    fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({
      cookies: [],
      origins: [{
        origin: ORIGIN,
        localStorage: [
          { name: 'po_auth_token', value: data.token },
          {
            name: 'po_auth_user',
            value: JSON.stringify({
              username: data.username,
              display_name: data.display_name,
              role: data.role,
            }),
          },
        ],
      }],
    }, null, 2), 'utf8');
  } finally {
    await api.dispose();
  }
};
