/**
 * PrognosOps 统一状态管理(S02:单一事实源)
 * 职责:集中保存上下文/数据/预测/草稿/方案/候选/运行记录/回测/对话历史,
 *       为后续条目(S06~S16)提供唯一状态读写入口。
 * 设计约束(施工单 S02):
 *   - 原生 JS,IIFE 挂 window.PO,不引状态库;
 *   - getState 返回深拷贝,不暴露可变引用(改返回对象不脏 store);
 *   - 视图不得直接写状态,只能通过接口方法;
 *   - 结果绑定 runId 与输入快照,旧版本结果不覆盖新结果;
 *   - setDraftParams 只改草稿,不影响已有运行的快照。
 */
window.PO = (() => {
  'use strict';

  // ───────── 内部状态(私有,外部只能通过接口访问) ─────────
  let store = {
    // 上下文(当前工作环境)
    context: {
      sessionId: null,        // 当前会话 ID
      fileName: null,         // 上传文件名
      unitId: null,           // 当前选中的设备单元 ID
      cycle: null,            // 当前预测周期
      predictionConfig: null, // 预测配置 {k_nn, random_seed}
      contextRev: 0,          // 上下文版本号,setContext/resetDataset 时递增
      scenarioRev: null,      // 已应用方案版本号,applyScenario 时设置
    },
    // 数据层(上传后的数据信息)
    data: {
      overview: null,         // DataOverview
      qualityReport: null,    // DataQualityReport
      unitIds: [],            // 可用单元 ID 列表
    },
    prediction: null,         // 当前 RUL 预测结果(绑定最新 predict 运行)
    draft: null,              // 草稿参数(决策表单当前值,未提交)
    appliedScenario: null,    // 已应用的方案(绑定最新 decision 运行)
    candidates: [],           // 候选方案列表
    runs: [],                 // 运行记录列表(predict/decision/backtest/agent)
    backtest: null,           // 当前回测结果(绑定最新 backtest 运行)
    chatHistory: [],          // Agent 对话历史(发给后端的上下文,最多 20 条)
    messages: [],             // 会话消息流(前端展示用,含用户/Agent/系统事件/结果卡片)
  };

  // ───────── 订阅者列表 ─────────
  const listeners = new Set();

  // ───────── 内部工具 ─────────

  // 深拷贝:防止外部修改脏化内部状态
  function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  // 通知所有订阅者(传入变更后的只读快照)
  function notify() {
    const snapshot = deepClone(store);
    listeners.forEach(fn => {
      try { fn(snapshot); } catch (e) { console.error('[PO] 订阅者回调异常:', e); }
    });
  }

  // 生成唯一运行 ID
  let runCounter = 0;
  function genRunId() {
    runCounter++;
    return `run-${Date.now()}-${runCounter}`;
  }

  // 查找运行记录
  function findRun(runId) {
    return store.runs.find(r => r.runId === runId) || null;
  }

  // 从 runId 提取递增序号(run-{timestamp}-{counter}),保证同毫秒创建也能区分新旧
  function runSeq(runId) {
    const parts = String(runId).split('-');
    return parseInt(parts[parts.length - 1], 10);
  }

  // 查找指定 kind 的最新运行记录(按 runId 序号降序,序号严格递增保证唯一)
  function latestRunOfKind(kind) {
    const runs = store.runs.filter(r => r.kind === kind);
    if (!runs.length) return null;
    return runs.reduce((a, b) => (runSeq(b.runId) > runSeq(a.runId) ? b : a));
  }

  // ───────── 接口实现 ─────────

  /**
   * 获取当前状态快照(深拷贝)
   * 修改返回对象不影响内部 store(验收断言 1)
   */
  function getState() {
    return deepClone(store);
  }

  /**
   * 订阅状态变化,返回取消订阅函数
   * @param {Function} listener - 回调,参数为变更后的状态快照
   * @returns {Function} 取消订阅函数
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * 重置数据集相关状态(上传新数据时调用)
   * 清空数据层与结果层,保留 chatHistory;contextRev 递增
   */
  function resetDataset() {
    store = {
      context: {
        sessionId: null,
        fileName: null,
        unitId: null,
        cycle: null,
        predictionConfig: null,
        contextRev: store.context.contextRev + 1,
        scenarioRev: null,
      },
      data: { overview: null, qualityReport: null, unitIds: [] },
      prediction: null,
      draft: null,
      appliedScenario: null,
      candidates: [],
      runs: [],
      backtest: null,
      chatHistory: [], // S06:换数据清对话记录(施工单:清预测/决策/候选/回测/对话/会话记录)
      messages: [],    // 换数据清空会话消息流(新数据从空白会话开始)
    };
    notify();
  }

  /**
   * 更新上下文(部分合并,contextRev 递增)
   * @param {Object} partial - 待合并的上下文字段
   */
  function setContext(partial) {
    Object.assign(store.context, partial);
    store.context.contextRev++;
    notify();
  }

  /**
   * 设置数据层(上传成功后调用,配合 resetDataset 完成原子替换)
   * @param {Object} data - { overview, qualityReport, unitIds }
   */
  function setData(data) {
    store.data = {
      overview: deepClone(data.overview),
      qualityReport: deepClone(data.qualityReport),
      unitIds: deepClone(data.unitIds || []),
    };
    notify();
  }

  /**
   * 设置草稿参数(仅更新 draft,不影响已有运行的 snapshot)
   * 验收断言 2:编辑表单不动运行快照
   * @param {Object} params - 决策参数草稿 {cm,cd,cp,cc,alpha,h_max}
   */
  function setDraftParams(params) {
    store.draft = deepClone(params);
    notify();
  }

  /**
   * 开始一次运行,生成 runId 并记录输入快照
   * @param {string} kind - 运行类型:predict/decision/backtest/agent
   * @param {Object} snapshot - 输入快照(运行时的参数与上下文)
   * @returns {string} runId
   */
  function startRun(kind, snapshot) {
    const runId = genRunId();
    store.runs.push({
      runId: runId,
      kind: kind,
      status: 'running',
      snapshot: deepClone(snapshot),
      steps: [],
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    });
    pruneRuns(); // S17:运行保留策略(20 条摘要上限)
    notify();
    return runId;
  }

  /**
   * 更新运行记录(追加步骤、变更状态等)
   * @param {string} runId - 运行 ID
   * @param {Object} partial - 待合并字段(如 {steps: [...], status: '...'})
   */
  function updateRun(runId, partial) {
    const run = findRun(runId);
    if (!run) return;
    Object.assign(run, deepClone(partial));
    notify();
  }

  /**
   * 完成运行,记录结果并更新对应顶层状态
   * 防旧覆盖新:仅当该 run 是其 kind 的最新运行时,才更新顶层状态
   * 验收断言 3:旧版本结果不成为当前结果
   * @param {string} runId - 运行 ID
   * @param {Object} result - 运行结果
   */
  function finishRun(runId, result, options = {}) {
    const run = findRun(runId);
    if (!run) return;
    run.status = 'success';
    run.result = deepClone(result);
    run.finishedAt = Date.now();

    // 只有最新运行的 result 才写入顶层状态(防止乱序回包旧结果覆盖新结果)
    // archiveOnly:true 时只归档不更新顶层(S05 迟到回包防护)
    if (!options.archiveOnly) {
      const latest = latestRunOfKind(run.kind);
      if (latest && latest.runId === runId) {
        if (run.kind === 'predict') store.prediction = deepClone(result);
        if (run.kind === 'decision') store.appliedScenario = deepClone(result);
        if (run.kind === 'backtest') store.backtest = deepClone(result);
      }
    }
    pruneRuns(); // S17:完整结果保留最近 5 条,更早释放
    notify();
  }

  /**
   * 部分成功提交预测(S07:预测成功决策失败时保留带版本预测)
   * 仅当该 run 是其 kind 的最新运行时才写顶层(防旧覆盖新)
   * @param {string} runId - 运行 ID
   * @param {Object} prediction - 预测结果
   */
  function commitPrediction(runId, prediction) {
    const run = findRun(runId);
    if (!run) return;
    run.committedPrediction = true; // 标记预测已提交,供重试决策定位
    const latest = latestRunOfKind(run.kind);
    if (latest && latest.runId === runId) {
      store.prediction = deepClone(prediction);
    }
    notify();
  }

  /**
   * 运行失败,记录错误(不更新顶层状态)
   * @param {string} runId - 运行 ID
   * @param {Object} error - 错误信息 {code, message, detail}
   */
  function failRun(runId, error) {
    const run = findRun(runId);
    if (!run) return;
    run.status = 'error';
    run.error = deepClone(error);
    run.finishedAt = Date.now();
    notify();
  }

  /**
   * 应用方案,设置 scenarioRev
   * @param {Object} scenario - 已应用的方案
   */
  function applyScenario(scenario) {
    store.appliedScenario = deepClone(scenario);
    store.context.scenarioRev = (store.context.scenarioRev || 0) + 1;
    notify();
  }

  /**
   * 追加 Agent 对话历史(S08:绑定当前上下文版本,保留最近 20 条)
   * 每条消息记录 contextRev/scenarioRev,发送时按版本过滤(上下文变化后不携带旧历史)
   * @param {string} role - user/assistant
   * @param {string} content - 消息内容
   */
  function appendChat(role, content) {
    store.chatHistory.push({
      role: role,
      content: content,
      contextRev: store.context.contextRev,
      scenarioRev: store.context.scenarioRev,
    });
    if (store.chatHistory.length > 20) store.chatHistory.splice(0, store.chatHistory.length - 20);
    notify();
  }

  /**
   * 追加候选方案(S08:从 Agent 工具日志提取,绑定来源 runId 与版本)
   * @param {Array} items - 候选方案数组
   */
  function addCandidates(items) {
    if (!Array.isArray(items) || !items.length) return;
    store.candidates.push(...deepClone(items));
    notify();
  }

  /**
   * 运行保留策略(S17):
   * - runs 最多保留 20 条摘要(running 状态不移除);
   * - success 结果最多保留 5 条完整明细,更早的释放(result=null, released=true);
   * - 顶层 prediction/appliedScenario/backtest 单独持有,不受释放影响;
   * - 已释放标 released=true,供运行记录标"明细已释放",不可下载或应用。
   * 注:本方法不调用 notify,由调用方触发通知。
   */
  function pruneRuns() {
    // 1. 释放:success 且有 result 的 run,按 finishedAt 倒序保留最近 5 条
    const completed = store.runs
      .filter(r => r.status === 'success' && r.result != null && !r.released)
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    if (completed.length > 5) {
      const keepIds = new Set(completed.slice(0, 5).map(r => r.runId));
      completed.forEach(r => {
        if (!keepIds.has(r.runId)) {
          r.result = null;    // 释放大结果(不深拷贝,直接置空)
          r.released = true;  // 标"明细已释放"
        }
      });
    }
    // 2. 截断:runs 超 20 条,从最旧开始移除非 running(活跃运行不移除)
    while (store.runs.length > 20) {
      const idx = store.runs.findIndex(r => r.status !== 'running');
      if (idx === -1) break; // 全部 running,不再移除
      store.runs.splice(idx, 1);
    }
  }

  // ───────── 会话消息流(前端展示用,与 chatHistory 分离) ─────────

  // 消息 ID 计数器
  let msgCounter = 0;
  function genMsgId() {
    msgCounter++;
    return 'msg-' + Date.now() + '-' + msgCounter;
  }

  /**
   * 追加一条会话消息
   * @param {Object} msg - 消息对象 {type:'user'|'agent'|'system'|'card', ...}
   * @returns {string} 消息 ID
   */
  function addMessage(msg) {
    const m = deepClone(msg);
    m.id = m.id || genMsgId();
    m.ts = m.ts || Date.now();
    store.messages.push(m);
    // 上限 200 条,超出从最旧移除(防内存膨胀)
    if (store.messages.length > 200) store.messages.splice(0, store.messages.length - 200);
    notify();
    return m.id;
  }

  /**
   * 按 ID 更新会话消息(部分合并)
   * @param {string} id - 消息 ID
   * @param {Object} patch - 待合并字段
   */
  function updateMessage(id, patch) {
    const m = store.messages.find(x => x.id === id);
    if (!m) return;
    Object.assign(m, deepClone(patch));
    notify();
  }

  /**
   * 清空会话消息流(resetDataset 内部调用,也可单独调用)
   */
  function clearMessages() {
    store.messages = [];
    notify();
  }

  // ───────── 暴露接口(视图只能通过这些方法读写状态) ─────────
  return {
    getState,
    subscribe,
    resetDataset,
    setContext,
    setData,
    setDraftParams,
    startRun,
    updateRun,
    finishRun,
    commitPrediction,
    failRun,
    applyScenario,
    appendChat,
    addCandidates,
    addMessage,
    updateMessage,
    clearMessages,
  };
})();