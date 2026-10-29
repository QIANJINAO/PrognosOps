/**
 * PrognosOps API 封装层
 * 职责:统一调用后端 9 个端点、错误中文转换、加载状态管理
 * 所有响应字段名严格对应后端 app/domain/models.py 定义,不做任何猜测
 */
const API = (() => {
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
   * 统一错误处理:从 fetch 响应中提取后端错误信息并转为中文
   * 后端错误结构:{"detail": {"code": "Exxxx", "message": "...", "detail": "..."}}
   */
  async function handleResponse(res) {
    if (res.ok) return res;
    let errMsg = `请求失败(HTTP ${res.status})`;
    let errDetail = '';
    try {
      const body = await res.json();
      // FastAPI HTTPException 格式
      if (body.detail && typeof body.detail === 'object') {
        const code = body.detail.code || '';
        const prefix = ERROR_CN[code] ? `[${code}] ${ERROR_CN[code]}` : code;
        errMsg = prefix ? `${prefix}:${body.detail.message}` : body.detail.message;
        errDetail = body.detail.detail || '';
      } else if (body.detail && typeof body.detail === 'string') {
        errMsg = body.detail;
      }
    } catch (_) { /* 响应非 JSON,使用默认消息 */ }
    const err = new Error(errMsg);
    err.detail = errDetail;
    err.status = res.status;
    throw err;
  }

  /** 网络异常统一包装 */
  async function request(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error('无法连接服务器,请确认后端服务已启动(uvicorn app.main:app --port 8080)');
      }
      throw err;
    }
  }

  // ───────── 端点封装 ─────────

  /** GET /api/health → {status, service, version, message} */
  async function health() {
    return request(async () => {
      const res = await fetch('/api/health');
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/data/upload (multipart/form-data, 字段名 file)
   * → UploadResponse {session_id, overview, quality_report}
   */
  async function uploadCsv(file) {
    return request(async () => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/data/upload', { method: 'POST', body: fd });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * GET /api/data/sensor-trend?session_id=&unit_id=
   * → SensorTrendResponse {session_id, unit_id, cycles, sensor_names, sensor_data}
   */
  async function sensorTrend(sessionId, unitId) {
    return request(async () => {
      const res = await fetch(`/api/data/sensor-trend?session_id=${encodeURIComponent(sessionId)}&unit_id=${unitId}`);
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/rul/predict
   * 请求:RULPredictRequest {session_id, unit_id, cycle?, k_nn?, h_max?, random_seed?, step?}
   * 响应:RULPredictResponse {session_id, unit_id, cycle, weibull, discrete, n_reference, assumptions}
   */
  async function rulPredict(payload) {
    return request(async () => {
      const res = await fetch('/api/rul/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
  async function decisionRun(payload) {
    return request(async () => {
      const res = await fetch('/api/decision/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/decision/regret
   * 请求:RegretRequest {strategy, chosen_window, true_rul?, params?, windows?}
   * 响应:RegretResult {strategy, true_rul, chosen_window, actual_cost, optimal_cost, regret}
   */
  async function decisionRegret(payload) {
    return request(async () => {
      const res = await fetch('/api/decision/regret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/decision/failure-frequency
   * 请求:FailureFrequencyRequest {probs, windows?, h_max?}
   * 响应:FailureFrequencyResult {windows, failure_probs, h_max}
   */
  async function failureFrequency(payload) {
    return request(async () => {
      const res = await fetch('/api/decision/failure-frequency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
  async function backtestRun(payload) {
    return request(async () => {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  /**
   * POST /api/backtest/export-csv → text/csv(PlainTextResponse)
   * 返回 CSV 文本字符串
   */
  async function backtestExportCsv(payload) {
    return request(async () => {
      const res = await fetch('/api/backtest/export-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
  async function agentChat(payload) {
    return request(async () => {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return handleResponse(res).then(r => r.json());
    });
  }

  // ───────── 加载状态管理(禁止重复提交) ─────────

  /**
   * 包装按钮的异步操作:禁用按钮 + 显示加载指示 + 完成后恢复
   * @param {HTMLButtonElement} btn - 触发操作的按钮
   * @param {HTMLElement} loadingEl - 加载提示元素(hidden 切换)
   * @param {Function} asyncFn - 异步操作函数
   */
  async function withLoading(btn, loadingEl, asyncFn) {
    if (btn.disabled) return; // 防重复提交
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" class="h-4 w-4 animate-spin"></i>处理中...';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    if (loadingEl) loadingEl.classList.remove('hidden');
    try {
      return await asyncFn();
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  }

  // ───────── Toast 通知 ─────────

  /**
   * 显示 Toast 通知(自动消失)
   * @param {string} type - success / error / warning
   * @param {string} title - 标题
   * @param {string} msg - 消息内容
   */
  function showToast(type, title, msg) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconMap = { success: 'check-circle-2', error: 'alert-circle', warning: 'alert-triangle' };
    toast.innerHTML = `
      <i data-lucide="${iconMap[type] || 'info'}" class="h-5 w-5 shrink-0 mt-0.5"></i>
      <div>
        <div class="toast-title">${title}</div>
        ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
      </div>`;
    container.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    // 5 秒后自动移除
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  /** 显示 API 错误(中文) */
  function showApiError(err) {
    showToast('error', '操作失败', err.message + (err.detail ? `\n${err.detail}` : ''));
  }

  // ───────── 工具函数 ─────────

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

  /** 下载文本内容为文件 */
  function downloadText(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 下载 JSON 为文件 */
  function downloadJson(filename, obj) {
    downloadText(filename, JSON.stringify(obj, null, 2), 'application/json');
  }

  return {
    health, uploadCsv, sensorTrend, rulPredict,
    decisionRun, decisionRegret, failureFrequency,
    backtestRun, backtestExportCsv, agentChat,
    withLoading, showToast, showApiError,
    fmtNum, fmtPct, downloadText, downloadJson,
  };
})();