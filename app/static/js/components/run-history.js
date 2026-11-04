/* ═══════════════════════════════════════════════
   PrognosOps 运行记录抽屉(components/run-history.js)
   职责:当前会话运行记录,只读摘要列表;
         抽屉交互(关闭按钮/Esc/焦点圈定/关闭归还焦点)
   挂载:window.PO.runHistory
   依赖:state.js(PO)
   设计约束(施工单 S17):
   - 标题固定"当前会话运行记录";
   - 摘要含类型/时间/状态/数据/设备/时点/参数版本;
   - 已释放明细标"明细已释放",不可下载或应用;
   - 当前已应用结果与活跃运行单独持有,不因历史淘汰失效;
   - 历史只读,不回写当前设备与参数;
   - 换数据清空记录,刷新从空态开始,不声称跨刷新恢复。
   ═══════════════════════════════════════════════ */
window.PO.runHistory = (() => {
  'use strict';

  let mounted = false, rootEl = null, unsubscribe = null;
  let isOpen = false, lastFocused = null;

  const KIND_LABEL = { predict: 'RUL 预测', decision: '维修决策', backtest: '离线回测', agent: 'Agent 请求' };
  const STATUS_LABEL = { running: '运行中', success: '成功', error: '失败' };

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ───────── 摘要行 ─────────

  function summaryRow(run) {
    const snap = run.snapshot || {};
    const released = !!run.released;
    const statusClass = run.status === 'success' ? 'po-badge-success'
      : run.status === 'error' ? 'po-badge-warning' : 'po-badge-info';
    return '<div class="po-rh-row' + (released ? ' po-rh-released' : '') + '">'
      + '<div class="po-rh-row-head">'
      + '<span class="po-badge po-badge-info">' + esc(KIND_LABEL[run.kind] || run.kind) + '</span>'
      + '<span class="po-rh-runid">' + esc(run.runId) + '</span>'
      + '<span class="po-aux">' + fmtTime(run.startedAt) + '</span>'
      + '<span class="po-badge ' + statusClass + '">' + esc(STATUS_LABEL[run.status] || run.status) + '</span>'
      + (released ? '<span class="po-badge po-badge-warning">明细已释放</span>' : '')
      + '</div>'
      + '<div class="po-rh-row-meta">'
      + '<span>数据 ' + esc(snap.sessionId || '—') + '</span>'
      + '<span>设备 ' + esc(String(snap.unitId ?? '—')) + '</span>'
      + '<span>时点 ' + esc(String(snap.cycle ?? '—')) + '</span>'
      + '<span>参数版本 v' + esc(String(snap.scenarioRev ?? '—')) + '</span>'
      + '</div>'
      + '</div>';
  }

  // ───────── 渲染(仅抽屉打开时执行,避免关闭时无谓重建) ─────────

  function render(s) {
    if (!rootEl || !isOpen) return;
    const listEl = rootEl.querySelector('#po-rh-list');
    if (!listEl) return;
    const runs = s.runs;
    if (!runs.length) {
      listEl.innerHTML = '<div class="po-empty"><p>暂无运行记录</p></div>';
      return;
    }
    // 最新的在前面(只读,不提供回写操作)
    listEl.innerHTML = runs.slice().reverse().map(summaryRow).join('');
  }

  // ───────── 抽屉交互 ─────────

  function open() {
    if (!rootEl || isOpen) return;
    isOpen = true;
    lastFocused = document.activeElement; // 记录打开前焦点(关闭后归还)
    const overlay = rootEl.querySelector('#po-rh-overlay');
    if (overlay) overlay.hidden = false;
    render(PO.getState());
    const closeBtn = rootEl.querySelector('#po-rh-close');
    if (closeBtn) closeBtn.focus();
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (!rootEl || !isOpen) return;
    isOpen = false;
    const overlay = rootEl.querySelector('#po-rh-overlay');
    if (overlay) overlay.hidden = true;
    document.removeEventListener('keydown', onKeydown);
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch (_) { /* 元素已移除 */ }
    }
    lastFocused = null;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    // Tab 焦点圈定(仅在抽屉内可见可聚焦元素间循环)
    if (e.key === 'Tab') {
      const focusables = rootEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const visible = Array.from(focusables).filter(f => !f.disabled && f.offsetParent !== null);
      if (!visible.length) return;
      const first = visible[0], last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  // ───────── 挂载/卸载 ─────────

  function mount(root) {
    if (mounted) return; // 防重复挂载
    mounted = true;
    rootEl = root;
    rootEl.innerHTML = ''
      + '<div class="po-rh-overlay" id="po-rh-overlay" hidden>'
      + '  <div class="po-rh-panel" role="dialog" aria-label="当前会话运行记录">'
      + '    <div class="po-rh-header">'
      + '      <h2 class="po-rh-title">当前会话运行记录</h2>'
      + '      <button class="po-btn po-btn-secondary po-btn-sm" id="po-rh-close">关闭</button>'
      + '    </div>'
      + '    <div class="po-rh-body">'
      + '      <p class="po-aux">历史只读,不影响当前设备与参数;换数据清空记录,刷新从空态开始。</p>'
      + '      <div id="po-rh-list"></div>'
      + '    </div>'
      + '  </div>'
      + '</div>';

    const closeBtn = rootEl.querySelector('#po-rh-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    // 点击遮罩空白区关闭
    const overlay = rootEl.querySelector('#po-rh-overlay');
    if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    unsubscribe = PO.subscribe(render);
  }

  function unmount() {
    close();
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (rootEl) rootEl.innerHTML = '';
    mounted = false;
    rootEl = null;
  }

  return { mount, unmount, open, close };
})();