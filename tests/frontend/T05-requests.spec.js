// S05 验收:统一请求锁、超时与迟到响应
// 覆盖:业务锁(10 次只发 1 次)、contextRev 迟到回包、停止等待、短超时恢复、健康独立锁、趋势去重
// 通过 page.route 拦截 + page.evaluate 调用 PO.requests 接口验证

const { test, expect } = require('@playwright/test');

test.describe('S05:统一请求锁、超时与迟到响应', () => {

  test('T05-1:同 key 连续触发 10 次只执行 1 次', async ({ page }) => {
    await page.goto('/static/index.html');
    let fetchCount = 0;
    await page.route('**/api/health', route => {
      fetchCount++;
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', service: 'PrognosOps' }) });
    });
    const results = await page.evaluate(async () => {
      const ctxRev = PO.getState().context.contextRev;
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(PO.requests.runTask('predict', { contextRev: ctxRev },
          (signal) => API.health({ signal }), { kind: 'predict' }));
      }
      return Promise.allSettled(promises);
    });
    // 9 个返回 null(锁占用),1 个真正执行
    const nulls = results.filter(r => r.status === 'fulfilled' && r.value === null).length;
    const executed = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
    expect(nulls).toBe(9);
    expect(executed).toBe(1);
    expect(fetchCount).toBe(1);
  });

  test('T05-2:contextRev 变化后迟到回包只归档不更新顶层', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/health', async route => {
      await new Promise(r => setTimeout(r, 400)); // 模拟慢响应
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', tag: 'stale-data' }) });
    });
    const result = await page.evaluate(async () => {
      const ctxRev = PO.getState().context.contextRev;
      const p = PO.requests.runTask('predict', { contextRev: ctxRev },
        (signal) => API.health({ signal }), { kind: 'predict' });
      // 在请求完成前改变 contextRev(模拟换数据/换设备)
      PO.setContext({ unitId: 99 });
      const r = await p;
      const s = PO.getState();
      return {
        stale: r.stale,
        prediction: s.prediction,
        runsCount: s.runs.length,
        lastRunStatus: s.runs[s.runs.length - 1] ? s.runs[s.runs.length - 1].status : null,
      };
    });
    expect(result.stale).toBe(true);
    expect(result.prediction).toBeNull(); // 顶层未更新
    expect(result.runsCount).toBe(1);     // 但已归档
    expect(result.lastRunStatus).toBe('success');
  });

  test('T05-3:stopWaiting 中止运行,文案为"停止等待"', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/health', async route => {
      await new Promise(r => setTimeout(r, 10000)); // 很慢,等中止
      try { await route.fulfill({ status: 200, body: '{}' }); } catch (_) {}
    });
    const result = await page.evaluate(async () => {
      const ctxRev = PO.getState().context.contextRev;
      const p = PO.requests.runTask('predict', { contextRev: ctxRev },
        (signal) => API.health({ signal }), { kind: 'predict' });
      // 获取当前 runId 并停止
      const runId = PO.requests.currentRunId('predict');
      const stopped = PO.requests.stopWaiting(runId);
      let err = null;
      try { await p; } catch (e) { err = e; }
      const s = PO.getState();
      const failedRun = s.runs.find(r => r.runId === runId);
      return {
        stopped, errMsg: err ? err.message : null, errKind: err ? err.kind : null,
        busyAfter: PO.requests.isBusy('predict'),
        runStatus: failedRun ? failedRun.status : null,
        runError: failedRun && failedRun.error ? failedRun.error.message : null,
      };
    });
    expect(result.stopped).toBe(true);
    expect(result.errMsg).toBe('停止等待');
    expect(result.errKind).toBe('aborted');
    expect(result.busyAfter).toBe(false); // 锁已释放
    expect(result.runStatus).toBe('error');
    expect(result.runError).toBe('停止等待');
  });

  test('T05-4:短超时后锁与运行状态恢复', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/health', async route => {
      await new Promise(r => setTimeout(r, 10000)); // 超过短超时
      try { await route.fulfill({ status: 200, body: '{}' }); } catch (_) {}
    });
    const result = await page.evaluate(async () => {
      const ctxRev = PO.getState().context.contextRev;
      let err = null;
      try {
        await PO.requests.runTask('predict', { contextRev: ctxRev },
          (signal) => API.health({ signal }), { kind: 'predict', timeout: 300 });
      } catch (e) { err = e; }
      const s = PO.getState();
      return {
        busyDuring: null, // 无法在运行中同步查询(已 await)
        busyAfter: PO.requests.isBusy('predict'),
        busyAny: PO.requests.isBusy(),
        errMsg: err ? err.message : null,
        errKind: err ? err.kind : null,
        runCount: s.runs.length,
      };
    });
    expect(result.errKind).toBe('timeout');
    expect(result.errMsg).toBe('停止等待');
    expect(result.busyAfter).toBe(false);
    expect(result.busyAny).toBe(false);
    expect(result.runCount).toBe(1);
  });

  test('T05-5:健康失败不阻塞分析(独立锁)', async ({ page }) => {
    await page.goto('/static/index.html');
    await page.route('**/api/health', route => {
      route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ detail: '服务不可用' }) });
    });
    const result = await page.evaluate(async () => {
      // 健康检查失败
      let healthErr = null;
      try {
        await PO.requests.runTask('health', {}, (signal) => API.health({ signal }), { kind: 'health' });
      } catch (e) { healthErr = e; }
      // 健康失败后,分析锁不受影响
      return {
        healthErrMsg: healthErr ? healthErr.message : null,
        busyHealth: PO.requests.isBusy('health'),
        busyPredict: PO.requests.isBusy('predict'),
        busyAny: PO.requests.isBusy(),
      };
    });
    expect(result.healthErrMsg).toContain('服务不可用');
    expect(result.busyHealth).toBe(false);
    expect(result.busyPredict).toBe(false);
    expect(result.busyAny).toBe(false);
  });

  test('T05-6:趋势读取按 key 去重,3 次调用只发 1 次请求', async ({ page }) => {
    await page.goto('/static/index.html');
    let fetchCount = 0;
    await page.route('**/api/data/sensor-trend**', route => {
      fetchCount++;
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ session_id: 's1', unit_id: 1, cycles: [1], sensor_names: ['s1'], sensor_data: {} }) });
    });
    const results = await page.evaluate(async () => {
      const fn = () => API.sensorTrend('s1', 1);
      const [a, b, c] = await Promise.all([
        PO.requests.deduped('trend:s1:1', fn),
        PO.requests.deduped('trend:s1:1', fn),
        PO.requests.deduped('trend:s1:1', fn),
      ]);
      return { a, b, c };
    });
    expect(fetchCount).toBe(1);
    expect(results.a.session_id).toBe('s1');
    expect(results.b.session_id).toBe('s1');
    expect(results.c.session_id).toBe('s1');
    // 去重完成后,新的调用会重新发请求
    await page.evaluate(async () => {
      await PO.requests.deduped('trend:s1:1', () => API.sensorTrend('s1', 1));
    });
    expect(fetchCount).toBe(2);
  });

});