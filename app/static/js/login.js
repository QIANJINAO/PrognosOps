/* ═══════════════════════════════════════════════
   PrognosOps 登录页交互脚本(login.js)
   职责:
   1. 页面加载时检查已有登录态(令牌有效则直接跳转工作台)
   2. 健康检查(与主应用一致的状态点)
   3. 表单提交 → 调用 /api/auth/login → 存储令牌 → 跳转
   ═══════════════════════════════════════════════ */

(function () {
  'use strict';

  // localStorage 键名(与主页面共享,保持登录态一致)
  var TOKEN_KEY = 'po_auth_token';
  var USER_KEY = 'po_auth_user';

  // DOM 引用
  var form = document.getElementById('po-login-form');
  var usernameInput = document.getElementById('po-login-username');
  var passwordInput = document.getElementById('po-login-password');
  var submitBtn = document.getElementById('po-login-submit');
  var errorBox = document.getElementById('po-login-error');
  var healthDot = document.getElementById('po-health-dot');
  var healthText = document.getElementById('po-health-text');

  // ───────── 工具函数 ─────────

  /** 显示错误提示 */
  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }

  /** 隐藏错误提示 */
  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.hidden = true;
  }

  /** 设置按钮加载状态 */
  function setLoading(loading) {
    if (!submitBtn) return;
    if (loading) {
      submitBtn.classList.add('is-loading');
      submitBtn.disabled = true;
      submitBtn.textContent = '登录中…';
    } else {
      submitBtn.classList.remove('is-loading');
      submitBtn.disabled = false;
      submitBtn.textContent = '登 录';
    }
  }

  /** 跳转到工作台 */
  function redirectToApp() {
    window.location.href = '/';
  }

  // ───────── 1. 已有登录态检查 ─────────

  async function checkExistingSession() {
    var token = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return; // localStorage 不可用(隐私模式等),留在登录页
    }
    if (!token) return;

    try {
      var resp = await fetch('/api/auth/verify?token=' + encodeURIComponent(token));
      var data = await resp.json();
      if (data && data.valid) {
        // 令牌仍有效,直接进入工作台
        redirectToApp();
      } else {
        // 令牌已失效,清理本地存储
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
    } catch (e) {
      // 网络异常时不跳转,留在登录页让用户重新登录
    }
  }

  // ───────── 2. 健康检查 ─────────

  async function checkHealth() {
    if (!healthDot || !healthText) return;
    try {
      var resp = await fetch('/api/health');
      var data = await resp.json();
      if (data && data.status === 'ok') {
        healthDot.className = 'po-health-dot ok';
        healthText.textContent = '服务正常';
      } else {
        healthDot.className = 'po-health-dot err';
        healthText.textContent = '服务异常';
      }
    } catch (e) {
      healthDot.className = 'po-health-dot err';
      healthText.textContent = '无法连接';
    }
  }

  // ───────── 3. 登录提交 ─────────

  async function handleLogin(event) {
    event.preventDefault();
    clearError();

    var username = (usernameInput.value || '').trim();
    var password = passwordInput.value || '';

    // 前端基础校验
    if (!username) {
      showError('请输入账号');
      usernameInput.focus();
      return;
    }
    if (!password) {
      showError('请输入密码');
      passwordInput.focus();
      return;
    }

    setLoading(true);

    try {
      var resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password }),
      });

      var data = await resp.json();

      if (resp.ok && data && data.token) {
        // 登录成功:存储令牌与用户信息
        try {
          localStorage.setItem(TOKEN_KEY, data.token);
          localStorage.setItem(USER_KEY, JSON.stringify({
            username: data.username,
            display_name: data.display_name,
            role: data.role,
          }));
        } catch (e) {
          // localStorage 不可用:仍允许跳转(本次会话内可用内存态)
        }
        redirectToApp();
      } else {
        // 登录失败:展示后端错误信息
        var msg = '登录失败,请重试';
        if (data && data.detail && data.detail.message) {
          msg = data.detail.message;
        } else if (data && data.message) {
          msg = data.message;
        }
        showError(msg);
        setLoading(false);
        passwordInput.value = '';
        passwordInput.focus();
      }
    } catch (e) {
      showError('网络异常,无法连接服务器,请稍后重试');
      setLoading(false);
    }
  }

  // ───────── 初始化 ─────────

  document.addEventListener('DOMContentLoaded', function () {
    // 绑定表单提交
    if (form) form.addEventListener('submit', handleLogin);

    // 输入时清除错误提示
    if (usernameInput) usernameInput.addEventListener('input', clearError);
    if (passwordInput) passwordInput.addEventListener('input', clearError);

    // 回车键在账号框时聚焦密码框
    if (usernameInput) {
      usernameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          passwordInput.focus();
        }
      });
    }

    // 健康检查
    checkHealth();

    // 已有登录态检查(异步,不阻塞页面渲染)
    checkExistingSession();

    // 默认聚焦账号输入框
    if (usernameInput) usernameInput.focus();
  });
})();