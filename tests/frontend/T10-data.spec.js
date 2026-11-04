// S10 验收:合并导入与质量检查
// 覆盖:三种导入方式进入同一状态、空/超限/失败都有原因可重新选择同一文件、
//       阻断/无设备禁用分析给具体原因、进工作台后设备与数据集一致、运行中不得绕锁重复上传

const { test, expect } = require('@playwright/test');

const NEXT_PAGE = '/static/index.html';

// ───────── 辅助:构造上传成功响应(字段对应 UploadResponse / DataQualityReport) ─────────
function makeUploadResponse(sessionId, opts = {}) {
  const units = opts.units || [
    { unit_id: 1, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
    { unit_id: 2, cycle_count: 50, cycle_min: 1, cycle_max: 50, cycle_continuous: true, missing_cycles: [], meets_min_cycles: true },
  ];
  const totalRows = units.reduce((a, u) => a + u.cycle_count, 0);
  return {
    session_id: sessionId,
    overview: {
      total_rows: totalRows, unit_count: units.length, columns: 26, separator: ' ',
      units: units.map(u => ({ unit_id: u.unit_id, cycles: u.cycle_count })),
    },
    quality_report: {
      file_name: opts.fileName || 'test.csv',
      file_size_mb: 0.05, file_empty: false,
      total_rows: totalRows, total_columns: 26, unit_count: units.length,
      is_valid: opts.isValid !== false, has_critical: !!opts.hasCritical,
      column_mapping: {
        unit_column: 'unit', cycle_column: 'cycle',
        setting_columns: ['op_setting1', 'op_setting2', 'op_setting3'],
        selected_sensors: ['s2','s3','s4','s7','s8','s9','s11','s12','s13','s14','s15','s17','s20','s21'],
        missing_sensors: opts.missingSensors || [],
        constant_sensors: ['s1','s5','s6'],
        all_columns: [],
      },
      checks: opts.checks || [
        { name: '文件非空检查', passed: true, level: 'info', message: '文件包含有效数据', details: {} },
        { name: '列识别检查', passed: true, level: 'info', message: '成功识别单元列与周期列', details: {} },
      ],
      units: units,
      assumptions: ['合成数据,传感器含线性退化趋势'],
    },
  };
}

// 辅助:打开数据页并挂载 dataView(S10 公共入口由 S17 合入,测试手动 mount)
async function mountDataView(page) {
  await page.goto(NEXT_PAGE + '#/data');
  await page.evaluate(() => PO.dataView.mount(document.getElementById('page-data')));
}

test.describe('S10:合并导入与质量检查', () => {

  test('T10-1:三种导入方式进入同一状态,质量排序与四区渲染', async ({ page }) => {
    const resp = makeUploadResponse('sess-t10', {
      checks: [
        { name: '通过项A', passed: true, level: 'info', message: '正常', details: {} },
        { name: '警告项B', passed: false, level: 'warning', message: '单元 2 周期不连续', details: { unit: 2 } },
        { name: '通过项C', passed: true, level: 'info', message: '正常', details: {} },
      ],
    });
    await page.route('**/api/data/upload', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resp) });
    });

    // ── 方式 1:文件选择 ──
    await mountDataView(page);
    await page.setInputFiles('#dv-file-input', { name: 'select.csv', mimeType: 'text/csv', buffer: Buffer.from('test') });
    await expect(page.locator('#dv-status')).toContainText('上传成功');
    let s = await page.evaluate(() => PO.getState());
    expect(s.context.sessionId).toBe('sess-t10');
    expect(s.context.fileName).toBe('select.csv');
    expect(s.data.overview.unit_count).toBe(2);
    expect(s.data.unitIds).toEqual([1, 2]);
    expect(s.data.qualityReport.checks.length).toBe(3);

    // 质量排序:警告项排在通过项之前(阻断→警告→通过)
    const checkNames = await page.$$eval('.po-check-item .po-check-name', els => els.map(e => e.textContent));
    expect(checkNames).toEqual(['警告项B', '通过项A', '通过项C']);

    // 四区渲染:质量摘要卡片/设备表/字段映射/分析按钮
    await expect(page.locator('#dv-quality-body .po-stat-card').first()).toBeVisible();
    await expect(page.locator('#dv-units-body table')).toBeVisible();
    await expect(page.locator('#dv-mapping-body .po-mapping-row').first()).toBeVisible();
    await expect(page.locator('#dv-analyze-btn')).toBeVisible();

    // ── 方式 2:拖拽(drop 事件) ──
    await mountDataView(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['test'], 'dropped.csv', { type: 'text/csv' }));
      document.getElementById('dv-drop-zone')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#dv-status')).toContainText('上传成功');
    s = await page.evaluate(() => PO.getState());
    expect(s.context.sessionId).toBe('sess-t10');
    expect(s.context.fileName).toBe('dropped.csv');
    expect(s.data.unitIds).toEqual([1, 2]);

    // ── 方式 3:演示数据 ──
    await mountDataView(page);
    await page.click('#dv-demo-btn');
    await expect(page.locator('#dv-status')).toContainText('上传成功');
    s = await page.evaluate(() => PO.getState());
    expect(s.context.sessionId).toBe('sess-t10');
    expect(s.context.fileName).toBe('demo_train_seed42.csv');
    expect(s.data.unitIds).toEqual([1, 2]);
  });

  test('T10-2:空/超限/失败都有原因,可重新选择同一文件,长文件名完整显示', async ({ page }) => {
    let uploadCount = 0;
    await page.route('**/api/data/upload', async route => {
      uploadCount++;
      if (uploadCount <= 1) {
        // 首次:422 业务错误
        await route.fulfill({ status: 422, contentType: 'application/json',
          body: JSON.stringify({ detail: { code: 'E1001', message: '数据格式错误', detail: '无法解析第 1 行' } }) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(makeUploadResponse('sess-retry')) });
      }
    });
    await mountDataView(page);

    // 空文件:前端预校验,不发请求,给原因
    await page.setInputFiles('#dv-file-input', { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('') });
    await expect(page.locator('#dv-status')).toContainText('为空');
    expect(uploadCount).toBe(0);

    // 超 50MB:前端预校验,不发请求,给原因
    // (Playwright setInputFiles 有 50MB buffer 上限,改用浏览器内创建大文件 + drop 事件)
    await page.evaluate(() => {
      const big = new File([new Uint8Array(51 * 1024 * 1024)], 'big.csv', { type: 'text/csv' });
      const dt = new DataTransfer();
      dt.items.add(big);
      document.getElementById('dv-drop-zone')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#dv-status')).toContainText('超过 50MB');
    expect(uploadCount).toBe(0);

    // 上传失败(422):显示后端错误原因
    await page.setInputFiles('#dv-file-input', { name: 'fail.csv', mimeType: 'text/csv', buffer: Buffer.from('test') });
    await expect(page.locator('#dv-status')).toContainText('上传失败');
    await expect(page.locator('#dv-status')).toContainText('数据格式错误');
    expect(uploadCount).toBe(1);

    // 可重新选择同一文件:value 已清空,再次选择同一文件触发新请求
    const inputVal = await page.evaluate(() => document.getElementById('dv-file-input').value);
    expect(inputVal).toBe('');
    await page.setInputFiles('#dv-file-input', { name: 'fail.csv', mimeType: 'text/csv', buffer: Buffer.from('test') });
    await expect(page.locator('#dv-status')).toContainText('上传成功');
    expect(uploadCount).toBe(2);

    // 120 字符文件名完整显示(折行但不截断)
    const longName = 'a'.repeat(120) + '.csv';
    await page.setInputFiles('#dv-file-input', { name: longName, mimeType: 'text/csv', buffer: Buffer.from('test') });
    await expect(page.locator('#dv-status')).toContainText(longName);
  });

  test('T10-3:阻断/无设备禁用分析给原因,成功进工作台设备一致', async ({ page }) => {
    let resp = makeUploadResponse('sess-block', {
      isValid: false,
      checks: [
        { name: '缺失值检查', passed: false, level: 'error', message: '存在 15 个缺失值', details: { count: 15 } },
        { name: '文件非空检查', passed: true, level: 'info', message: 'ok', details: {} },
      ],
    });
    await page.route('**/api/data/upload', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resp) });
    });

    // ── 阻断错误:分析禁用 + 原因含检查名 ──
    await mountDataView(page);
    await page.setInputFiles('#dv-file-input', { name: 'blocked.csv', mimeType: 'text/csv', buffer: Buffer.from('test') });
    await expect(page.locator('#dv-analysis-action .po-error-banner')).toContainText('缺失值检查');
    await expect(page.locator('#dv-analyze-btn')).toHaveCount(0);

    // ── 无可用设备(周期不足):分析禁用 + 原因 ──
    resp = makeUploadResponse('sess-nounit', {
      units: [{ unit_id: 1, cycle_count: 10, cycle_min: 1, cycle_max: 10,
        cycle_continuous: true, missing_cycles: [], meets_min_cycles: false }],
      checks: [
        { name: '最低周期数检查', passed: false, level: 'warning', message: '单元 1 仅 10 周期', details: {} },
      ],
    });
    await mountDataView(page);
    await page.setInputFiles('#dv-file-input', { name: 'nounit.csv', mimeType: 'text/csv', buffer: Buffer.from('test') });
    await expect(page.locator('#dv-analysis-action .po-error-banner')).toContainText('无满足最低周期数');
    await expect(page.locator('#dv-analyze-btn')).toHaveCount(0);
    // 设备表显示"不足"徽标
    await expect(page.locator('#dv-units-body .po-badge-error').first()).toContainText('不足');

    // ── 成功:"分析当前设备"跳工作台,上下文一致 ──
    resp = makeUploadResponse('sess-ok');
    await mountDataView(page);
    await page.setInputFiles('#dv-file-input', { name: 'ok.csv', mimeType: 'text/csv', buffer: Buffer.from('test') });
    await expect(page.locator('#dv-analyze-btn')).toBeVisible();
    await expect(page.locator('#ctx-dataset')).toContainText('ok.csv');
    await page.click('#dv-analyze-btn');
    await expect(page.locator('#page-chat')).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe('#/chat');
    // 对话页侧栏上下文与数据页一致
    await expect(page.locator('#ctx-dataset')).toContainText('ok.csv');
  });

  test('T10-4:运行中不得绕锁重复上传', async ({ page }) => {
    let uploadCount = 0;
    const resp = makeUploadResponse('sess-lock');
    await page.route('**/api/data/upload', async route => {
      uploadCount++;
      await new Promise(r => setTimeout(r, 1500)); // 模拟慢上传
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resp) });
    });
    await mountDataView(page);

    // 触发演示上传
    await page.click('#dv-demo-btn');
    await expect(page.locator('#dv-status')).toContainText('正在上传');
    // 演示按钮已禁用
    expect(await page.evaluate(() => document.getElementById('dv-demo-btn').disabled)).toBe(true);

    // 上传中:拖拽另一文件(dispatchEvent 绕过 CSS pointer-events)
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['another'], 'another.csv', { type: 'text/csv' }));
      document.getElementById('dv-drop-zone')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    // 业务锁拦截,显示"上传进行中"
    await expect(page.locator('#dv-status')).toContainText('上传进行中');

    // 等待首个上传完成
    await expect(page.locator('#dv-status')).toContainText('上传成功', { timeout: 10000 });
    // 全程只有 1 次请求
    expect(uploadCount).toBe(1);
  });

});