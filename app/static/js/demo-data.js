/**
 * PrognosOps 演示数据生成器
 * 生成合成 NASA C-MAPSS FD001 格式 CSV(26 列,空格分隔,无表头)
 * 数据特点:5 个设备单元,14 个选定传感器含线性退化趋势 + 随机噪声
 * 生成的 CSV 通过后端 /api/data/upload 真实管线处理,所有结果均为真实计算
 */
const DemoData = (() => {
  'use strict';

  // FD001 列定义(与 config/sensors.json 一致)
  const ALL_COLUMNS = [
    'unit', 'cycle',
    'op_setting1', 'op_setting2', 'op_setting3',
    's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
    's12', 's13', 's14', 's15', 's16', 's17', 's18', 's19', 's20', 's21',
  ];
  const SELECTED = ['s2', 's3', 's4', 's7', 's8', 's9', 's11', 's12', 's13', 's14', 's15', 's17', 's20', 's21'];
  const CONSTANT = ['s1', 's5', 's6', 's10', 's16', 's18', 's19'];

  // 常量传感器的固定值(模拟 FD001 中方差为零的传感器)
  const CONST_VALUES = {
    s1: 0.0002, s5: 14.62, s6: 21.61, s10: 1.03,
    s16: 0.02, s18: 100.0, s19: 39.04,
  };

  // 14 个选定传感器的基线值与退化方向/速率(模拟涡扇发动机退化)
  // slope: 每周期变化量(有正有负,模拟真实传感器行为)
  const SENSOR_PROFILES = {
    s2:  { base: 642.0,  slope: 0.30,  noise: 0.8 },
    s3:  { base: 1585.0, slope: 0.50,  noise: 2.0 },
    s4:  { base: 1400.0, slope: -0.40, noise: 1.5 },
    s7:  { base: 554.0,  slope: 0.15,  noise: 0.6 },
    s8:  { base: 2388.0, slope: 0.80,  noise: 3.0 },
    s9:  { base: 9060.0, slope: 3.00,  noise: 10.0 },
    s11: { base: 47.0,   slope: 0.02,  noise: 0.1 },
    s12: { base: 522.0,  slope: 0.20,  noise: 0.5 },
    s13: { base: 2388.0, slope: 0.70,  noise: 2.0 },
    s14: { base: 8140.0, slope: -2.50, noise: 8.0 },
    s15: { base: 8.44,   slope: 0.005, noise: 0.03 },
    s17: { base: 392.0,  slope: 0.12,  noise: 0.4 },
    s20: { base: 38.0,   slope: 0.015, noise: 0.06 },
    s21: { base: 23.4,   slope: 0.010, noise: 0.05 },
  };

  // 每个单元的寿命(周期数)——多样化,使 kNN 参考集有区分度
  const UNIT_LIFESPANS = [128, 185, 96, 212, 154];

  /** 简易确定性伪随机数生成器(可复现) */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 高斯噪声(Box-Muller) */
  function gauss(rng, sigma) {
    const u1 = Math.max(rng(), 1e-10);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
  }

  /**
   * 生成 FD001 格式 CSV 字符串
   * @param {number} seed - 随机种子(固定则数据可复现)
   * @returns {string} CSV 文本(空格分隔,无表头,26 列)
   */
  function generateCsv(seed = 42) {
    const rng = mulberry32(seed);
    const lines = [];

    for (let u = 0; u < UNIT_LIFESPANS.length; u++) {
      const unitId = u + 1;
      const lifespan = UNIT_LIFESPANS[u];
      // 每个单元的退化速率系数(0.7~1.3 之间,模拟个体差异)
      const degFactor = 0.7 + rng() * 0.6;

      for (let cycle = 1; cycle <= lifespan; cycle++) {
        const progress = cycle / lifespan; // 0~1 退化进度
        const row = new Array(26).fill(0);

        // unit, cycle
        row[0] = unitId;
        row[1] = cycle;

        // 操作设定(FD001 单操作条件,接近常数 + 微小波动)
        row[2] = (0.0000 + gauss(rng, 0.001)).toFixed(4);
        row[3] = (-0.0001 + gauss(rng, 0.001)).toFixed(4);
        row[4] = 100.0.toFixed(2);

        // 传感器值
        for (let col = 5; col < 26; col++) {
          const name = ALL_COLUMNS[col];
          if (CONSTANT.includes(name)) {
            row[col] = CONST_VALUES[name].toFixed(4);
          } else {
            const p = SENSOR_PROFILES[name];
            // 退化量 = 基线 + 斜率 × 周期 × 退化系数 + 噪声
            const val = p.base + p.slope * cycle * degFactor + gauss(rng, p.noise);
            row[col] = val.toFixed(4);
          }
        }
        lines.push(row.join(' '));
      }
    }
    return lines.join('\n');
  }

  /** 生成 CSV 并包装为 File 对象(供 /api/data/upload 使用) */
  function generateFile(seed = 42) {
    const csv = generateCsv(seed);
    const blob = new Blob([csv], { type: 'text/csv' });
    const fileName = `demo_train_seed${seed}.csv`;
    return new File([blob], fileName, { type: 'text/csv' });
  }

  /** 获取演示数据的描述信息(供 UI 展示) */
  function getDescription() {
    const totalRows = UNIT_LIFESPANS.reduce((a, b) => a + b, 0);
    return {
      unitCount: UNIT_LIFESPANS.length,
      totalRows,
      lifespans: UNIT_LIFESPANS,
      note: '合成数据,传感器含线性退化趋势,通过后端真实管线处理',
    };
  }

  return { generateCsv, generateFile, getDescription };
})();