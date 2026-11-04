// S14 验收:修复图表与空值的误导展示
// 覆盖:s9/s15 独立小图可辨认+换序不换色、校准空态不画零柱+null"不可计算"、
//       1000 行仅挂当前页+表图取值一致、反复展开收起不积累实例

const { test, expect } = require('@playwright/test');
const FX = require('./fixtures/api-fixture');
const NEXT_PAGE = '/static/index.html';

test.describe('S14:修复图表与空值的误导展示', () => {

  test('T14-1:s9 与 s15 独立小图可辨认,换筛选顺序不换色', async ({ page }) => {
    await page.goto(NEXT_PAGE);

    // s9(大量级~9000)与 s15(小量级~8):不得叠到同一轴
    const cycles = Array.from({ length: 50 }, (_, i) => i + 1);
    const sensorData = {
      s9: cycles.map(c => 9000 + Math.sin(c / 10) * 500),
      s15: cycles.map(c => 8 + Math.cos(c / 10) * 3),
    };

    // 渲染 [s9, s15]
    await page.evaluate(({ cycles, sensorData }) => {
      const div = document.createElement('div');
      div.id = 'test-sensor';
      document.body.appendChild(div);
      Charts.sensorTrend('test-sensor', cycles, sensorData, ['s9', 's15']);
    }, { cycles, sensorData });

    // 两个独立 canvas(各图独立 y 轴,不叠同轴)
    expect(await page.locator('#test-sensor canvas').count()).toBe(2);
    // 各图标题可辨认
    await expect(page.locator('#test-sensor .po-sensor-title').first()).toContainText('s9');
    await expect(page.locator('#test-sensor .po-sensor-title').nth(1)).toContainText('s15');

    // 第一次渲染颜色:canvas[0]=s9, canvas[1]=s15
    const colors1 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#test-sensor canvas'))
        .map(c => Chart.getChart(c).data.datasets[0].borderColor);
    });

    // 换筛选顺序 [s15, s9]
    await page.evaluate(({ cycles, sensorData }) => {
      Charts.sensorTrend('test-sensor', cycles, sensorData, ['s15', 's9']);
    }, { cycles, sensorData });

    // 第二次渲染颜色:canvas[0]=s15, canvas[1]=s9
    const colors2 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#test-sensor canvas'))
        .map(c => Chart.getChart(c).data.datasets[0].borderColor);
    });

    // 同名同色:换序不换色
    expect(colors2[0]).toBe(colors1[1]); // s15 颜色不变
    expect(colors2[1]).toBe(colors1[0]); // s9 颜色不变
    // 两传感器颜色不同(可辨认)
    expect(colors1[0]).not.toBe(colors1[1]);
  });

  test('T14-2:无真值时校准不画零柱,null 指标显示"不可计算"不显示 0', async ({ page }) => {
    await page.goto(NEXT_PAGE);

    // 校准图:空 bins → 文字空态,不画假零柱
    await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.id = 'test-cal-wrap';
      wrap.innerHTML = '<canvas id="test-cal"></canvas>';
      document.body.appendChild(wrap);
      Charts.calibration('test-cal', [], 'ETO-C');
    });

    // 无 Chart 实例(不画零柱)
    const hasChart = await page.evaluate(() => !!Chart.getChart('test-cal'));
    expect(hasChart).toBe(false);
    // 文字空态可见
    await expect(page.locator('#test-cal-wrap .po-chart-empty')).toContainText('无真实 RUL');
    // canvas 隐藏
    await expect(page.locator('#test-cal')).toBeHidden();

    // null 指标:显示"不可计算"及原因,不显示 0
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.id = 'test-rt-null';
      document.body.appendChild(div);
      PO.resultTable.render(div, {
        columns: [{ key: 'name', label: '指标' }, { key: 'value', label: '值' }],
        rows: [
          { name: 'regret_mean', value: null },
          { name: 'mae_mean', value: 12.5 },
        ],
        nullLabel: '不可计算',
        nullReason: '无真实 RUL',
      });
    });
    await expect(page.locator('#test-rt-null .po-rt-null')).toContainText('不可计算');
    await expect(page.locator('#test-rt-null .po-rt-null')).toContainText('无真实 RUL');
    // regret 行不显示 0
    const regretCell = await page.locator('#test-rt-null tbody tr').first().locator('td').nth(1).textContent();
    expect(regretCell).not.toContain('0');
    // mae 行正常显示数值
    await expect(page.locator('#test-rt-null tbody tr').nth(1).locator('td').nth(1)).toContainText('12.5');
  });

  test('T14-3:1000 行仅挂当前页,表格与图表取值一致', async ({ page }) => {
    await page.goto(NEXT_PAGE);

    // 1000 行数据表:仅挂当前页 50 行
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.id = 'test-rt-1000';
      document.body.appendChild(div);
      const rows = Array.from({ length: 1000 }, (_, i) => ({ idx: i, value: (i + 1) * 1.5 }));
      PO.resultTable.render(div, {
        columns: [{ key: 'idx', label: '序号' }, { key: 'value', label: '值' }],
        rows: rows,
      });
    });
    expect(await page.locator('#test-rt-1000 tbody tr').count()).toBe(50);
    await expect(page.locator('#test-rt-1000 .po-rt-pager')).toContainText('1000');

    // 翻页:第二页仍 50 行,首行序号正确(0-based idx=50)
    await page.click('#test-rt-1000 .po-rt-next');
    await expect(page.locator('#test-rt-1000 tbody tr')).toHaveCount(50);
    const page2First = await page.locator('#test-rt-1000 tbody tr').first().locator('td').first().textContent();
    expect(Number(page2First)).toBe(50);

    // 依据面板:图表与数据表取自同次快照,取值一致
    const dec = FX.makeDecisionResponse();
    await page.evaluate((dec) => {
      const div = document.createElement('div');
      div.id = 'test-ev';
      document.body.appendChild(div);
      PO.evidencePanel.render(div, {
        run: { runId: 'run-t14', kind: 'decision' },
        prediction: null,
        decision: dec,
        context: { unitId: 1, cycle: 40 },
      });
      div.querySelector('.po-ev-toggle').click(); // 展开
    }, dec);

    // 图表数据(原始值)与表格首行(格式化值)一致
    const consistency = await page.evaluate(() => {
      const canvas = document.querySelector('#test-ev .po-ev-charts canvas');
      const chart = Chart.getChart(canvas);
      const chartFirst = chart.data.datasets[0].data[0]; // total_cost_curve[0]
      const tableFirst = document.querySelector('#test-ev .po-rt-table tbody tr').cells[1].textContent;
      return { chartFirst, tableFirst };
    });
    expect(Number(consistency.tableFirst)).toBeCloseTo(consistency.chartFirst, 1);
  });

  test('T14-4:反复展开收起不积累实例,卸载时销毁', async ({ page }) => {
    await page.goto(NEXT_PAGE);

    const dec = FX.makeDecisionResponse();
    const pred = FX.makeRULResponse('sess-t14', 1, 40);
    await page.evaluate(({ dec, pred }) => {
      const div = document.createElement('div');
      div.id = 'test-ev4';
      document.body.appendChild(div);
      PO.evidencePanel.render(div, {
        run: { runId: 'run-t14-4', kind: 'decision' },
        prediction: pred,
        decision: dec,
        context: { unitId: 1, cycle: 40 },
      });
    }, { dec, pred });

    const countCharts = () => page.evaluate(() => {
      return Array.from(document.querySelectorAll('#test-ev4 canvas'))
        .filter(c => Chart.getChart(c)).length;
    });

    // 收起态:0 实例(懒加载,首次展开才建图)
    expect(await countCharts()).toBe(0);

    // 展开:建图(RUL 概率 + 成本曲线 = 2 个)
    await page.click('#test-ev4 .po-ev-toggle');
    expect(await countCharts()).toBe(2);

    // 收起 → 展开 → 收起 → 展开:实例数不变(不积累)
    await page.click('#test-ev4 .po-ev-toggle'); // 收起
    await page.click('#test-ev4 .po-ev-toggle'); // 展开
    expect(await countCharts()).toBe(2);
    await page.click('#test-ev4 .po-ev-toggle'); // 收起
    await page.click('#test-ev4 .po-ev-toggle'); // 展开
    expect(await countCharts()).toBe(2);

    // 卸载:销毁全部实例
    await page.evaluate(() => PO.evidencePanel.unmount());
    expect(await countCharts()).toBe(0);
  });

});