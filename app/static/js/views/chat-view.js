/* ═══════════════════════════════════════════════
   PrognosOps 会话主视图(views/chat-view.js)
   职责:AI 对话主体——欢迎屏/消息流/输入框/快捷任务/滚动控制;
         对话驱动业务闭环(导入→分析→追问→比较→应用→回测→导出)
   挂载:window.PO.chatView
   依赖:state.js(PO)、controllers(PO.agent/PO.analysis/PO.backtest)、
         cards.js(PO.cards)、detail-drawer.js(PO.detailDrawer)、api.js(API)
   设计约束:
   - 不伪造流式/进度;回包后据 tool_calls_log 展示执行记录
   - Enter 换行,Ctrl/Cmd+Enter 发送,正确处理中文输入法
   - 用户上滚不强制追底,新消息提供"查看最新消息"入口
   - 打开/关闭详情不清空会话;数值全部来自后端
   ═══════════════════════════════════════════════ */
window.PO.chatView = (() => {
  'use strict';

  let mounted = false, rootEl = null, unsubscribe = null;
  let userScrolledUp = false;
  let lastSessionId = null;
  let lastMessageCount = 0;

  // DOM 引用(mount 时赋值)
  let welcomeEl, scrollEl, messagesEl, scrollBtnEl;
  let inputEl, sendBtnEl, quickEl, fileInputEl, dropHintEl;

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');
  const fmtNum = (v, d) => API.fmtNum(v, d);
  const fmtPct = (v) => API.fmtPct(v);

  // 后端默认决策参数(app/core/decision.py DEFAULT_PARAMS)
  const DEFAULT_PARAMS = { cm: 1, cd: 5, cp: 50, cc: 200, alpha: 0.01 };
  const DEFAULT_BT_CONFIG = {
    data_mode: 'offline', step: 10, min_cycle: 30, k_nn: 50,
    n_repeats: 1, n_calibration_bins: 10, random_seed: 0,
  };

  // ───────── 数据加载检测(resetDataset 后新 sessionId → 追加系统事件+卡片) ─────────

  function checkDataLoad(s) {
    if (s.context.sessionId && lastSessionId !== s.context.sessionId) {
      // 先更新 lastSessionId,防止 addMessage→notify→render 递归时重复进入
      lastSessionId = s.context.sessionId;
      const fileName = s.context.fileName || '';
      const isDemo = /demo|演示|合成/i.test(fileName);
      PO.addMessage({ type: 'system', text: '数据已加载:' + fileName, level: 'success' });
      PO.addMessage({
        type: 'card', cardType: 'data-import',
        data: PO.cards.buildDataImportData(s, fileName, isDemo ? 'demo' : 'upload'),
      });
      return; // addMessage 已触发重渲染,跳过本次后续渲染
    }
    lastSessionId = s.context.sessionId;
  }

  // ───────── 欢迎屏 ─────────

  function renderWelcome(s) {
    const hasMessages = s.messages.length > 0;
    if (welcomeEl) welcomeEl.hidden = hasMessages;
  }

  // ───────── 消息渲染 ─────────

  function renderMessages(s) {
    if (!messagesEl) return;
    let html = '';
    for (const msg of s.messages) {
      html += renderMessage(msg, s);
    }
    messagesEl.innerHTML = html;
    lastMessageCount = s.messages.length;
  }

  function renderMessage(msg, s) {
    if (msg.type === 'user') return renderUserMsg(msg);
    if (msg.type === 'agent') return renderAgentMsg(msg, s);
    if (msg.type === 'system') return renderSystemMsg(msg);
    if (msg.type === 'card') return renderCardMsg(msg);
    return '';
  }

  function renderUserMsg(msg) {
    return '<div class="po-chat-msg po-chat-msg-user">'
      + '<div class="po-chat-user-bubble"><p class="po-chat-user-text">' + esc(msg.text || '') + '</p></div>'
      + '</div>';
  }

  function renderSystemMsg(msg) {
    const level = msg.level || 'info';
    return '<div class="po-chat-msg po-chat-msg-system po-chat-sys-' + level + '">'
      + '<span class="po-chat-sys-text">' + esc(msg.text || '') + '</span>'
      + '</div>';
  }

  function renderAgentMsg(msg, s) {
    const status = msg.status || 'running';
    let html = '<div class="po-chat-msg po-chat-msg-agent">'
      + '<div class="po-chat-agent-avatar" aria-hidden="true">🤖</div>'
      + '<div class="po-chat-agent-body">'
      + '<div class="po-chat-agent-label">维策 Agent</div>';

    if (status === 'running') {
      html += '<div class="po-chat-msg-text po-chat-thinking"><span class="po-chat-dot-anim"></span>正在分析问题...</div>';
    } else if (status === 'error') {
      html += '<div class="po-chat-msg-text po-chat-text-error">' + esc(msg.text || '请求失败') + '</div>';
      html += '<div class="po-chat-agent-actions">'
        + '<button class="po-btn po-btn-secondary po-btn-sm" data-action="retry-agent" data-query="' + esc(msg.query || '') + '">重试</button>'
        + '<button class="po-btn po-btn-secondary po-btn-sm" data-action="offline-answer" data-query="' + esc(msg.query || '') + '">离线解释</button>'
        + '</div>';
    } else if (status === 'stale') {
      html += '<div class="po-chat-msg-text po-chat-text-stale">' + esc(msg.text || '上下文已变化') + '</div>';
    } else if (status === 'offline') {
      html += '<div class="po-chat-msg-text">' + esc(msg.text || '') + '</div>';
      html += '<div class="po-chat-agent-meta">离线解释模式(模型不可用,基于当前状态的关键词匹配)</div>';
    } else {
      // success
      html += '<div class="po-chat-msg-text">' + esc(msg.text || '') + '</div>';
      // 工具执行记录(据 tool_calls_log,默认折叠)
      if (msg.runId) {
        const run = s.runs.find(r => r.runId === msg.runId);
        if (run && run.result && Array.isArray(run.result.tool_calls_log) && run.result.tool_calls_log.length) {
          html += renderToolLog(run.result.tool_calls_log);
        }
      }
      // 部分工具失败标注
      if (msg.partialFailures) {
        html += '<div class="po-chat-agent-meta po-chat-meta-warn">部分工具执行失败,回答可能不完整</div>';
      }
    }

    html += '</div></div>';
    return html;
  }

  function renderToolLog(toolCallsLog) {
    const total = toolCallsLog.length;
    const failed = toolCallsLog.filter(tc => tc.result && tc.result.error).length;
    const summary = failed > 0
      ? '执行了 ' + total + ' 个工具调用(' + failed + ' 个失败)'
      : '执行了 ' + total + ' 个工具调用';
    let steps = '';
    for (const tc of toolCallsLog) {
      const hasError = !!(tc.result && tc.result.error);
      const noResult = !tc.result;
      const cls = hasError ? 'po-chat-tool-fail' : (noResult ? 'po-chat-tool-warn' : 'po-chat-tool-ok');
      const label = hasError ? '失败' : (noResult ? '无结果' : '完成');
      steps += '<div class="po-chat-tool-step ' + cls + '">'
        + '<span class="po-chat-tool-name">' + esc(tc.tool) + '</span>'
        + '<span class="po-chat-tool-status">' + label + '</span>'
        + '</div>';
    }
    return '<details class="po-chat-tool-log"><summary>' + esc(summary) + '</summary>'
      + '<div class="po-chat-tool-steps">' + steps + '</div></details>';
  }

  function renderCardMsg(msg) {
    const cardHtml = PO.cards.render(msg);
    if (!cardHtml) return '';
    return '<div class="po-chat-msg po-chat-msg-card" data-msg-id="' + esc(msg.id) + '">'
      + cardHtml + '</div>';
  }

  // ───────── 快捷任务 ─────────

  function renderQuickTasks(s) {
    if (!quickEl) return;
    const hasData = !!s.context.sessionId;
    const hasScenario = !!s.appliedScenario;
    let html = '';
    if (!hasData) {
      html += '<button class="po-chat-quick-btn" data-action="upload-demo" type="button">📦 加载演示数据</button>';
      html += '<button class="po-chat-quick-btn" data-action="upload-file" type="button">📄 导入 CSV</button>';
    } else {
      html += '<button class="po-chat-quick-btn" data-action="start-analysis" type="button">🔧 分析当前设备</button>';
      if (hasScenario) {
        html += '<button class="po-chat-quick-btn" data-action="ask-agent" data-query="为什么推荐这个维修窗口?依据是什么?" type="button">💡 为什么推荐这个窗口?</button>';
        html += '<button class="po-chat-quick-btn" data-action="run-backtest" type="button">🔬 运行回测验证</button>';
      }
    }
    quickEl.innerHTML = html;
  }

  // ───────── 输入区状态 ─────────

  function renderInputState(s) {
    if (!sendBtnEl || !inputEl) return;
    const busy = PO.agent.isRunning() || PO.analysis.isRunning();
    sendBtnEl.disabled = busy;
    inputEl.disabled = false; // 输入框不禁用,允许编辑草稿
    sendBtnEl.textContent = busy ? '处理中...' : '发送';
  }

  // ───────── 滚动控制 ─────────

  function isNearBottom() {
    if (!scrollEl) return true;
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  }

  function scrollToBottom(smooth) {
    if (!scrollEl) return;
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    userScrolledUp = false;
    if (scrollBtnEl) scrollBtnEl.hidden = true;
  }

  function onScroll() {
    if (!scrollEl) return;
    const nearBottom = isNearBottom();
    userScrolledUp = !nearBottom;
    if (scrollBtnEl) scrollBtnEl.hidden = nearBottom;
  }

  function handleScrollAfterRender() {
    if (!userScrolledUp) {
      // 用户在底部附近(或从未上滚)→ 追底
      scrollToBottom(false);
    }
    // 用户上滚中 → 不强制追底,保留"查看最新消息"入口
  }

  // ───────── 统一渲染 ─────────

  function render(s) {
    checkDataLoad(s);
    renderWelcome(s);
    renderMessages(s);
    renderQuickTasks(s);
    renderInputState(s);
    handleScrollAfterRender();
  }

  // ═══════════════ 业务操作 ═══════════════

  // ── 提交 Agent 问题 ──
  async function submitQuestion(text) {
    text = (text || '').trim();
    if (!text) return;
    if (PO.agent.isRunning()) return;

    inputEl.value = '';
    PO.addMessage({ type: 'user', text: text });
    const agentMsgId = PO.addMessage({ type: 'agent', status: 'running', query: text });

    try {
      const r = await PO.agent.submit(text);
      if (r === null) {
        PO.updateMessage(agentMsgId, { status: 'error', text: '已有请求进行中,请稍候', query: text });
      } else if (r.stale) {
        PO.updateMessage(agentMsgId, { status: 'stale', text: '上下文已变化,本次回答仅归档,不影响当前结果', query: text });
      } else if (r.error) {
        PO.updateMessage(agentMsgId, { status: 'error', text: r.error.message || '请求失败', query: text });
        inputEl.value = text; // 保留失败草稿
      } else {
        // 成功:检查部分工具失败
        const log = r.result.tool_calls_log || [];
        const partialFailures = log.some(tc => tc.result && tc.result.error);
        PO.updateMessage(agentMsgId, {
          status: 'success', text: r.result.answer, runId: r.runId,
          partialFailures: partialFailures, query: text,
        });
        // 候选方案 → 情景比较卡片
        if (r.candidates && r.candidates.length) {
          const cs = PO.getState();
          PO.addMessage({
            type: 'card', cardType: 'compare',
            data: PO.cards.buildCompareData(cs, r.candidates),
          });
        }
      }
    } catch (err) {
      PO.updateMessage(agentMsgId, { status: 'error', text: err.message || '请求失败', query: text });
      inputEl.value = text; // 保留失败草稿
    }
  }

  // ── 离线解释 ──
  function offlineAnswer(query) {
    if (!query) return;
    const answer = PO.agent.answerOffline(query);
    PO.addMessage({ type: 'agent', status: 'offline', text: answer, query: query });
  }

  // ── 运行分析 ──
  async function runAnalysis() {
    if (PO.analysis.isRunning()) return;
    const s = PO.getState();
    if (!s.context.sessionId || s.context.unitId == null) {
      PO.addMessage({ type: 'system', text: '请先导入数据,然后在数据页选择设备单元', level: 'warn' });
      return;
    }
    // 参数优先级:草稿 > 已应用方案 > 后端默认
    const params = s.draft || (s.appliedScenario ? s.appliedScenario.params : null) || DEFAULT_PARAMS;
    PO.addMessage({ type: 'system', text: '正在分析设备 #' + s.context.unitId + '...', level: 'info' });
    try {
      const r = await PO.analysis.runCurrent({
        sessionId: s.context.sessionId,
        unitId: s.context.unitId,
        cycle: s.context.cycle,
        k_nn: s.context.predictionConfig ? s.context.predictionConfig.k_nn : 50,
        random_seed: s.context.predictionConfig ? s.context.predictionConfig.random_seed : null,
        params: params,
        useCache: true,
      });
      if (r === null) {
        PO.addMessage({ type: 'system', text: '分析已在进行中,请等待完成', level: 'warn' });
      } else if (r.stale) {
        PO.addMessage({ type: 'system', text: '上下文已变化,本次分析结果仅归档', level: 'warn' });
      } else if (r.decisionError) {
        PO.addMessage({ type: 'system', text: '预测完成,但决策计算失败:' + (r.decisionError.message || '请求失败'), level: 'error' });
      } else {
        PO.addMessage({ type: 'system', text: '分析完成,已生成维修建议', level: 'success' });
        const adviceData = PO.cards.buildAdviceData(PO.getState());
        if (adviceData) {
          PO.addMessage({ type: 'card', cardType: 'advice', data: adviceData });
        }
      }
    } catch (err) {
      const msg = err && err.fieldErrors && err.fieldErrors.length
        ? '参数校验失败:' + err.fieldErrors.map(fe => fe.field + ' ' + fe.message).join('; ')
        : '分析失败:' + (err.message || '请求失败');
      PO.addMessage({ type: 'system', text: msg, level: 'error' });
    }
  }

  // ── 运行回测 ──
  async function runBacktest() {
    const s = PO.getState();
    if (!s.appliedScenario) {
      PO.addMessage({ type: 'system', text: '尚未应用决策方案,请先运行分析', level: 'warn' });
      return;
    }
    PO.addMessage({ type: 'system', text: '正在运行回测验证...', level: 'info' });
    try {
      const r = await PO.backtest.runCurrent(DEFAULT_BT_CONFIG);
      if (!r.ok) {
        PO.addMessage({ type: 'system', text: r.error || '无法运行回测', level: 'warn' });
      } else if (r.stale) {
        PO.addMessage({ type: 'system', text: '方案/上下文已变化,回测结果仅归档', level: 'warn' });
      } else {
        PO.addMessage({ type: 'system', text: '回测完成', level: 'success' });
        const btData = PO.cards.buildBacktestData(PO.getState(), r.runId);
        if (btData) {
          PO.addMessage({ type: 'card', cardType: 'backtest', data: btData });
        }
      }
    } catch (err) {
      PO.addMessage({ type: 'system', text: '回测失败:' + (err.message || '请求失败'), level: 'error' });
    }
  }

  // ── 应用候选方案 ──
  async function applyCandidate(msgId, candidateIndex) {
    const s = PO.getState();
    const msg = s.messages.find(m => m.id === msgId);
    if (!msg || msg.type !== 'card' || msg.cardType !== 'compare') return;
    const candidate = (msg.data.candidates || [])[candidateIndex];
    if (!candidate) return;
    if (candidate.contextRev !== s.context.contextRev) {
      PO.addMessage({ type: 'system', text: '候选方案来源版本与当前上下文不一致,无法应用', level: 'warn' });
      return;
    }
    // 提取候选参数
    let params = null;
    if (candidate.type === 'recompute' && candidate.decision) params = candidate.decision.params;
    if (candidate.type === 'compare' && candidate.comparison) params = candidate.comparison.params;
    if (!params) {
      PO.addMessage({ type: 'system', text: '候选方案缺少参数信息,无法应用', level: 'warn' });
      return;
    }
    PO.addMessage({ type: 'system', text: '正在应用候选方案并重新计算...', level: 'info' });
    try {
      await PO.analysis.applyCandidate(candidate, { params: params, useCache: true });
      PO.addMessage({ type: 'system', text: '方案已应用,决策已重新计算', level: 'success' });
      // 应用成功后推进比较卡片的版本快照:scenarioRev 已递增,其余候选因版本不匹配标记过期;
      // 已应用项标 appliedIndex → 显示"已应用"徽章 + po-cand-just-applied 高亮动效
      const s2 = PO.getState();
      // 推进比较卡片版本快照 + 已应用候选自身版本(避免 appliedIndex 清除后被误标过期)
      const newCandidates = (msg.data.candidates || []).map((c, i) =>
        i === candidateIndex
          ? Object.assign({}, c, { contextRev: s2.context.contextRev, scenarioRev: s2.context.scenarioRev, applied: true })
          : c
      );
      const newData = Object.assign({}, msg.data, {
        contextRev: s2.context.contextRev,
        scenarioRev: s2.context.scenarioRev,
        appliedIndex: candidateIndex,
        candidates: newCandidates,
      });
      PO.updateMessage(msgId, { data: newData });
      // 760ms 动效播完后移除高亮 class(保留"已应用"徽章,清除 appliedIndex)
      setTimeout(() => {
        PO.updateMessage(msgId, { data: Object.assign({}, newData, { appliedIndex: null }) });
      }, 800);
      const adviceData = PO.cards.buildAdviceData(PO.getState());
      if (adviceData) {
        PO.addMessage({ type: 'card', cardType: 'advice', data: adviceData });
      }
    } catch (err) {
      PO.addMessage({ type: 'system', text: '应用失败:' + (err.message || '请求失败'), level: 'error' });
    }
  }

  // ── 导出回测 ──
  function exportBacktest(runId) {
    if (!runId) return;
    const r = PO.export.downloadRun(runId, 'csv');
    if (!r.ok) {
      PO.addMessage({ type: 'system', text: r.error || '导出失败', level: 'warn' });
    } else {
      PO.addMessage({ type: 'system', text: '已导出:' + r.filename, level: 'success' });
    }
  }

  // ── 文件上传(选择/拖拽共用) ──
  async function uploadFile(file) {
    if (!file) return;
    if (PO.requests.isBusy('upload')) {
      PO.addMessage({ type: 'system', text: '上传进行中,请等待完成', level: 'warn' });
      return;
    }
    if (file.size === 0) {
      PO.addMessage({ type: 'system', text: '文件 "' + file.name + '" 为空', level: 'error' });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      PO.addMessage({ type: 'system', text: '文件超过 50MB 限制', level: 'error' });
      return;
    }
    PO.addMessage({ type: 'system', text: '正在上传 "' + file.name + '"...', level: 'info' });
    try {
      const r = await PO.requests.runTask('upload', {}, (signal) => API.uploadCsv(file, { signal }));
      if (!r) {
        PO.addMessage({ type: 'system', text: '上传进行中,请等待完成', level: 'warn' });
        return;
      }
      if (r.stale) return;
      // 原子替换:resetDataset → setData → setContext(checkDataLoad 自动追加卡片)
      PO.resetDataset();
      PO.setData({
        overview: r.result.overview,
        qualityReport: r.result.quality_report,
        unitIds: (r.result.overview.units || []).map(u => u.unit_id),
      });
      PO.setContext({ sessionId: r.result.session_id, fileName: file.name });
    } catch (err) {
      let msg = '上传失败:' + (err.message || '请求失败');
      if (err.fieldErrors && err.fieldErrors.length) {
        msg += '\n' + err.fieldErrors.map(fe => fe.field + ': ' + fe.message).join('; ');
      }
      PO.addMessage({ type: 'system', text: msg, level: 'error' });
    }
  }

  // ── 演示数据 ──
  function uploadDemo() {
    if (typeof DemoData === 'undefined') {
      PO.addMessage({ type: 'system', text: '演示数据模块未加载', level: 'error' });
      return;
    }
    uploadFile(DemoData.generateFile(42));
  }

  // ═══════════════ 事件处理 ═══════════════

  // ── 发送 ──
  function onSend() {
    const text = inputEl ? inputEl.value : '';
    if (!text.trim()) return;
    submitQuestion(text);
  }

  // ── 键盘:Enter 换行,Ctrl/Cmd+Enter 发送,正确处理中文输入法 ──
  function onKeyDown(e) {
    if (e.key !== 'Enter') return;
    // 中文输入法组合中不拦截
    if (e.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      onSend();
    }
    // 普通 Enter → 默认换行,不拦截
  }

  // ── 卡片/快捷任务动作委托(事件委托,避免每次渲染重绑) ──
  function onActionClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const query = btn.dataset.query || '';

    switch (action) {
      case 'start-analysis':
        runAnalysis();
        break;
      case 'ask-agent':
        if (query) submitQuestion(query);
        break;
      case 'retry-agent':
        if (query) submitQuestion(query);
        break;
      case 'offline-answer':
        offlineAnswer(query);
        break;
      case 'run-backtest':
        runBacktest();
        break;
      case 'open-detail': {
        const type = btn.dataset.detailType;
        if (type && PO.detailDrawer) PO.detailDrawer.open(type);
        break;
      }
      case 'apply-candidate': {
        const idx = parseInt(btn.dataset.candidateIndex, 10);
        const cardMsg = btn.closest('.po-chat-msg-card');
        const msgId = cardMsg ? cardMsg.dataset.msgId : null;
        if (msgId && !isNaN(idx)) applyCandidate(msgId, idx);
        break;
      }
      case 'export-backtest': {
        const runId = btn.dataset.runId;
        exportBacktest(runId);
        break;
      }
      case 'goto-validation':
        PO.router.navigate('validation');
        break;
      case 'upload-demo':
        uploadDemo();
        break;
      case 'upload-file':
        if (fileInputEl) fileInputEl.click();
        break;
      default:
        break;
    }
  }

  // ── 文件选择 ──
  function onFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (file) uploadFile(file);
    e.target.value = ''; // 清空,允许重复选择同一文件
  }

  // ── 拖拽上传 ──
  function onDragOver(e) {
    e.preventDefault();
    if (dropHintEl) dropHintEl.hidden = false;
  }
  function onDragLeave(e) {
    if (dropHintEl) dropHintEl.hidden = true;
  }
  function onDrop(e) {
    e.preventDefault();
    if (dropHintEl) dropHintEl.hidden = true;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  // ── "查看最新消息"按钮 ──
  function onScrollBtnClick() {
    scrollToBottom(true);
  }

  // ═══════════════ 挂载/卸载 ═══════════════

  function mount(root) {
    if (mounted) return;
    mounted = true;
    rootEl = root;

    rootEl.innerHTML = ''
      // 滚动区(欢迎屏 + 消息流)
      + '<div class="po-chat-scroll" id="chat-scroll">'
      + '  <div class="po-chat-welcome" id="chat-welcome">'
      + '    <div class="po-chat-welcome-inner">'
      + '      <div class="po-chat-welcome-brand">'
      + '        <span class="po-brand-mark" aria-hidden="true"></span>'
      + '        <span class="po-chat-welcome-brand-text">维策 Agent</span>'
      + '      </div>'
      + '      <h1 class="po-chat-welcome-title">这台设备,什么时候检修更合适?</h1>'
      + '      <p class="po-chat-welcome-sub">导入设备运行数据,我来帮你预测剩余寿命、推荐维修窗口、比较维修策略、验证方案效果。</p>'
      + '      <div class="po-chat-welcome-hints">'
      + '        <span class="po-chat-welcome-hint">💬 直接输入问题</span>'
      + '        <span class="po-chat-welcome-hint">📄 拖入 CSV 文件</span>'
      + '        <span class="po-chat-welcome-hint">📦 或加载演示数据</span>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="po-chat-messages" id="chat-messages" aria-live="polite"></div>'
      + '</div>'
      // 拖拽提示
      + '<div class="po-chat-drop-hint" id="chat-drop-hint" hidden>松开以导入 CSV 文件</div>'
      // "查看最新消息"入口
      + '<button class="po-chat-scroll-btn" id="chat-scroll-btn" hidden type="button">↓ 查看最新消息</button>'
      // 输入区(固定底部)
      + '<div class="po-chat-input-area">'
      + '  <div class="po-chat-quick" id="chat-quick"></div>'
      + '  <div class="po-chat-input-row">'
      + '    <textarea class="po-chat-input-textarea" id="chat-input" rows="1" '
      + '      placeholder="输入你的问题,例如:分析当前设备的维修窗口..." '
      + '      aria-label="对话输入框"></textarea>'
      + '    <button class="po-btn po-btn-accent po-chat-send-btn" id="chat-send" type="button">发送</button>'
      + '  </div>'
      + '  <div class="po-chat-input-hint">Enter 换行 · Ctrl+Enter 发送 · 可拖入 CSV 文件</div>'
      + '  <input type="file" id="chat-file-input" accept=".csv" hidden>'
      + '</div>';

    // 缓存 DOM 引用
    welcomeEl = rootEl.querySelector('#chat-welcome');
    scrollEl = rootEl.querySelector('#chat-scroll');
    messagesEl = rootEl.querySelector('#chat-messages');
    scrollBtnEl = rootEl.querySelector('#chat-scroll-btn');
    inputEl = rootEl.querySelector('#chat-input');
    sendBtnEl = rootEl.querySelector('#chat-send');
    quickEl = rootEl.querySelector('#chat-quick');
    fileInputEl = rootEl.querySelector('#chat-file-input');
    dropHintEl = rootEl.querySelector('#chat-drop-hint');

    // 事件绑定(一次,不随渲染重建)
    if (sendBtnEl) sendBtnEl.addEventListener('click', onSend);
    if (inputEl) inputEl.addEventListener('keydown', onKeyDown);
    if (scrollBtnEl) scrollBtnEl.addEventListener('click', onScrollBtnClick);
    if (scrollEl) scrollEl.addEventListener('scroll', onScroll, { passive: true });
    if (fileInputEl) fileInputEl.addEventListener('change', onFileChange);
    // 动作委托:快捷任务+卡片按钮+Agent错误操作,统一在 rootEl 上监听
    rootEl.addEventListener('click', onActionClick);
    // 拖拽上传
    rootEl.addEventListener('dragover', onDragOver);
    rootEl.addEventListener('dragleave', onDragLeave);
    rootEl.addEventListener('drop', onDrop);

    // 常驻订阅:状态变化 → 渲染(切页不重置)
    unsubscribe = PO.subscribe(render);
    render(PO.getState());
  }

  function unmount() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (rootEl) {
      rootEl.removeEventListener('click', onActionClick);
      rootEl.removeEventListener('dragover', onDragOver);
      rootEl.removeEventListener('dragleave', onDragLeave);
      rootEl.removeEventListener('drop', onDrop);
      rootEl.innerHTML = '';
    }
    mounted = false;
    rootEl = null;
    welcomeEl = scrollEl = messagesEl = scrollBtnEl = null;
    inputEl = sendBtnEl = quickEl = fileInputEl = dropHintEl = null;
  }

  // ── 触发文件选择器(供侧栏/外部入口调用) ──
  function pickFile() {
    if (fileInputEl) fileInputEl.click();
  }

  return { mount, unmount, uploadFile, uploadDemo, pickFile };
})();