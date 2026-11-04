/* ═══════════════════════════════════════════════
   PrognosOps 结果数据表(components/result-table.js)
   职责:分页表格(每页 50 行)、容器内横滚、长单元格折行;
         null/非有限值显示"不可计算",不得显示为 0;
         业务数值全部用 API 返回,不虚构
   挂载:window.PO.resultTable
   设计约束(施工单 S14):
   - 每页 50 行,仅挂当前页 DOM(1000 行不卡);
   - 横滚在容器内,不隐藏 body 溢出掩盖布局;
   - 长单元格折行,不截断;
   - null 指标显示 nullLabel(默认"不可计算")及原因,不显示 0。
   注:公共接线由 S17 合入,本组件仅提供 render 接口。
   ═══════════════════════════════════════════════ */
window.PO.resultTable = (() => {
  'use strict';

  const PAGE_SIZE = 50; // 每页 50 行(仅挂当前页)

  let currentRoot = null, currentColumns = [], currentRows = [];
  let currentPage = 1, currentNullLabel = '不可计算', currentNullReason = '';

  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  // 单元格值格式化:null/undefined/非有限值 → nullLabel(+原因),不得显示为 0
  function fmtCell(v) {
    if (v === null || v === undefined) {
      return currentNullReason
        ? '<span class="po-rt-null">' + esc(currentNullLabel) + '<span class="po-aux">(' + esc(currentNullReason) + ')</span></span>'
        : '<span class="po-rt-null">' + esc(currentNullLabel) + '</span>';
    }
    if (typeof v === 'number' && !isFinite(v)) {
      return '<span class="po-rt-null">' + esc(currentNullLabel) + '</span>';
    }
    if (typeof v === 'number') return esc(API.fmtNum(v, 4));
    return esc(String(v));
  }

  function draw() {
    if (!currentRoot) return;
    const totalRows = currentRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRows = currentRows.slice(start, start + PAGE_SIZE); // 仅当前页

    const thead = '<thead><tr>' + currentColumns.map(c =>
      '<th>' + esc(c.label) + '</th>'
    ).join('') + '</tr></thead>';

    const tbody = '<tbody>' + pageRows.map(row =>
      '<tr>' + currentColumns.map(c =>
        '<td class="po-rt-cell">' + fmtCell(row[c.key]) + '</td>'
      ).join('') + '</tr>'
    ).join('') + '</tbody>';

    // 分页信息(1-based 行号)
    const pageInfo = totalRows > 0
      ? '第 ' + (start + 1) + '-' + Math.min(start + PAGE_SIZE, totalRows) + ' 行 / 共 ' + totalRows + ' 行'
      : '无数据';
    const prevDisabled = currentPage <= 1 ? ' disabled' : '';
    const nextDisabled = currentPage >= totalPages ? ' disabled' : '';

    // 横滚在 .po-rt-scroll 容器内,长单元格折行(.po-rt-cell word-break)
    currentRoot.innerHTML = ''
      + '<div class="po-rt-scroll"><table class="po-table po-rt-table">' + thead + tbody + '</table></div>'
      + '<div class="po-rt-pager">'
      + '  <span class="po-aux">' + pageInfo + '</span>'
      + '  <button class="po-btn po-btn-secondary po-btn-sm po-rt-prev"' + prevDisabled + '>上一页</button>'
      + '  <span class="po-aux">' + currentPage + ' / ' + totalPages + '</span>'
      + '  <button class="po-btn po-btn-secondary po-btn-sm po-rt-next"' + nextDisabled + '>下一页</button>'
      + '</div>';

    const prevBtn = currentRoot.querySelector('.po-rt-prev');
    const nextBtn = currentRoot.querySelector('.po-rt-next');
    if (prevBtn) prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; draw(); } });
    if (nextBtn) nextBtn.addEventListener('click', () => { if (currentPage < totalPages) { currentPage++; draw(); } });
  }

  /**
   * 渲染分页数据表
   * @param {HTMLElement} root - 容器元素
   * @param {Object} config - { columns:[{key,label}], rows:[{key:value}], nullLabel?, nullReason? }
   */
  function render(root, config) {
    if (!root) return;
    currentRoot = root;
    currentColumns = (config && config.columns) || [];
    currentRows = (config && config.rows) || [];
    currentPage = 1;
    currentNullLabel = (config && config.nullLabel) || '不可计算';
    currentNullReason = (config && config.nullReason) || '';
    draw();
  }

  return { render };
})();