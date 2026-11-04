/* ═══════════════════════════════════════════════
   PrognosOps 路由器(router.js)
   职责:hash 路由切换,未知 hash 回工作台
   挂载:window.PO.router
   路由表:#/chat 对话(默认) | #/data 数据与质量 | #/validation 回测验证
   ═══════════════════════════════════════════════ */
window.PO.router = (() => {
  'use strict';

  const ROUTES = ['chat', 'data', 'validation'];
  const DEFAULT_ROUTE = 'chat';
  const listeners = new Set();

  /** 解析 hash → 合法路由;未知 hash 回默认路由(工作台) */
  function parse(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES.indexOf(raw) !== -1 ? raw : DEFAULT_ROUTE;
  }

  /** 当前路由 */
  function current() {
    return parse(window.location.hash);
  }

  /** 通知所有路由变化回调 */
  function notify() {
    const route = current();
    listeners.forEach(fn => {
      try { fn(route); } catch (e) { console.error('[PO.router] 路由回调异常:', e); }
    });
  }

  /**
   * 导航到指定路由;hash 变化时触发 hashchange → 回调
   * 同 hash 不重复触发(无冗余通知)
   * @param {string} route - 目标路由(chat/data/validation)
   */
  function navigate(route) {
    if (ROUTES.indexOf(route) === -1) route = DEFAULT_ROUTE;
    const target = '#/' + route;
    if (window.location.hash === target) return; // 同 hash 不触发
    window.location.hash = target; // 触发 hashchange → notify
  }

  /**
   * 注册路由变化回调
   * @param {Function} fn - 回调 (route) => void
   * @returns {Function} 取消注册
   */
  function onRouteChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // 监听浏览器 hashchange(前进/后退/手动改 hash 均触发)
  window.addEventListener('hashchange', notify);

  return { navigate, current, onRouteChange, ROUTES };
})();