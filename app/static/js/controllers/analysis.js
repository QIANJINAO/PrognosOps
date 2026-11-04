/* ═══════════════════════════════════════════════
   PrognosOps 分析控制器(controllers/analysis.js)
   职责:统一预测—决策链,两步归属同一 runId;
         冻结输入快照,决策概率/参数与快照一致;
         预测成功决策失败保留带版本预测,可单独重试;
         上下文变化后不得复用;候选校验来源后重算
   挂载:window.PO.analysis
   依赖:state.js(PO)、request-controller.js(PO.requests)、
         parameters.js(PO.parameters)、api.js(API)
   ═══════════════════════════════════════════════ */
window.PO.analysis = (() => {
  'use strict';

  let activeRunId = null; // 链式运行锁(预测→决策同一 runId 期间占用)

  /** 冻结输入快照:上下文版本 + 决策参数草稿 */
  function freezeSnapshot() {
    const s = PO.getState();
    return {
      sessionId: s.context.sessionId,
      unitId: s.context.unitId,
      cycle: s.context.cycle,
      predictionConfig: s.context.predictionConfig,
      contextRev: s.context.contextRev,
      scenarioRev: s.context.scenarioRev,
      params: s.draft,
    };
  }

  /** 归一化校验错误 */
  function validationError(fieldErrors) {
    return { kind: 'validation', code: '', status: 0, message: '参数校验失败', detail: null, fieldErrors };
  }

  /**
   * 统一分析入口:冻结输入 → 预测 → 决策,两步归属同一 runId
   * 预测成功即提交顶层(带版本);决策失败保留预测可单独重试;
   * 上下文变化后迟到回包只归档不更新顶层
   * @param {Object} input - { sessionId, unitId, cycle?, k_nn?, random_seed?, params, useCache? }
   * @param {Function} [onStep] - 阶段回调 (name, status, data),name=predict|decision
   * @returns {Promise<{runId,stale,prediction,decision?,decisionError?}|null>} null=锁占用
   */
  async function runCurrent(input, onStep) {
    if (activeRunId) return null; // 链式锁

    // 参数校验(非法不发请求)
    const v = PO.parameters.validate(input.params || {});
    if (!v.valid) throw validationError(v.fieldErrors);

    const snapshot = freezeSnapshot();
    snapshot.params = v.params; // 校验后的参数写入快照(决策参数等于开始快照)

    activeRunId = true; // 先占链式锁:startRun 触发渲染时 isRunning 已为 true,按钮即时禁用
    let runId;
    try {
      runId = PO.startRun('predict', snapshot);
    } catch (e) {
      activeRunId = null;
      throw e;
    }
    activeRunId = runId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')),
      PO.requests.TIMEOUTS.predict || 180000);

    try {
      // ── 步骤 1:预测 ──
      onStep && onStep('predict', 'running');
      const predPayload = { session_id: input.sessionId, unit_id: input.unitId };
      if (input.cycle !== undefined && input.cycle !== null) predPayload.cycle = input.cycle;
      if (input.k_nn !== undefined && input.k_nn !== null) predPayload.k_nn = input.k_nn;
      if (input.random_seed !== undefined && input.random_seed !== null) predPayload.random_seed = input.random_seed;
      const pred = await API.rulPredict(predPayload, { signal: controller.signal });
      onStep && onStep('predict', 'success', pred);
      PO.updateRun(runId, { steps: [{ name: 'predict', status: 'success', at: Date.now() }] });
      PO.commitPrediction(runId, pred); // 预测成功即写顶层(带版本),决策失败也保留

      // 回包校验:上下文变化则中止链,只归档不更新顶层
      const ctx = PO.getState().context;
      if (snapshot.contextRev !== ctx.contextRev) {
        PO.finishRun(runId, pred, { archiveOnly: true });
        return { runId, stale: true, prediction: pred };
      }

      // ── 步骤 2:决策(用本次 probs/h_max,参数等于开始快照) ──
      onStep && onStep('decision', 'running');
      try {
        const decPayload = {
          probs: pred.discrete.probs,
          params: Object.assign({}, v.params, { h_max: pred.discrete.h_max }),
          use_cache: input.useCache !== undefined ? input.useCache : true,
        };
        const dec = await API.decisionRun(decPayload, { signal: controller.signal });
        onStep && onStep('decision', 'success', dec);
        PO.updateRun(runId, { decision: dec }); // 决策结果记入运行记录
        PO.finishRun(runId, pred); // kind=predict → 写顶层 prediction(与 commitPrediction 一致)
        PO.applyScenario(Object.assign({}, dec, { _runId: runId, _contextRev: snapshot.contextRev })); // 写 appliedScenario + scenarioRev 递增
        return { runId, stale: false, prediction: pred, decision: dec };
      } catch (decErr) {
        onStep && onStep('decision', 'error', decErr);
        // 决策失败:保留预测(已 commitPrediction),run 标记 error,可单独重试决策
        PO.failRun(runId, decErr);
        return { runId, stale: false, prediction: pred, decisionError: decErr };
      }
    } catch (predErr) {
      // 预测失败:不发决策,run 标记 error
      onStep && onStep('predict', 'error', predErr);
      PO.failRun(runId, predErr);
      throw predErr;
    } finally {
      clearTimeout(timer);
      activeRunId = null;
    }
  }

  /**
   * 单独重试决策:不重新预测,用已提交预测的 probs/h_max
   * 上下文变化后不得复用(contextRev 校验)
   * @param {Object} input - { params, useCache? }
   * @param {Function} [onStep]
   * @returns {Promise<{runId,decision}|null>} null=锁占用
   */
  async function retryDecision(input, onStep) {
    if (activeRunId) return null;
    const s = PO.getState();
    if (!s.prediction) {
      throw { kind: 'business', code: 'E4002', status: 0, message: '无可用预测,请先运行预测', detail: null, fieldErrors: [] };
    }
    // 定位最近提交过预测的 run,校验上下文版本(上下文变化后不得复用)
    const lastPredictRun = [...s.runs].reverse().find(r => r.kind === 'predict' && r.committedPrediction);
    if (!lastPredictRun || !lastPredictRun.snapshot || lastPredictRun.snapshot.contextRev !== s.context.contextRev) {
      throw { kind: 'business', code: 'E4003', status: 0, message: '上下文已变化,请重新运行预测', detail: null, fieldErrors: [] };
    }
    const v = PO.parameters.validate(input.params || {});
    if (!v.valid) throw validationError(v.fieldErrors);

    const pred = s.prediction;
    activeRunId = true; // 先占链式锁,理由同 runCurrent
    let runId;
    try {
      runId = PO.startRun('decision', { params: v.params, contextRev: s.context.contextRev, sourceRunId: lastPredictRun.runId });
    } catch (e) {
      activeRunId = null;
      throw e;
    }
    activeRunId = runId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')),
      PO.requests.TIMEOUTS.decision || 180000);
    try {
      onStep && onStep('decision', 'running');
      const decPayload = {
        probs: pred.discrete.probs,
        params: Object.assign({}, v.params, { h_max: pred.discrete.h_max }),
        use_cache: input.useCache !== undefined ? input.useCache : true,
      };
      const dec = await API.decisionRun(decPayload, { signal: controller.signal });
      onStep && onStep('decision', 'success', dec);
      PO.finishRun(runId, dec, { archiveOnly: true }); // 只归档,顶层由 applyScenario 写
      PO.applyScenario(Object.assign({}, dec, { _runId: runId, _contextRev: s.context.contextRev }));
      return { runId, decision: dec };
    } catch (err) {
      onStep && onStep('decision', 'error', err);
      PO.failRun(runId, err);
      throw err;
    } finally {
      clearTimeout(timer);
      activeRunId = null;
    }
  }

  /**
   * 应用候选方案:校验来源版本后重算完整决策,成功才提交
   * @param {Object} candidate - 候选方案(含 contextRev 绑定来源)
   * @param {Object} input - { params, useCache? }
   * @param {Function} [onStep]
   */
  async function applyCandidate(candidate, input, onStep) {
    const s = PO.getState();
    if (!candidate || candidate.contextRev !== s.context.contextRev) {
      throw { kind: 'business', code: 'E4004', status: 0, message: '候选方案来源版本与当前上下文不一致,无法应用', detail: null, fieldErrors: [] };
    }
    return retryDecision(input, onStep);
  }

  /** 当前链式运行是否进行中 */
  function isRunning() { return activeRunId !== null; }

  return { runCurrent, retryDecision, applyCandidate, isRunning };
})();