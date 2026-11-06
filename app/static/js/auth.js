/* ═══════════════════════════════════════════════
   PrognosOps 主页面认证脚本(auth.js)
   职责:
   1. 异步校验令牌有效性(无效则跳转登录页)
   2. 展示登录用户信息(用户名 + 登出按钮)
   3. 登出:撤销令牌 → 清理本地存储 → 跳转登录页
   ═══════════════════════════════════════════════ */

(function () {
  'use strict';

  var TOKEN_KEY = 'po_auth_token';
  var USER_KEY = 'po_auth_user';

  var userArea = document.getElementById('po-user-area');
  var userName = document.getElementById('po-user-name');
  var logoutBtn = document.getElementById('po-logout-btn');

  /** 跳转登录页 */
  function redirectToLogin() {
    window.location.href = '/login';
  }

  /** 清理本地登录态 */
  function clearLocalAuth() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch (e) { /* 忽略 localStorage 不可用 */ }
  }

  /** 展示用户信息区 */
  function showUserArea(user) {
    if (!userArea || !userName) return;
    var displayName = (user && user.display_name) || (user && user.username) || '用户';
    userName.textContent = displayName;
    userArea.hidden = false;
  }

  // ───────── 令牌异步校验 ─────────

  async function verifyToken() {
    var token = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      redirectToLogin();
      return;
    }
    if (!token) {
      redirectToLogin();
      return;
    }

    try {
      var resp = await fetch('/api/auth/verify?token=' + encodeURIComponent(token));
      var data = await resp.json();
      if (data && data.valid) {
        // 令牌有效:展示用户信息(优先用后端返回,兜底本地缓存)
        showUserArea({
          display_name: data.display_name,
          username: data.username,
        });
      } else {
        // 令牌失效:清理并跳转
        clearLocalAuth();
        redirectToLogin();
      }
    } catch (e) {
      // 网络异常:降级使用本地缓存的用户信息,不强制登出
      var cached = null;
      try {
        cached = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      } catch (e2) { /* 忽略解析失败 */ }
      if (cached) {
        showUserArea(cached);
      }
    }
  }

  // ───────── 登出 ─────────

  async function handleLogout() {
    var token = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch (e) { /* 忽略 */ }

    // 通知后端撤销令牌(不阻塞跳转)
    if (token) {
      try {
        fetch('/api/auth/logout?token=' + encodeURIComponent(token), { method: 'POST' });
      } catch (e) { /* 忽略网络异常 */ }
    }

    clearLocalAuth();
    redirectToLogin();
  }

  // ───────── 初始化 ─────────

  document.addEventListener('DOMContentLoaded', function () {
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    verifyToken();
  });
})();