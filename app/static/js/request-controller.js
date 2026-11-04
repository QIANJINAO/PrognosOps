/* ═══════════════════════════════════════════════
   PrognosOps 请求控制器(request-controller.js)
   职责:统一业务锁、集中超时、停止等待、迟到响应防护、趋势去重
   挂载:window.PO.requests
   依赖:state.js 的 PO.startRun/finishRun/failRun/getState
   ═══════════════════════════════════════════════ */
window.PO.requests = (() => {
  'use strict';

  // ───────── 集中超时配置(毫秒) ─────────
  const TIMEOUTS = {
    health: 10000,
    upload: 120000,
    predict: 180000,
    decision: 180000,
    agent: 180000,
    backtest: 600000,
  };

  // ───────── 内部状态 ─────────
  const locks = new Map();       // key -> runId(业务锁,await 前同步加锁)
  const controllers = new Map(); // runId -> AbortController(用于 stopWaiting)
  const dedupe = new Map();      // key -> Promise(趋势读取去重)

  /** 查询业务锁状态;无参时查全部 */
  function isBusy(key) {
    if (key === undefined) return locks.size > 0;
    return locks.has(key);
  }

  /**
   * 统一运行入口:加锁 → startRun → 超时控制 → 执行 → 回包校验 → finishRun/failRun → 解锁
   * @param {string} key - 业务锁键(upload/predict/decision/agent/backtest/health)
   * @param {object} snapshot - 运行快照(含 contextRev/scenarioRev 供回包校验)
   * @param {Function} execute - 异步执行函数,接收 AbortSignal
   * @param {object} [options] - { kind, timeout, signal: 外部信号 }
   * @returns {Promise<{stale:boolean,result}|null>} null=锁占用未执行
   */
  async function runTask(key, snapshot, execute, options = {}) {
    // 同步加锁(await 前),同 key 已有运行直接拒绝
    if (locks.has(key)) return null;
    const kind = options.kind || key;
    locks.set(key, true); // 先占锁:startRun 触发渲染时 isBusy 已为 true,按钮即时禁用
    let runId;
    try {
      runId = PO.startRun(kind, snapshot);
    } catch (e) {
      locks.delete(key); // startRun 失败,回滚锁
      throw e;
    }
    locks.set(key, runId);

    const controller = new AbortController();
    controllers.set(runId, controller);

    // 外部信号联动(如页面卸载)
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true });
    }

    // 集中超时
    const timeout = options.timeout !== undefined ? options.timeout : (TIMEOUTS[key] || 60000);
    const timer = setTimeout(() => {
      controller.abort(new DOMException('请求超时', 'TimeoutError'));
    }, timeout);

    try {
      const result = await execute(controller.signal);

      // ───────── 回包校验 ─────────
      // 1. contextRev 校验:快照记录的版本与当前不一致 → 只归档不更新
      const ctx = PO.getState().context;
      if (snapshot && snapshot.contextRev !== undefined && snapshot.contextRev !== ctx.contextRev) {
        PO.finishRun(runId, result, { archiveOnly: true }); // 迟到回包只归档不更新顶层
        return { runId, stale: true, result };
      }
      // 2. scenarioRev 校验(决策/回测场景)
      if (snapshot && snapshot.scenarioRev !== undefined && snapshot.scenarioRev !== ctx.scenarioRev) {
        PO.finishRun(runId, result, { archiveOnly: true });
        return { runId, stale: true, result };
      }
      // 3. runSeq 乱序防护由 finishRun 内部 latestRunOfKind 保证
      PO.finishRun(runId, result);
      return { runId, stale: false, result };
    } catch (err) {
      // 归一化错误对象:优先检查 signal 状态(不依赖 fetch 抛出 reason 的行为差异)
      let e;
      const reason = controller.signal.reason;
      const isTimeout = controller.signal.aborted && reason instanceof DOMException && reason.name === 'TimeoutError';
      const isAborted = controller.signal.aborted && (reason instanceof DOMException && reason.name === 'AbortError');
      if (isTimeout) {
        e = { kind: 'timeout', code: '', status: 0, message: '停止等待', detail: null, fieldErrors: [] };
      } else if (isAborted) {
        e = { kind: 'aborted', code: '', status: 0, message: '停止等待', detail: null, fieldErrors: [] };
      } else if (err && typeof err === 'object' && 'kind' in err) {
        e = err;
      } else {
        e = { kind: 'http', code: '', status: 0, message: (err && err.message) || String(err), detail: null, fieldErrors: [] };
      }
      PO.failRun(runId, e);
      throw e;
    } finally {
      clearTimeout(timer);
      controllers.delete(runId);
      // 只解除自己的锁,不解除其他运行的锁
      if (locks.get(key) === runId) locks.delete(key);
    }
  }

  /**
   * 停止等待:中止指定运行
   * @param {string} runId
   * @returns {boolean} 是否成功发出中止
   */
  function stopWaiting(runId) {
    const c = controllers.get(runId);
    if (!c) return false;
    c.abort(new DOMException('停止等待', 'AbortError'));
    return true;
  }

  /** 获取指定 key 当前运行的 runId(无运行返回 null) */
  function currentRunId(key) {
    return locks.get(key) || null;
  }

  /**
   * 趋势读取按 key 去重:同 key 并发请求共享同一 Promise
   * @param {string} key - 去重键(如 trend:{sessionId}:{unitId})
   * @param {Function} fn - 异步函数
   */
  async function deduped(key, fn) {
    if (dedupe.has(key)) return dedupe.get(key);
    const p = fn().finally(() => dedupe.delete(key));
    dedupe.set(key, p);
    return p;
  }

  return { runTask, stopWaiting, currentRunId, isBusy, deduped, TIMEOUTS };
})();