/**
 * PrognosOps API 封装层
 * 职责:统一调用后端 9 个端点、错误中文转换、加载状态管理
 * 所有响应字段名严格对应后端 app/domain/models.py 定义,不做任何猜测
 */
window.API = (() => {
  'use strict';

  // ───────── 错误码 → 中文描述映射 ─────────
  const ERROR_CN = {
    E1001: '数据格式错误',
    E1002: '文件超出大小限制',
    E2002: '资源不存在',
    E3001: 'RUL 计算失败',
    E3002: '特征提取失败',
    E4001: '决策参数无效',
    E4002: 'AI Agent 未配置模型 API',
    E4003: '模型 API 调用失败',
    E5001: '回测配置无效',
  };

  /**
   * 统一错误处理:将 fetch 响应归一化为 {kind, code, status, message, detail, fieldErrors}
   * detail 三态:数组(422 校验按 loc/msg 生成字段错误)/对象(业务错误 {code,message,detail})/字符串
   * 非 JSON 响应保留 HTTP 状态与非空中文摘要
   */
  async function handleResponse(res) {
    if (res.ok) return res;
    const err = { kind: 'http', code: '', status: res.status, message: `请求失败(HTTP ${res.status})`, detail: null, fieldErrors: [] };
    let rawText = '';
    try { rawText = await res.text(); } catch (_) { /* 无法读取响应体 */ }
    let body = null;
    if (rawText && rawText.trim()) {
      try { body = JSON.parse(rawText); }
      catch (_) { err.message += `:${rawText.trim().slice(0, 120)}`; } // 非 JSON:保留摘要
    }
    if (body !== null) {
      const d = body.detail;
      if (Array.isArray(d)) {
        // FastAPI 422 校验错误数组:按 loc/msg 生成字段错误
        err.kind = 'validation';
        err.message = `请求参数校验失败(HTTP ${res.status})`;
        err.detail = d;
        err.fieldErrors = d.map(item => ({
          field: Array.isArray(item.loc) ? item.loc.filter(p => typeof p === 'string').join('.') : '',
          message: item.msg || '校验失败',
        }));
      } else if (d && typeof d === 'object') {
        // 后端业务错误 {code, message, detail}
        err.kind = 'business';
        err.code = d.code || '';
        const cn = ERROR_CN[err.code];
        err.message = err.code
          ? (cn ? `[${err.code}] ${cn}${d.message ? ':' + d.message : ''}` : `[${err.code}] ${d.message || ''}`)
          : (d.message || err.message);
        err.detail = d.detail || null;
      } else if (typeof d === 'string') {
        err.message = d;
      }
    }
    throw err;
  }

  /** 网络/超时/停止等待统一包装为归一化错误对象 */
  async function request(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && typeof err === 'object' && 'kind' in err) throw err; // 已归一化
      if (err instanceof TypeError) {
        throw { kind: 'network', code: '', status: 0, message: '无法连接服务器,请检查网络连接后重试', detail: null, fieldErrors: [] };
      }
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw { kind: 'timeout', code: '', status: 0, message: '请求超时,请稍后重试', detail: null, fieldErrors: [] };
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw { kind: 'aborted', code: '', status: 0, message: '请求已取消', detail: null, fieldErrors: [] };
      }
      throw { kind: 'http', code: '', status: 0, message: (err && err.message) || '请求失败', detail: null, fieldErrors: [] };
    }
  }

  // ───────── 端点封装 ─────────

  /** GET /api/health → {status, service, version, message} */
  async function health(options = {}) {
    return request(async () => {
      const res = await fetch('/api/health', { signal: options.signal });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/data/upload (multipart/form-data, 字段名 file)
   * → UploadResponse {session_id, overview, quality_report}
   */
  async function uploadCsv(file, options = {}) {
    return request(async () => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/data/upload', { method: 'POST', body: fd, signal: options.signal });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * GET /api/data/sensor-trend?session_id=&unit_id=
   * → SensorTrendResponse {session_id, unit_id, cycles, sensor_names, sensor_data}
   */
  async function sensorTrend(sessionId, unitId, options = {}) {
    return request(async () => {
      const res = await fetch(`/api/data/sensor-trend?session_id=${encodeURIComponent(sessionId)}&unit_id=${unitId}`, { signal: options.signal });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/rul/predict
   * 请求:RULPredictRequest {session_id, unit_id, cycle?, k_nn?, h_max?, random_seed?, step?}
   * 响应:RULPredictResponse {session_id, unit_id, cycle, weibull, discrete, n_reference, assumptions}
   */
  async function rulPredict(payload, options = {}) {
    return request(async () => {
      const res = await fetch('/api/rul/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/decision/run
   * 请求:DecisionRunRequest {probs, params?, windows?, ieo_config?, use_cache?}
   * 响应:DecisionResult {params, windows, cost_curve, total_cost_curve, quality_curve,
   *   total_quality_curve, failure_prob_curve, expected_life_curve, strategies, ieo_traces, assumptions}
   */
  async function decisionRun(payload, options = {}) {
    return request(async () => {
      const res = await fetch('/api/decision/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/decision/regret
   * 请求:RegretRequest {strategy, chosen_window, true_rul?, params?, windows?}
   * 响应:RegretResult {strategy, true_rul, chosen_window, actual_cost, optimal_cost, regret}
   */
  async function decisionRegret(payload, options = {}) {
    return request(async () => {
      const res = await fetch('/api/decision/regret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/decision/failure-frequency
   * 请求:FailureFrequencyRequest {probs, windows?, h_max?}
   * 响应:FailureFrequencyResult {windows, failure_probs, h_max}
   */
  async function failureFrequency(payload, options = {}) {
    return request(async () => {
      const res = await fetch('/api/decision/failure-frequency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/backtest/run
   * 请求:BacktestRunRequest {session_id, config?}
   * 响应:BacktestResult {config, n_points, n_units, has_true_rul, nll_mean, nll_std,
   *   mae_mean, mae_std, strategies, eto_ieo_diff, sensitivity, points, repeat_metrics,
   *   assumptions, data_sufficiency_note}
   */
  async function backtestRun(payload, options = {}) {
    return request(async () => {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/backtest/export-csv → text/csv(PlainTextResponse)
   * 返回 CSV 文本字符串
   */
  async function backtestExportCsv(payload, options = {}) {
    return request(async () => {
      const res = await fetch('/api/backtest/export-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      return handleResponse(res).then(r => r.text());
    });
  }

  /**
   * POST /api/agent/chat
   * 请求:AgentChatRequest {session_id, query, unit_id?, cycle?, probs, h_max, current_params, history?}
   * 响应:AgentChatResponse {answer, tool_calls_log, model_used, n_rounds}
   *
   * 安全:API Key 仅在后端环境变量中,前端不持有;probs/params 由前端状态注入,
   *       后端工具执行真实计算,大模型不计算数值。
   */
  async function agentChat(payload, options = {}) {
    return request(async () => {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  // ───────── 工具函数(S20:旧页专属的 withLoading/showToast/showApiError/downloadText/downloadJson 已随旧页清理) ─────────

  /** 格式化数字:保留指定位数,极大/极小值用科学计数法 */
  function fmtNum(v, decimals = 4) {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    if (v !== 0 && (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-4)) {
      return v.toExponential(3);
    }
    return Number(v.toFixed(decimals)).toString();
  }

  /** 格式化百分比 */
  function fmtPct(v, decimals = 2) {
    if (v === null || v === undefined) return '—';
    return (v * 100).toFixed(decimals) + '%';
  }

  return {
    health, uploadCsv, sensorTrend, rulPredict,
    decisionRun, decisionRegret, failureFrequency,
    backtestRun, backtestExportCsv, agentChat,
    fmtNum, fmtPct,
  };
})();