/* ═══════════════════════════════════════════════
   PrognosOps 依据面板(components/evidence-panel.js)
   职责:收起态显示来源运行与上下文摘要;
         展开态首次建图(RUL 概率 + 成本曲线)与数据表;
         图表、表格、摘要绑定同次快照
   挂载:window.PO.evidencePanel
   依赖:result-table.js(PO.resultTable)
   设计约束(施工单 S14):
   - 首次展开才建图(懒加载),收起不销毁;
   - 反复展开收起不积累实例(contentBuilt 标记);
   - 卸载时销毁全部图表实例;
   - 图表与数据表取自同次快照,取值一致;
   - null 指标显示"不可计算",不显示 0。
   注:公共接线由 S17 合入,本组件仅提供 render/unmount 接口。
   ═══════════════════════════════════════════════ */
window.PO.evidencePanel = (() => {
  'use strict';

  let currentRoot = null, currentSnapshot = null;
  let expanded = false, contentBuilt = false;
  let chartInstances = []; // 本面板创建的 Chart 实例(卸载时销毁)

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  // ───────── 收起态:来源运行 + 上下文摘要 ─────────
  function drawCollapsed() {
    const snap = currentSnapshot || {};
    const run = snap.run || {};
    const ctx = snap.context || {};
    currentRoot.innerHTML = ''
      + '<div class="po-ev-header">'
      + '  <div class="po-ev-meta">'
      + '    <span class="po-badge po-badge-info">' + esc(run.kind || '运行') + '</span>'
      + '    <span class="po-ev-runid">' + esc(run.runId || '—') + '</span>'
      + '    <span class="po-aux">设备 ' + esc(String(ctx.unitId ?? '—'))
      + ' @ 周期 ' + esc(String(ctx.cycle ?? '—')) + '</span>'
      + '  </div>'
      + '  <button class="po-btn po-btn-secondary po-btn-sm po-ev-toggle">展开依据</button>'
      + '</div>';
    const btn = currentRoot.querySelector('.po-ev-toggle');
    if (btn) btn.addEventListener('click', toggle);
  }

  // 展开/收起切换:首次展开建内容,之后只切显隐(不积累实例)
  function toggle() {
    expanded = !expanded;
    if (expanded && !contentBuilt) {
      buildContent();
      contentBuilt = true;
    }
    const body = currentRoot.querySelector('.po-ev-body');
    if (body) body.hidden = !expanded;
    const btn = currentRoot.querySelector('.po-ev-toggle');
    if (btn) btn.textContent = expanded ? '收起依据' : '展开依据';
  }

  // ───────── 首次展开:图表 + 数据表(绑定同次快照) ─────────
  function buildContent() {
    const snap = currentSnapshot || {};
    const pred = snap.prediction;
    const dec = snap.decision;

    const body = document.createElement('div');
    body.className = 'po-ev-body';
    currentRoot.appendChild(body);

    // 图表区(RUL 概率 + 成本曲线,与数据表同源)
    const chartsWrap = document.createElement('div');
    chartsWrap.className = 'po-ev-charts';
    body.appendChild(chartsWrap);

    if (pred && pred.discrete && pred.discrete.probs) {
      const card = document.createElement('div');
      card.className = 'po-sensor-mini';
      card.innerHTML = '<div class="po-sensor-title">RUL 概率分布</div>';
      const canvas = document.createElement('canvas');
      card.appendChild(canvas);
      chartsWrap.appendChild(card);
      chartInstances.push(new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: Array.from({ length: pred.discrete.h_max + 1 }, (_, h) => h),
          datasets: [{ label: 'P(RUL = h)', data: pred.discrete.probs, backgroundColor: '#059669', borderWidth: 0.5 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { title: { display: true, text: '剩余使用寿命 h', font: { size: 10 } }, ticks: { maxTicksLimit: 12, font: { size: 9 } } },
            y: { title: { display: true, text: '概率', font: { size: 10 } }, beginAtZero: true },
          },
        },
      }));
    }

    if (dec && dec.windows && dec.total_cost_curve) {
      const card = document.createElement('div');
      card.className = 'po-sensor-mini';
      card.innerHTML = '<div class="po-sensor-title">维修窗口成本曲线</div>';
      const canvas = document.createElement('canvas');
      card.appendChild(canvas);
      chartsWrap.appendChild(card);
      chartInstances.push(new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: dec.windows,
          datasets: [{
            label: 'E[TC(z)] 期望总成本',
            data: dec.total_cost_curve,
            borderColor: '#0f172a', borderWidth: 2, pointRadius: 0, tension: 0.2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { title: { display: true, text: '维修窗口 z', font: { size: 10 } }, ticks: { maxTicksLimit: 12, font: { size: 9 } } },
            y: { title: { display: true, text: '期望总成本', font: { size: 10 } } },
          },
        },
      }));
    }

    // 数据表(与图表同次快照,取值一致)
    const tableWrap = document.createElement('div');
    tableWrap.className = 'po-ev-table';
    body.appendChild(tableWrap);
    const tableConfig = buildTableConfig(snap);
    if (tableConfig) {
      PO.resultTable.render(tableWrap, tableConfig);
    } else {
      tableWrap.innerHTML = '<div class="po-chart-empty">暂无结构化数据</div>';
    }
  }

  // 数据表配置:决策窗口表(与成本曲线图同源);无决策时回退 RUL 分布表
  function buildTableConfig(snap) {
    const dec = snap.decision;
    if (dec && dec.windows && dec.total_cost_curve) {
      return {
        columns: [
          { key: 'window', label: '维修窗口 z' },
          { key: 'total_cost', label: 'E[TC]' },
          { key: 'cost', label: 'E[C1]' },
          { key: 'fail_prob', label: '失效概率' },
          { key: 'expected_life', label: '期望寿命' },
        ],
        rows: dec.windows.map((w, i) => ({
          window: w,
          total_cost: dec.total_cost_curve[i],
          cost: dec.cost_curve ? dec.cost_curve[i] : null,
          fail_prob: dec.failure_prob_curve ? dec.failure_prob_curve[i] : null,
          expected_life: dec.expected_life_curve ? dec.expected_life_curve[i] : null,
        })),
        nullLabel: '不可计算',
        nullReason: '',
      };
    }
    const pred = snap.prediction;
    if (pred && pred.discrete && pred.discrete.probs) {
      return {
        columns: [
          { key: 'h', label: 'RUL h' },
          { key: 'prob', label: 'P(RUL=h)' },
        ],
        rows: pred.discrete.probs.map((p, h) => ({ h: h, prob: p })),
        nullLabel: '不可计算',
      };
    }
    return null;
  }

  // ───────── 接口 ─────────

  /**
   * 渲染依据面板(收起态)
   * @param {HTMLElement} root - 容器元素
   * @param {Object} snapshot - 同次快照 { run, prediction, decision, context }
   */
  function render(root, snapshot) {
    if (!root) return;
    unmount(); // 重渲染先清理旧实例
    currentRoot = root;
    currentSnapshot = snapshot;
    expanded = false;
    contentBuilt = false;
    drawCollapsed();
  }

  /** 卸载:销毁全部图表实例,重置状态 */
  function unmount() {
    chartInstances.forEach(c => { try { c.destroy(); } catch (_) { /* 已销毁 */ } });
    chartInstances = [];
    contentBuilt = false;
    expanded = false;
    currentRoot = null;
    currentSnapshot = null;
  }

  return { render, unmount };
})();