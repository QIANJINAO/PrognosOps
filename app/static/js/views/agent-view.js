/* ═══════════════════════════════════════════════
   PrognosOps Agent 视图(views/agent-view.js)
   职责:任务输入区(textarea,Ctrl/Cmd+Enter 提交,isComposing 不提交)、
         快捷问题、回答渲染、时间线挂载、滚动控制
   挂载:window.PO.agentView
   依赖:state.js(PO)、controllers/agent.js(PO.agent)、
         components/run-timeline.js(PO.runTimeline)、request-controller.js(PO.requests)
   设计约束(施工单 S12):
   - 输入用 textarea,Enter 换行,Ctrl/Cmd+Enter 提交,isComposing 时不提交;
   - 连点/多入口只发 1 次请求(业务锁);
   - 回包前无虚构步骤;部分失败标"部分工具失败";缺 result 标"无结构化结果";
   - 错误区含摘要、重试、停止等待;
   - JSON 默认折叠限高;用户上滚后不强制追底,有新内容时给入口;
   - 停止后保留快照与已有记录。
   ═══════════════════════════════════════════════ */
window.PO.agentView = (() => {
  'use strict';

  let mounted = false, rootEl = null, unsubscribe = null;
  let inputEl = null, responseEl = null, timelineEl = null, scrollEl = null, newContentBtn = null;
  let lastQuery = '';           // 最近提交的问题(供重试)
  let userScrolledUp = false;   // 用户是否上滚(上滚后不强制追底)

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');
  function el(id) { return document.getElementById(id); }

  const SUGGESTIONS = [
    '如果停机损失翻倍会怎样?',
    '如果alpha改为0.02会怎样?',
    '为什么推荐这个维修窗口?',
    '再等一个窗口会多花多少钱?',
    'ETO和IEO有什么差异?',
    '当前结果有哪些假设?',
  ];

  // ───────── 滚动控制(用户上滚后不强制追底,有新内容时给入口) ─────────
  function isNearBottom() {
    if (!scrollEl) return true;
    return scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 40;
  }
  function scrollToBottom() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    userScrolledUp = false;
    if (newContentBtn) newContentBtn.hidden = true;
  }
  function onScroll() {
    userScrolledUp = !isNearBottom();
    if (!userScrolledUp && newContentBtn) newContentBtn.hidden = true;
  }
  function handleScrollAfterRender() {
    if (!userScrolledUp) scrollToBottom();
    else if (newContentBtn) newContentBtn.hidden = false; // 有新内容,给入口
  }

  // ───────── 最新 Agent 运行记录 ─────────
  function latestAgentRun(s) {
    const runs = s.runs.filter(r => r.kind === 'agent');
    return runs.length ? runs[runs.length - 1] : null;
  }

  // ───────── 提交(按钮/快捷问题/键盘共用,业务锁保证只发 1 次) ─────────
  async function submitQuery(prefilled) {
    const q = (prefilled !== undefined ? prefilled : (inputEl ? inputEl.value : '')).trim();
    if (!q) return;
    if (PO.agent.isRunning()) return; // 业务锁:连点/多入口只发 1 次

    lastQuery = q;
    if (inputEl) inputEl.value = '';
    userScrolledUp = false; // 新提交追底显示

    // 立即渲染用户问题 + 请求中状态(startRun 的 notify 也会触发 renderAll)
    renderResponse(PO.getState(), q);
    PO.runTimeline.render(timelineEl, latestAgentRun(PO.getState()));
    handleScrollAfterRender();

    const r = await PO.agent.submit(q);
    if (r === null) {
      // 锁占用(防御:isRunning 已拦截,正常不会走到这里)
      const notice = document.createElement('div');
      notice.className = 'po-agent-notice';
      notice.textContent = 'Agent 正在处理上一个问题,请稍候';
      responseEl.appendChild(notice);
      return;
    }
    // 渲染最终状态(finishRun/failRun 的 notify 已触发 renderAll,此处确保)
    renderResponse(PO.getState(), q);
    PO.runTimeline.render(timelineEl, latestAgentRun(PO.getState()));
    handleScrollAfterRender();
  }

  // ───────── 回答渲染 ─────────
  function renderResponse(s, currentQuery) {
    if (!responseEl) return;
    const run = latestAgentRun(s);
    let html = '';

    // 用户问题气泡
    const q = currentQuery || lastQuery;
    if (q) {
      html += '<div class="po-chat-user"><span class="po-chat-label">问</span>' + esc(q) + '</div>';
    }

    if (!run) {
      html += '<div class="po-empty"><p>向 AI 助手提问,获取基于当前工作台数据的分析</p></div>';
      responseEl.innerHTML = html;
      return;
    }

    // running:请求中 + 停止等待按钮
    if (run.status === 'running') {
      html += '<div class="po-chat-assistant">'
        + '<div class="po-agent-thinking">AI 助手正在分析问题并调用后端工具计算...</div>'
        + '<div class="po-agent-actions"><button class="po-btn po-btn-secondary po-btn-sm" id="ag-stop-btn">停止等待</button></div>'
        + '</div>';
      responseEl.innerHTML = html;
      const stopBtn = el('ag-stop-btn');
      if (stopBtn) stopBtn.addEventListener('click', () => PO.requests.stopWaiting(run.runId));
      return;
    }

    // error:错误摘要 + 重试 + 离线解释
    if (run.status === 'error') {
      const err = run.error || {};
      if (err.code === 'E4002') {
        // 未配置模型:配置提示,不假装成功
        html += '<div class="po-chat-assistant">'
          + '<div class="po-agent-error-title">运行时 AI Agent 未配置模型 API</div>'
          + '<div class="po-agent-error-detail">' + esc(err.message || '') + '</div>'
          + '<div class="po-agent-error-hint">配置方法:在后端环境变量中设置 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME,然后重启服务。参见 .env.example。</div>'
          + '</div>';
        responseEl.innerHTML = html;
        return;
      }
      html += '<div class="po-chat-assistant">'
        + '<div class="po-agent-error-title">请求失败</div>'
        + '<div class="po-agent-error-detail">' + esc(err.message || '未知错误') + '</div>'
        + '<div class="po-agent-actions">'
        + '<button class="po-btn po-btn-secondary po-btn-sm" id="ag-retry-btn">重试</button>'
        + '<button class="po-btn po-btn-secondary po-btn-sm" id="ag-offline-btn">查看离线解释</button>'
        + '</div>'
        + '<div class="po-agent-offline" id="ag-offline-content" hidden>'
        + '<div class="po-agent-offline-source">以下为离线关键词匹配结果(非模型生成,数据来自当前工作台):</div>'
        + '<div class="po-agent-answer-text">' + esc(PO.agent.answerOffline(lastQuery)).replace(/\n/g, '<br>') + '</div>'
        + '</div></div>';
      responseEl.innerHTML = html;
      const retryBtn = el('ag-retry-btn');
      if (retryBtn) retryBtn.addEventListener('click', () => { if (lastQuery) submitQuery(lastQuery); });
      const offlineBtn = el('ag-offline-btn');
      const offlineContent = el('ag-offline-content');
      if (offlineBtn && offlineContent) offlineBtn.addEventListener('click', () => {
        offlineContent.hidden = false; offlineBtn.hidden = true;
      });
      return;
    }

    // stale:迟到回包已归档,不冒充当前回答
    if (run.snapshot && run.snapshot.contextRev !== s.context.contextRev) {
      html += '<div class="po-chat-assistant">'
        + '<div class="po-agent-notice">上下文已变化,本次回答已归档,请重新提问。</div>'
        + '</div>';
      responseEl.innerHTML = html;
      return;
    }

    // success:回答 + meta(部分工具失败/无结构化结果标注)
    const result = run.result || {};
    const log = result.tool_calls_log || [];
    const failedTools = log.filter(tc => tc.result && tc.result.error);
    const noResultTools = log.filter(tc => !tc.result);
    let metaText = '模型:' + esc(result.model_used || '—') + ' | 工具调用:' + (result.n_rounds || 0) + ' 轮';
    if (failedTools.length) metaText += '(部分工具失败:' + failedTools.length + ' 项)';
    if (noResultTools.length) metaText += '(无结构化结果:' + noResultTools.length + ' 项)';

    html += '<div class="po-chat-assistant">'
      + '<div class="po-agent-answer-text">' + esc(result.answer || '').replace(/\n/g, '<br>') + '</div>'
      + '<div class="po-agent-meta">' + metaText + '</div>'
      + '</div>';
    responseEl.innerHTML = html;
  }

  // ───────── 状态订阅渲染 ─────────
  function renderAll(s) {
    renderResponse(s);
    PO.runTimeline.render(timelineEl, latestAgentRun(s));
    handleScrollAfterRender();
    const btn = el('ag-submit-btn');
    if (btn) {
      btn.disabled = PO.agent.isRunning();
      btn.textContent = PO.agent.isRunning() ? '处理中...' : '提交';
    }
  }

  // ═══════════════ 挂载/卸载 ═══════════════
  function mount(root) {
    if (mounted) return; // 防重复挂载
    mounted = true;
    rootEl = root;

    const chipsHtml = SUGGESTIONS.map(s =>
      '<button class="po-suggestion-chip" data-q="' + esc(s) + '">' + esc(s) + '</button>'
    ).join('');

    rootEl.innerHTML = ''
      + '<div class="po-agent-view">'
      + '  <div class="po-agent-input-row">'
      + '    <textarea class="po-textarea" id="ag-input" rows="2" placeholder="向 AI 助手提问...(Ctrl+Enter 提交,Enter 换行)"></textarea>'
      + '    <button class="po-btn po-btn-accent" id="ag-submit-btn">提交</button>'
      + '  </div>'
      + '  <div class="po-agent-suggestions" id="ag-suggestions">' + chipsHtml + '</div>'
      + '  <button class="po-btn po-btn-secondary po-btn-sm po-new-content" id="ag-new-content" hidden>↓ 有新内容</button>'
      + '  <div class="po-agent-scroll" id="ag-scroll">'
      + '    <div id="ag-response" aria-live="polite" role="log"></div>'
      + '    <h3 class="po-evidence-title">运行时间线</h3>'
      + '    <div id="ag-timeline"></div>'
      + '  </div>'
      + '</div>';

    inputEl = el('ag-input');
    responseEl = el('ag-response');
    timelineEl = el('ag-timeline');
    scrollEl = el('ag-scroll');
    newContentBtn = el('ag-new-content');

    // 输入行为:Enter 换行(默认,不干预 textarea 原生行为);
    // Ctrl/Cmd+Enter 提交(isComposing 期间不提交)
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!e.isComposing) submitQuery();
      }
    });

    // 提交按钮
    el('ag-submit-btn').addEventListener('click', () => submitQuery());

    // 快捷问题:点击填入并提交
    el('ag-suggestions').addEventListener('click', (e) => {
      const q = e.target.dataset && e.target.dataset.q;
      if (q) submitQuery(q);
    });

    // 滚动监听 + 新内容入口
    scrollEl.addEventListener('scroll', onScroll);
    newContentBtn.addEventListener('click', scrollToBottom);

    // 常驻订阅:状态变化 → 渲染(切页不重置)
    unsubscribe = PO.subscribe(renderAll);
    renderAll(PO.getState());
  }

  function unmount() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (rootEl) rootEl.innerHTML = '';
    mounted = false;
    rootEl = null;
    inputEl = responseEl = timelineEl = scrollEl = newContentBtn = null;
    lastQuery = '';
    userScrolledUp = false;
  }

  return { mount, unmount };
})();