/* ═══════════════════════════════════════════════
   PrognosOps 产物列表(components/artifact-list.js)
   职责:为指定运行渲染下载卡(格式/来源/状态),
        缺数据禁用并说明,Agent 预览只标"仅预览"不伪装完整 CSV
   挂载:window.PO.artifactList
   依赖:state.js(PO)、export.js(PO.export)
   设计约束(施工单 S16):
   - render(root, run) 只接指定运行的不可变快照,不替换为当前结果;
   - 历史下载标明原来源(runId/kind/时间),下载内容来自该 run 的快照;
   - 回测缺 points → 禁用下载按钮并显示原因;
   - Agent content_preview → 标"仅预览",无"完整下载"入口;
   - Agent 完整 report → 标"Agent 报告快照",可下载;
   - 下载卡显示格式、来源与状态。
   公共接线(挂载位置)由 S17 合入,本模块仅提供 render 接口。
   ═══════════════════════════════════════════════ */
window.PO.artifactList = (() => {
  'use strict';

  // ───────── 工具 ─────────

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  /** 运行类型中文标签 */
  const KIND_LABEL = {
    predict: '维修决策',
    decision: '维修决策',
    backtest: '离线回测',
    agent: 'Agent 请求',
  };

  /** 格式中文标签 */
  const FORMAT_LABEL = { csv: 'CSV', json: 'JSON' };

  /** 产物描述(按运行类型) */
  function artifactLabel(run) {
    if (run.kind === 'backtest') return '回测逐时点结果';
    if (run.kind === 'predict' || run.kind === 'decision') return '决策完整结果';
    if (run.kind === 'agent') return 'Agent 报告快照';
    return '运行结果';
  }

  /** 来源描述:runId + 类型 + 完成时间 */
  function sourceText(run) {
    const kindLabel = KIND_LABEL[run.kind] || run.kind;
    const time = run.finishedAt ? new Date(run.finishedAt).toLocaleString('zh-CN') : '—';
    return kindLabel + ' · ' + run.runId + ' · ' + time;
  }

  // ───────── 下载卡渲染 ─────────

  /**
   * 渲染单个运行的下载卡
   * @param {HTMLElement} root - 挂载根元素
   * @param {Object} run - 运行记录(不可变快照,含 runId/kind/status/snapshot/result)
   */
  function render(root, run) {
    if (!root) return;
    root.innerHTML = '';

    // 无运行记录 → 空态
    if (!run) {
      root.innerHTML = '<div class="po-artifact-empty">尚无可导出的运行结果</div>';
      return;
    }

    const check = PO.export.checkExportable(run.runId);
    const format = check.formats[0] || '';
    const formatLabel = FORMAT_LABEL[format] || '—';

    // ── 卡片壳 ──
    const card = document.createElement('div');
    card.className = 'po-artifact-card';

    // 头部:产物名称 + 格式标签
    const head = document.createElement('div');
    head.className = 'po-artifact-head';
    head.innerHTML = ''
      + '<span class="po-artifact-name">' + esc(artifactLabel(run)) + '</span>'
      + '<span class="po-artifact-fmt">' + esc(formatLabel) + '</span>';
    card.appendChild(head);

    // 来源行:标明原来源,不替换为当前结果
    const src = document.createElement('div');
    src.className = 'po-artifact-source';
    src.textContent = '来源:' + sourceText(run);
    card.appendChild(src);

    // 状态区
    const statusArea = document.createElement('div');
    statusArea.className = 'po-artifact-status';

    if (check.available) {
      // 可下载:按钮 + 成功状态
      const btn = document.createElement('button');
      btn.className = 'po-btn po-btn-secondary po-artifact-btn';
      btn.textContent = '下载' + formatLabel;
      btn.addEventListener('click', () => {
        const r = PO.export.downloadRun(run.runId, format);
        if (!r.ok) {
          statusArea.textContent = '导出失败:' + (r.error || '未知错误');
          statusArea.classList.add('po-artifact-error');
        } else {
          statusArea.textContent = '已导出:' + r.filename;
          statusArea.classList.add('po-artifact-done');
        }
      });
      card.appendChild(btn);
      statusArea.textContent = '可导出(来自该次运行快照,不重新计算)';
      statusArea.classList.add('po-artifact-ready');
    } else {
      // 不可下载:原因说明
      statusArea.textContent = check.reason || '不可导出';
      statusArea.classList.add('po-artifact-disabled');

      // Agent content_preview → 标"仅预览",无下载入口
      if (check.agentExport && check.agentExport.type === 'preview') {
        const previewTag = document.createElement('div');
        previewTag.className = 'po-artifact-preview-tag';
        previewTag.textContent = '仅预览(content_preview 前 500 字符),不提供完整 CSV 下载';
        card.appendChild(previewTag);
      }
    }

    card.appendChild(statusArea);
    root.appendChild(card);
  }

  return { render };
})();