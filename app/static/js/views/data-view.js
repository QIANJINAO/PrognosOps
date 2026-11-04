/* ═══════════════════════════════════════════════
   PrognosOps 数据与质量视图(data-view.js)
   职责:组织导入面板、质量摘要、设备表、字段映射;
         选择/拖拽/演示共用上传入口;质量排序与折叠;
         阻断/无设备禁用分析并给原因
   挂载:window.PO.dataView
   设计约束(施工单 S10):
   - 三种导入方式共用 uploadFile,经 PO.requests.runTask('upload') 业务锁;
   - 上传成功走 S06 原子替换(resetDataset → setData → setContext);
   - 质量结果按 阻断错误→警告→通过 排序,细节折叠;
   - 文件名/列名/后端说明按文本显示(esc),120 字符可折行;
   - 公共入口接线由 S17 合入(本文件只提供 mount/unmount)。
   ═══════════════════════════════════════════════ */
window.PO.dataView = (() => {
  'use strict';

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

  // HTML 转义:文件名/列名/后端说明一律按文本显示,防 XSS
  const _ESC_MAP = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => '&' + _ESC_MAP[c.charCodeAt(0)] + ';');

  let mounted = false;
  let rootEl = null;
  let unsubscribe = null;

  // ───────── DOM 工具 ─────────
  function el(id) { return document.getElementById(id); }

  // ═══════════════ 上传核心(选择/拖拽/演示共用入口) ═══════════════

  async function uploadFile(file) {
    if (PO.requests.isBusy('upload')) {
      setStatus('busy', '上传进行中,请等待当前上传完成');
      return;
    }
    if (!file) return;
    // 前端预校验:空文件
    if (file.size === 0) {
      setStatus('error', '文件 "' + file.name + '" 为空,请选择包含有效数据的文件');
      return;
    }
    // 前端预校验:50MB 限制
    if (file.size > MAX_FILE_SIZE) {
      const actualMb = (file.size / 1048576).toFixed(1);
      setStatus('error', '文件 "' + file.name + '" 超过 50MB 限制(实际 ' + actualMb + 'MB),请压缩或拆分后上传');
      return;
    }
    setStatus('uploading', file.name);
    try {
      // S06:与演示导入共用业务锁;失败抛错不调用 onUploadSuccess,保留原数据
      const r = await PO.requests.runTask('upload', {}, (signal) => API.uploadCsv(file, { signal }));
      if (!r) { setStatus('busy', '上传进行中,请等待当前上传完成'); return; }
      if (r.stale) return; // 迟到回包只归档,不更新视图
      onUploadSuccess(file.name, r.result);
    } catch (err) {
      // 归一化错误:补充 detail 与字段错误,给出具体原因
      let msg = '文件 "' + file.name + '" 上传失败:' + (err.message || '请求失败');
      if (err.detail) msg += '\n' + (typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail));
      if (err.fieldErrors && err.fieldErrors.length) {
        msg += '\n' + err.fieldErrors.map(fe => fe.field + ': ' + fe.message).join('; ');
      }
      setStatus('error', msg);
    }
  }

  function onUploadSuccess(fileName, resp) {
    // S06:原子替换——先清旧结果/对话/候选,再写新数据
    PO.resetDataset();
    PO.setData({
      overview: resp.overview,
      qualityReport: resp.quality_report,
      unitIds: (resp.overview.units || []).map(u => u.unit_id),
    });
    PO.setContext({ sessionId: resp.session_id, fileName: fileName });
    setStatus('success', fileName);
    renderAll(PO.getState());
  }

  // 演示数据:生成 File 后走统一上传入口
  function uploadDemo() {
    if (typeof DemoData === 'undefined') {
      setStatus('error', '演示数据模块未加载,请检查页面脚本引入');
      return;
    }
    uploadFile(DemoData.generateFile(42));
  }

  // ═══════════════ 状态显示 ═══════════════

  function setStatus(status, info) {
    const bar = el('dv-status');
    if (!bar) return;
    bar.className = 'po-status-bar po-status-' + status;
    if (status === 'uploading') bar.textContent = '正在上传 "' + info + '"…';
    else if (status === 'success') bar.textContent = '上传成功:' + info;
    else bar.textContent = info; // error/busy 已含完整原因
    bar.hidden = false;
    // 上传中禁用导入区交互,其余状态恢复
    const dropZone = el('dv-drop-zone');
    const demoBtn = el('dv-demo-btn');
    if (dropZone) dropZone.classList.toggle('po-drop-disabled', status === 'uploading');
    if (demoBtn) demoBtn.disabled = (status === 'uploading');
  }

  // ═══════════════ 质量排序:阻断错误→警告→通过 ═══════════════

  function sortChecks(checks) {
    const blocking = [], warnings = [], passed = [];
    for (const c of checks || []) {
      if (c.passed) { passed.push(c); }
      else if (c.level === 'critical' || c.level === 'error') { blocking.push(c); }
      else { warnings.push(c); }
    }
    return blocking.concat(warnings, passed);
  }

  // 分析阻断判定:阻断错误或无可用设备 → { blocked, reason }
  function getAnalysisBlocker(qr) {
    if (!qr) return { blocked: true, reason: '尚未导入数据,请先上传 CSV 文件或使用演示数据' };
    const blocker = (qr.checks || []).find(c => !c.passed && (c.level === 'critical' || c.level === 'error'));
    if (blocker) {
      return { blocked: true, reason: '存在阻断错误——' + blocker.name + ':' + blocker.message };
    }
    const available = (qr.units || []).filter(u => u.meets_min_cycles);
    if (!available.length) {
      return { blocked: true, reason: '无满足最低周期数(≥30)要求的设备单元,无法进行分析' };
    }
    return { blocked: false, reason: '' };
  }

  // ═══════════════ 渲染 ═══════════════

  function renderAll(s) {
    renderQuality(s);
    renderUnits(s);
    renderMapping(s);
    renderAnalysisAction(s);
  }

  // 质量摘要:摘要卡片 + 排序后的检查项(细节折叠)
  function renderQuality(s) {
    const panel = el('dv-quality-body');
    if (!panel) return;
    const qr = s.data.qualityReport;
    if (!qr) {
      panel.innerHTML = '<div class="po-empty"><p>尚未导入数据,质量摘要将在上传后显示</p></div>';
      return;
    }
    const cards = [
      { label: '总体判定', value: qr.is_valid ? '通过' : '未通过' },
      { label: '总行数', value: String(qr.total_rows) },
      { label: '设备单元数', value: String(qr.unit_count) },
      { label: '文件大小', value: (qr.file_size_mb != null ? qr.file_size_mb.toFixed(2) : '—') + ' MB' },
    ];
    const sorted = sortChecks(qr.checks);
    const checksHtml = sorted.map(c => {
      const badgeClass = c.passed ? 'po-badge-success'
        : (c.level === 'critical' || c.level === 'error') ? 'po-badge-error'
        : 'po-badge-warning';
      const badgeText = c.passed ? '通过' : c.level;
      const detailKeys = Object.keys(c.details || {});
      const detailsHtml = detailKeys.length
        ? '<details class="po-check-details"><summary>查看细节</summary>'
          + '<pre class="po-break-text">' + esc(JSON.stringify(c.details, null, 2)) + '</pre></details>'
        : '';
      return '<div class="po-check-item">'
        + '<div class="po-check-head"><span class="po-check-name">' + esc(c.name) + '</span>'
        + '<span class="po-badge ' + badgeClass + '">' + esc(badgeText) + '</span></div>'
        + '<div class="po-check-msg po-break-text">' + esc(c.message) + '</div>'
        + detailsHtml
        + '</div>';
    }).join('');
    panel.innerHTML =
      '<div class="po-stat-row">' + cards.map(c =>
        '<div class="po-stat-card"><span class="po-stat-label">' + esc(c.label) + '</span>'
        + '<span class="po-stat-value">' + esc(c.value) + '</span></div>'
      ).join('') + '</div>'
      + '<div style="margin-top:var(--po-space-4)">' + checksHtml + '</div>';
  }

  // 设备表:单元/周期数/周期范围/连续性/≥30周期
  function renderUnits(s) {
    const panel = el('dv-units-body');
    if (!panel) return;
    const qr = s.data.qualityReport;
    if (!qr || !qr.units || !qr.units.length) {
      panel.innerHTML = '<div class="po-empty"><p>暂无设备数据</p></div>';
      return;
    }
    const rows = qr.units.map(u => {
      const contBadge = u.cycle_continuous
        ? '<span class="po-badge po-badge-success">连续</span>'
        : '<span class="po-badge po-badge-warning">不连续</span>';
      const minBadge = u.meets_min_cycles
        ? '<span class="po-badge po-badge-success">满足</span>'
        : '<span class="po-badge po-badge-error">不足</span>';
      return '<tr>'
        + '<td class="po-num">' + esc(String(u.unit_id)) + '</td>'
        + '<td class="po-num">' + esc(String(u.cycle_count)) + '</td>'
        + '<td class="po-num">' + esc(u.cycle_min + ' ~ ' + u.cycle_max) + '</td>'
        + '<td>' + contBadge + '</td>'
        + '<td>' + minBadge + '</td>'
        + '</tr>';
    }).join('');
    panel.innerHTML = '<div class="po-table-scroll"><table class="po-table">'
      + '<thead><tr><th>单元</th><th>周期数</th><th>周期范围</th><th>连续性</th><th>≥30周期</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>';
  }

  // 字段映射:列识别结果,列名按文本折行显示
  function renderMapping(s) {
    const panel = el('dv-mapping-body');
    if (!panel) return;
    const qr = s.data.qualityReport;
    if (!qr || !qr.column_mapping) {
      panel.innerHTML = '<div class="po-empty"><p>尚未导入数据,字段映射将在上传后显示</p></div>';
      return;
    }
    const cm = qr.column_mapping;
    const rows = [
      { label: '单元列', value: cm.unit_column || '未识别' },
      { label: '周期列', value: cm.cycle_column || '未识别' },
      { label: '设定列', value: (cm.setting_columns || []).join(', ') || '无' },
      { label: '选定传感器', value: (cm.selected_sensors || []).join(', ') || '无' },
    ];
    if (cm.missing_sensors && cm.missing_sensors.length) {
      rows.push({ label: '缺失传感器', value: cm.missing_sensors.join(', ') });
    }
    if (cm.constant_sensors && cm.constant_sensors.length) {
      rows.push({ label: '常量传感器', value: cm.constant_sensors.join(', ') });
    }
    panel.innerHTML = rows.map(r =>
      '<div class="po-mapping-row">'
      + '<span class="po-mapping-label">' + esc(r.label) + ':</span>'
      + '<span class="po-mapping-value po-break-text">' + esc(r.value) + '</span>'
      + '</div>'
    ).join('');
  }

  // 分析操作:阻断→原因;成功→"分析当前设备"跳工作台
  function renderAnalysisAction(s) {
    const area = el('dv-analysis-action');
    if (!area) return;
    const blocker = getAnalysisBlocker(s.data.qualityReport);
    if (blocker.blocked) {
      area.innerHTML = '<div class="po-error-banner po-break-text">' + esc(blocker.reason) + '</div>';
    } else {
      area.innerHTML = '<button class="po-btn po-btn-accent" id="dv-analyze-btn">分析当前设备</button>';
      const btn = el('dv-analyze-btn');
      if (btn) btn.addEventListener('click', goToWorkspace);
    }
  }

  function goToWorkspace() {
    PO.router.navigate('chat');
    // 聚焦对话输入区(新架构:分析通过对话触发)
    requestAnimationFrame(() => {
      const input = document.querySelector('#chat-input');
      if (input) input.focus();
    });
  }

  // ═══════════════ 挂载/卸载 ═══════════════

  function mount(root) {
    if (mounted) return; // 防重复挂载
    mounted = true;
    rootEl = root;

    // 构建 DOM:主区(导入/质量/设备表) + 任务区(字段映射)
    rootEl.innerHTML = ''
      + '<div class="po-layout">'
      + '  <div class="po-main-area">'
      + '    <div class="po-panel">'
      + '      <h2 class="po-panel-title">数据导入</h2>'
      + '      <div id="dv-drop-zone" class="po-drop-zone" tabindex="0" role="button" aria-label="选择或拖拽 CSV 文件上传">'
      + '        <p>点击选择 CSV 文件,或将文件拖拽到此处</p>'
      + '        <p class="po-aux">最大 50MB,支持空格/逗号/制表符分隔,无表头</p>'
      + '      </div>'
      + '      <input type="file" id="dv-file-input" accept=".csv,.txt,text/csv" hidden>'
      + '      <div class="po-empty-actions" style="margin-top:var(--po-space-3)">'
      + '        <button class="po-btn po-btn-secondary" id="dv-demo-btn">使用演示数据</button>'
      + '      </div>'
      + '      <div id="dv-status" class="po-status-bar" hidden aria-live="polite"></div>'
      + '    </div>'
      + '    <div class="po-panel">'
      + '      <h2 class="po-panel-title">质量摘要</h2>'
      + '      <div id="dv-quality-body"></div>'
      + '      <div id="dv-analysis-action" class="po-analysis-action"></div>'
      + '    </div>'
      + '    <div class="po-panel">'
      + '      <h2 class="po-panel-title">设备表</h2>'
      + '      <div id="dv-units-body"></div>'
      + '    </div>'
      + '  </div>'
      + '  <aside class="po-task-area">'
      + '    <div class="po-panel">'
      + '      <h2 class="po-panel-title">字段映射</h2>'
      + '      <div id="dv-mapping-body"></div>'
      + '    </div>'
      + '  </aside>'
      + '</div>';

    // ── 事件绑定 ──
    const dropZone = el('dv-drop-zone');
    const fileInput = el('dv-file-input');
    const demoBtn = el('dv-demo-btn');

    // 点击/键盘 → 打开文件选择器
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });

    // 拖拽视觉反馈 + 放下上传
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('po-drop-active'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('po-drop-active'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('po-drop-active');
      if (e.dataTransfer && e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]);
    });

    // 文件选择:选后立即清 value,允许重新选择同一文件
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        fileInput.value = '';
        uploadFile(file);
      }
    });

    // 演示数据:与文件上传共用业务锁
    demoBtn.addEventListener('click', uploadDemo);

    // 订阅状态:切页/换数据后重新渲染(订阅常驻,unmount 时取消)
    unsubscribe = PO.subscribe(renderAll);
    renderAll(PO.getState());
  }

  function unmount() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (rootEl) rootEl.innerHTML = '';
    mounted = false;
    rootEl = null;
  }

  return { mount, unmount };
})();