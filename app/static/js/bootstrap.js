/* ═══════════════════════════════════════════════
   PrognosOps 引导(bootstrap.js)——会话主体版
   职责:侧栏导航同步、侧栏上下文渲染、侧栏折叠、
        页面切换、详情抽屉挂载、健康检查、演示模式
   挂载:window.PO.bootstrap
   设计约束:
   - 切页不重置状态(路由切换只切视图,不动 PO.store);
   - initialized 标志保证 init 只执行一次(无重复监听器);
   - 对话页为默认主体,数据/回测为侧栏辅助页。
   ═══════════════════════════════════════════════ */
window.PO.bootstrap = (() => {
  'use strict';

  let initialized = false;

  // 手动点击演示步骤标记(模块级:setupDemoMode 写入,updateDemoStep 读取;
  // 防止 hashchange 异步回调把③④手动高亮回退到②)
  let pendingManualStep = null;

  // ───────── 工具 ─────────

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ───────── 侧栏上下文渲染(订阅 PO.store,切页不重置) ─────────

  function renderContextBar(s) {
    const ctx = s.context;
    setText('ctx-dataset', ctx.fileName || ctx.sessionId || '未导入');
    setText('ctx-unit', ctx.unitId != null ? String(ctx.unitId) : '—');
    setText('ctx-scenario', s.appliedScenario ? '已应用' : '未应用');
  }

  // ───────── 服务状态 ─────────

  async function checkHealth() {
    const dot = document.getElementById('po-health-dot');
    const text = document.getElementById('po-health-text');
    try {
      const h = await API.health();
      if (dot) dot.className = 'po-health-dot ok';
      if (text) text.textContent = '服务正常 v' + h.version;
    } catch {
      if (dot) dot.className = 'po-health-dot err';
      if (text) text.textContent = '服务不可达';
    }
  }

  // ───────── 页面切换(只切视图,不动状态) ─────────

  // 路由首次进入时 mount 对应视图(切页不 unmount,保留图表/焦点/订阅)
  const viewMounted = { chat: false, data: false, validation: false };

  function mountViewForRoute(route) {
    if (viewMounted[route]) return;
    viewMounted[route] = true;
    const page = document.querySelector('.po-page[data-route="' + route + '"]');
    if (!page) return;
    if (route === 'chat') PO.chatView.mount(page);
    else if (route === 'data') PO.dataView.mount(page);
    else if (route === 'validation') PO.backtestView.mount(page);
  }

  function switchPage(route) {
    document.querySelectorAll('.po-page').forEach(p => {
      p.hidden = p.dataset.route !== route;
    });
    // 侧栏导航链接 active 同步
    document.querySelectorAll('.po-sidebar-link').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.route === route);
    });
    mountViewForRoute(route);
    // 目标页从隐藏切回可见后,强制图表重算尺寸(隐藏页 canvas 可能停留在 0 尺寸)
    if (window.Charts && Charts.resizeAll) Charts.resizeAll();
    // 移动端:导航后收起侧栏覆盖层,露出主体内容
    if (window.innerWidth <= 640) collapseSidebar();
  }

  // ───────── 侧栏折叠 ─────────

  function isSidebarCollapsed() {
    const shell = document.getElementById('po-app-shell');
    return !!(shell && shell.classList.contains('po-sidebar-collapsed'));
  }

  function collapseSidebar() {
    const shell = document.getElementById('po-app-shell');
    if (shell) shell.classList.add('po-sidebar-collapsed');
  }

  function setupSidebarToggle() {
    const toggle = document.getElementById('po-sidebar-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      const shell = document.getElementById('po-app-shell');
      if (shell) shell.classList.toggle('po-sidebar-collapsed');
    });
  }

  // ───────── 初始化(只执行一次) ─────────

  function init() {
    if (initialized) return;
    initialized = true;

    // 统一注册订阅:状态变化 → 侧栏上下文更新(切页不重置,订阅常驻)
    PO.subscribe(renderContextBar);
    renderContextBar(PO.getState());

    // 移动端默认折叠侧栏(覆盖式抽屉,避免遮挡主内容)
    if (window.innerWidth < 640) collapseSidebar();

    // 视口跨越 640 断点时自动折叠侧栏(宽→窄,避免覆盖遮挡;窄→宽不自动展开,尊重用户选择)
    let lastNarrow = window.innerWidth < 640;
    window.addEventListener('resize', () => {
      const isNarrow = window.innerWidth < 640;
      if (isNarrow && !lastNarrow) collapseSidebar();
      lastNarrow = isNarrow;
    });

    // 侧栏导航点击 → 路由切换
    document.querySelectorAll('.po-sidebar-link').forEach(btn => {
      btn.addEventListener('click', () => PO.router.navigate(btn.dataset.route));
    });

    // 路由变化 → 切换页面
    PO.router.onRouteChange(switchPage);

    // 初始路由:未知 hash 回对话页(replace 不留历史)
    const route = PO.router.current();
    if (window.location.hash !== '#/' + route) {
      window.location.replace('#/' + route);
    }
    switchPage(route);

    // 侧栏折叠开关
    setupSidebarToggle();

    // 侧栏数据入口:导入 CSV → 切到对话页并打开文件选择器
    const importBtn = document.getElementById('sidebar-import-btn');
    if (importBtn) importBtn.addEventListener('click', () => {
      if (PO.router.current() !== 'chat') {
        PO.router.navigate('chat');
        // hashchange 异步触发,待 chatView 挂载后再打开文件选择器
        setTimeout(() => { if (PO.chatView.pickFile) PO.chatView.pickFile(); }, 180);
      } else if (PO.chatView.pickFile) {
        PO.chatView.pickFile();
      }
    });

    // 侧栏数据入口:加载演示数据 → 切到对话页并触发(消息入流,挂载后自动渲染)
    const demoBtn = document.getElementById('sidebar-demo-btn');
    if (demoBtn) demoBtn.addEventListener('click', () => {
      PO.router.navigate('chat');
      PO.chatView.uploadDemo();
    });

    // 侧栏底部:运行记录
    const runsBtn = document.getElementById('sidebar-runs-btn');
    if (runsBtn) runsBtn.addEventListener('click', () => PO.runHistory.open());

    // 运行记录抽屉挂载(fixed 定位,不依赖页面容器)
    const rhRoot = document.getElementById('run-history-root');
    if (rhRoot) PO.runHistory.mount(rhRoot);

    // 详情抽屉挂载(查看分析图表/方案对比/质量详情,按需打开)
    const ddRoot = document.getElementById('detail-drawer-root');
    if (ddRoot && PO.detailDrawer) PO.detailDrawer.mount(ddRoot);

    // 大屏演示模式:切换按钮 + 底部 5 步导航
    setupDemoMode();

    // 健康检查(立即 + 每 30 秒)
    checkHealth();
    setInterval(checkHealth, 30000);
  }

  // ───────── 大屏演示模式(只改视觉布局,不改数据) ─────────

  function setupDemoMode() {
    const toggle = document.getElementById('po-demo-toggle');
    const nav = document.getElementById('po-demo-nav');
    if (!toggle || !nav) return;

    const steps = Array.from(nav.querySelectorAll('.po-demo-step'));

    // 切换演示模式:body 加/去 po-demo-mode 类,显示/隐藏底部导航
    toggle.addEventListener('click', () => {
      const active = document.body.classList.toggle('po-demo-mode');
      toggle.classList.toggle('active', active);
      toggle.textContent = active ? '退出演示' : '演示模式';
      nav.hidden = !active;
      if (active) updateDemoStep(PO.router.current());
    });

    // 演示步骤点击 → 导航到对应页面并高亮当前步;③④滚动定位到对应结果卡片
    steps.forEach(btn => {
      btn.addEventListener('click', () => {
        pendingManualStep = btn;
        PO.router.navigate(btn.dataset.route);
        steps.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        scrollToDemoPanel(btn);
        setTimeout(() => { pendingManualStep = null; }, 200);
      });
    });

    // 路由变化时更新演示步骤高亮(data→①, chat→②, validation→⑤)
    PO.router.onRouteChange(route => {
      if (!document.body.classList.contains('po-demo-mode')) return;
      updateDemoStep(route);
    });
  }

  /**
   * 演示步骤③④:滚动定位到对话页对应类型的结果卡片(取最后一张)
   * concl → 维修建议卡片(advice);candidates → 情景比较卡片(compare)
   */
  function scrollToDemoPanel(btn) {
    const area = btn.dataset.scroll;
    if (!area) return;
    const cardType = area === 'concl' ? 'advice' : (area === 'candidates' ? 'compare' : null);
    if (!cardType) return;
    setTimeout(() => {
      const page = document.querySelector('.po-page[data-route="chat"]');
      if (!page) return;
      const cards = page.querySelectorAll('.po-chat-card[data-card-type="' + cardType + '"]');
      const target = cards.length ? cards[cards.length - 1] : null;
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 160);
  }

  /** 根据当前路由高亮对应演示步骤 */
  function updateDemoStep(route) {
    const nav = document.getElementById('po-demo-nav');
    if (!nav) return;
    const steps = Array.from(nav.querySelectorAll('.po-demo-step'));
    steps.forEach(b => b.classList.remove('active'));
    // 手动点击的步骤优先(同路由时保留③④选择,避免 hashchange 异步回调回退到②)
    if (pendingManualStep && pendingManualStep.dataset.route === route) {
      pendingManualStep.classList.add('active');
      return;
    }
    // 首个匹配当前路由的步骤高亮(对话页默认高亮②分析设备)
    const match = steps.find(b => b.dataset.route === route);
    if (match) match.classList.add('active');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => PO.bootstrap.init());