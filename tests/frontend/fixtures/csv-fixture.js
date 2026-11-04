/**
 * S01 行为回归夹具:FD001 格式 CSV 生成器
 * 与 app/static/js/demo-data.js 格式严格一致(26 列,空格分隔,无表头)
 * 设备 ID 使用 101-105,与演示数据 1-5 不相交,确保上传后状态隔离可验证
 * 寿命缩短至 40-70 周期,加快真实管线处理速度,同时满足 ≥30 周期/单元要求
 */

// FD001 列定义(与 config/sensors.json 一致)
const ALL_COLUMNS = [
  'unit', 'cycle',
  'op_setting1', 'op_setting2', 'op_setting3',
  's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
  's12', 's13', 's14', 's15', 's16', 's17', 's18', 's19', 's20', 's21',
];
const CONSTANT = ['s1', 's5', 's6', 's10', 's16', 's18', 's19'];
const CONST_VALUES = {
  s1: 0.0002, s5: 14.62, s6: 21.61, s10: 1.03,
  s16: 0.02, s18: 100.0, s19: 39.04,
};

// 退化传感器基线/斜率/噪声(与 demo-data.js 相同结构,参数微调避免数据完全相同)
const SENSOR_PROFILES = {
  s2:  { base: 641.0,  slope: 0.32,  noise: 0.7 },
  s3:  { base: 1584.0, slope: 0.48,  noise: 1.8 },
  s4:  { base: 1401.0, slope: -0.38, noise: 1.4 },
  s7:  { base: 553.0,  slope: 0.14,  noise: 0.5 },
  s8:  { base: 2387.0, slope: 0.75,  noise: 2.8 },
  s9:  { base: 9059.0, slope: 2.80,  noise: 9.0 },
  s11: { base: 47.5,   slope: 0.018, noise: 0.09 },
  s12: { base: 521.0,  slope: 0.18,  noise: 0.45 },
  s13: { base: 2387.0, slope: 0.65,  noise: 1.9 },
  s14: { base: 8139.0, slope: -2.30, noise: 7.5 },
  s15: { base: 8.43,   slope: 0.004, noise: 0.028 },
  s17: { base: 391.0,  slope: 0.11,  noise: 0.38 },
  s20: { base: 38.1,   slope: 0.014, noise: 0.055 },
  s21: { base: 23.5,   slope: 0.009, noise: 0.048 },
};

// 夹具设备 ID 101-105(与 demo 1-5 不相交);寿命 40-70 周期(≥30)
const FIXTURE_UNIT_IDS = [101, 102, 103, 104, 105];
const FIXTURE_LIFESPANS = [48, 65, 40, 70, 55];

/** 确定性伪随机数生成器(mulberry32,与 demo-data.js 一致) */
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
 * 生成 FD001 格式 CSV 字符串(夹具版,unit 101-105)
 * @param {number} seed - 随机种子(固定则可复现)
 * @returns {string} CSV 文本(空格分隔,无表头,26 列)
 */
function generateFixtureCsv(seed = 777) {
  const rng = mulberry32(seed);
  const lines = [];
  for (let u = 0; u < FIXTURE_UNIT_IDS.length; u++) {
    const unitId = FIXTURE_UNIT_IDS[u];
    const lifespan = FIXTURE_LIFESPANS[u];
    const degFactor = 0.75 + rng() * 0.5; // 个体退化差异
    for (let cycle = 1; cycle <= lifespan; cycle++) {
      const row = new Array(26).fill(0);
      row[0] = unitId;
      row[1] = cycle;
      row[2] = (0.0001 + gauss(rng, 0.001)).toFixed(4);
      row[3] = (-0.0002 + gauss(rng, 0.001)).toFixed(4);
      row[4] = 100.0.toFixed(2);
      for (let col = 5; col < 26; col++) {
        const name = ALL_COLUMNS[col];
        if (CONSTANT.includes(name)) {
          row[col] = CONST_VALUES[name].toFixed(4);
        } else {
          const p = SENSOR_PROFILES[name];
          const val = p.base + p.slope * cycle * degFactor + gauss(rng, p.noise);
          row[col] = val.toFixed(4);
        }
      }
      lines.push(row.join(' '));
    }
  }
  return lines.join('\n');
}

/**
 * 生成夹具 CSV 并包装为 File 对象(供 setInputFiles 上传)
 * @param {number} seed - 随机种子
 * @param {string} fileName - 文件名(默认 fixture_train.csv)
 * @returns {File} CSV File 对象
 */
function generateFixtureFile(seed = 777, fileName = 'fixture_train.csv') {
  const csv = generateFixtureCsv(seed);
  const blob = new Blob([csv], { type: 'text/csv' });
  return new File([blob], fileName, { type: 'text/csv' });
}

/** 夹具元信息(供测试断言使用) */
function getFixtureInfo() {
  return {
    unitIds: FIXTURE_UNIT_IDS,
    lifespans: FIXTURE_LIFESPANS,
    totalRows: FIXTURE_LIFESPANS.reduce((a, b) => a + b, 0),
    unitCount: FIXTURE_UNIT_IDS.length,
  };
}

module.exports = { generateFixtureCsv, generateFixtureFile, getFixtureInfo };