/* ═══════════════════════════════════════════════
   PrognosOps 决策参数校验(parameters.js)
   职责:校验 cm/cd/cp/cc/alpha,剔除 NaN/Infinity/非法数字,
         空值与 0 分开,保留 random_seed=0
   挂载:window.PO.parameters
   ═══════════════════════════════════════════════ */
window.PO.parameters = (() => {
  'use strict';

  // 决策参数字段规则(S07):cm/cp/cc>0、cd≥0、0<alpha≤1
  const FIELDS = [
    { key: 'cm',    rule: v => v > 0,            msg: 'cm 必须大于 0' },
    { key: 'cd',    rule: v => v >= 0,           msg: 'cd 不能为负数' },
    { key: 'cp',    rule: v => v > 0,            msg: 'cp 必须大于 0' },
    { key: 'cc',    rule: v => v > 0,            msg: 'cc 必须大于 0' },
    { key: 'alpha', rule: v => v > 0 && v <= 1,  msg: 'alpha 必须在 (0, 1] 范围内' },
  ];

  /**
   * 校验决策参数,返回 { valid, params, fieldErrors }
   * - 空值(null/undefined/''/纯空白)与 0 分开:空值报"不能为空",0 参与数值规则
   * - 剔除 NaN/Infinity/非法数字(如 "12abc" → Number() 为 NaN)
   * - random_seed 保留 0(0 是合法种子值)
   * @param {Object} raw - 原始输入(值可为 string/number)
   * @returns {{ valid:boolean, params:Object, fieldErrors:Array<{field,message}> }}
   */
  function validate(raw) {
    const fieldErrors = [];
    const params = {};
    for (const f of FIELDS) {
      const rawVal = raw[f.key];
      // 空值与 0 分开:空值报错,0 进入数值规则
      if (rawVal === null || rawVal === undefined || (typeof rawVal === 'string' && rawVal.trim() === '')) {
        fieldErrors.push({ field: f.key, message: `${f.key} 不能为空` });
        continue;
      }
      const num = Number(rawVal);
      if (!Number.isFinite(num)) { // 剔除 NaN/Infinity/非法数字
        fieldErrors.push({ field: f.key, message: `${f.key} 不是有效数字` });
        continue;
      }
      if (!f.rule(num)) {
        fieldErrors.push({ field: f.key, message: f.msg });
        continue;
      }
      params[f.key] = num;
    }
    // random_seed:保留 0(不能用 falsy 判断跳过)
    if (raw.random_seed !== undefined && raw.random_seed !== null && !(typeof raw.random_seed === 'string' && raw.random_seed.trim() === '')) {
      const seed = Number(raw.random_seed);
      if (Number.isFinite(seed)) params.random_seed = seed;
    }
    return { valid: fieldErrors.length === 0, params, fieldErrors };
  }

  return { validate, FIELDS };
})();