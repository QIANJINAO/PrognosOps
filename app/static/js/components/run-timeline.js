/* ═══════════════════════════════════════════════
   PrognosOps 运行时间线组件(components/run-timeline.js)
   职责:纵向步骤列表展示运行记录,每步含动作/状态/摘要/错误/折叠原始结果;
         只展示客户端实际启动与结束,不编造中间步骤
   挂载:window.PO.runTimeline
   设计约束(施工单 S12):
   - 固定链只展示客户端实际启动与结束的预测和决策;
   - Agent 请求期间只显示"请求中"与真实已耗时;
   - 完整回包后按 tool_calls_log 顺序显示记录;
   - 不得编造单工具耗时、假进度、未返回的工具或打字机输出;
   - HTTP 200 含工具错误时该条标失败;缺 result 标"无结构化结果";
   - JSON 默认折叠限高,键盘可展开。
   ═══════════════════════════════════════════════ */
window.PO.runTimeline = (() => {
  'use strict';

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  // 运行类型 → 中文动作名
  const KIND_LABEL = { predict: 'RUL 预测', decision: '维修决策', backtest: '离线回测', agent: 'Agent 请求' };

  // 真实耗时(秒,保留 1 位);running 时用当前时间,完成后用 finishedAt
  function elapsedLabel(run) {
    if (!run.startedAt) return '—';
    const end = run.finishedAt || Date.now();
    return ((end - run.startedAt) / 1000).toFixed(1) + 's';
  }

  // 工具参数摘要(k=v,空则"(无参数)")
  function toolArgsSummary(args) {
    const keys = Object.keys(args || {});
    if (!keys.length) return '(无参数)';
    return keys.map(k => esc(k) + '=' + esc(String(args[k]))).join(', ');
  }

  // 单步骤 HTML 模板
  function stepHtml(action, status, summary, cls, body) {
    return '<div class="po-timeline-step ' + cls + '">'
      + '<div class="po-step-marker"></div>'
      + '<div class="po-step-body">'
      + '<div class="po-step-header"><span class="po-step-action">' + action + '</span>'
      + '<span class="po-step-status">' + status + '</span></div>'
      + '<div class="po-step-summary">' + summary + '</div>'
      + body
      + '</div></div>';
  }

  // 单条工具调用 → 步骤 HTML(状态/摘要/错误/折叠原始结果)
  function toolCallStep(tc) {
    const hasError = !!(tc.result && tc.result.error);
    const noResult = !tc.result;
    const cls = hasError ? 'po-step-error' : (noResult ? 'po-step-warning' : 'po-step-success');
    const label = hasError ? '失败' : (noResult ? '无结构化结果' : '完成');
    let body = '';
    if (hasError) {
      body = '<div class="po-step-error-msg">' + esc(tc.result.message || '工具执行失败') + '</div>';
    } else if (noResult) {
      body = '<div class="po-step-error-msg">无结构化结果</div>';
    } else {
      // JSON 默认折叠限高,键盘可展开(details 原生支持 Enter/Space)
      body = '<details class="po-step-details"><summary>查看结构化结果</summary>'
        + '<pre class="po-step-json">' + esc(JSON.stringify(tc.result, null, 2)) + '</pre></details>';
    }
    return stepHtml(esc(tc.tool), label, toolArgsSummary(tc.args), cls, body);
  }

  // Agent 运行:running 只显示"请求中";success 按 tool_calls_log 顺序;error 显示错误
  function agentSteps(run) {
    if (run.status === 'running') {
      // 请求期间只显示"请求中"与真实已耗时,不编造步骤
      return stepHtml('Agent 请求', '请求中', '已耗时 ' + elapsedLabel(run), 'po-step-running', '');
    }
    if (run.status === 'error') {
      const msg = esc((run.error && run.error.message) || '请求失败');
      const detail = run.error ? '<details class="po-step-details"><summary>查看错误详情</summary>'
        + '<pre class="po-step-json">' + esc(JSON.stringify(run.error, null, 2)) + '</pre></details>' : '';
      return stepHtml('Agent 请求', '失败', msg, 'po-step-error', detail);
    }
    // success:按 tool_calls_log 顺序显示真实记录(不编造未返回的工具)
    const log = (run.result && run.result.tool_calls_log) || [];
    if (!log.length) {
      return stepHtml('Agent 请求', '完成', '无工具调用记录,总耗时 ' + elapsedLabel(run), 'po-step-success', '');
    }
    return log.map(toolCallStep).join('');
  }

  // 固定链(predict/decision/backtest):只展示实际启动与结束,不编造中间步骤
  function fixedChainSteps(run) {
    const label = esc(KIND_LABEL[run.kind] || run.kind);
    if (run.status === 'running') {
      return stepHtml(label, '进行中', '已耗时 ' + elapsedLabel(run), 'po-step-running', '');
    }
    if (run.status === 'error') {
      const msg = esc((run.error && run.error.message) || '运行失败');
      const detail = run.error ? '<details class="po-step-details"><summary>查看错误详情</summary>'
        + '<pre class="po-step-json">' + esc(JSON.stringify(run.error, null, 2)) + '</pre></details>' : '';
      return stepHtml(label, '失败', msg, 'po-step-error', detail);
    }
    const detail = run.result ? '<details class="po-step-details"><summary>查看原始结果</summary>'
      + '<pre class="po-step-json">' + esc(JSON.stringify(run.result, null, 2)) + '</pre></details>' : '';
    return stepHtml(label, '已完成', '总耗时 ' + elapsedLabel(run), 'po-step-success', detail);
  }

  /**
   * 渲染运行时间线到指定容器
   * @param {HTMLElement} root - 容器元素
   * @param {Object|null} run - 运行记录(PO.getState().runs 中的条目)
   */
  function render(root, run) {
    if (!root) return;
    if (!run) {
      root.innerHTML = '<div class="po-empty"><p>暂无运行记录</p></div>';
      return;
    }
    root.innerHTML = '<div class="po-timeline">'
      + (run.kind === 'agent' ? agentSteps(run) : fixedChainSteps(run))
      + '</div>';
  }

  return { render };
})();