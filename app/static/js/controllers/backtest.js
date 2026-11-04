/* ═══════════════════════════════════════════════
   PrognosOps 回测控制器(controllers/backtest.js)
   职责:绑定已应用方案参数与敏感性基点,统一回测运行入口
   挂载:window.PO.backtest
   依赖:state.js(PO)、request-controller.js(PO.requests)、api.js(API)
   设计约束(施工单 S15):
   - 无已应用方案时阻止回测(视图层给返回分析入口);
   - 显式注入 decision_params=已应用参数、unit_ids=[当前设备]、
     h_max=已应用方案 h_max、include_points=true(S16 免重算导出唯一来源);
   - 敏感性基点取已应用值,扫描 0.5/0.75/1/1.5/2 倍;
     alpha 剔除 >1 的值,重复值去重;
   - cd=0 等导致有效扫描值不足两项时不提交,由视图层要求输入合法值或关闭;
   - 保存完整 config/points 与运行快照(runTask 自动归档到 store.backtest);
   - 上下文/方案变化后迟到回包只归档不更新顶层(request-controller 双版本校验)。
   ═══════════════════════════════════════════════ */
window.PO.backtest = (() => {
  'use strict';

  // ───────── 常量 ─────────

  /** 敏感性扫描倍率(基点值的倍数) */
  const SENS_MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2];

  /** 支持敏感性扫描的参数名 */
  const SENS_PARAMS = ['cm', 'cd', 'cp', 'cc', 'alpha'];

  // ───────── 工具 ─────────

  /** 深拷贝(回测配置为纯数据,JSON 拷贝足够) */
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /** 浮点精度归一(6 位,避免 0.1*3=0.30000000000000004 类噪声) */
  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  // ───────── 敏感性扫描值生成 ─────────

  /**
   * 从已应用参数生成敏感性扫描值
   * - 基点取已应用值(不再用硬编码默认值,修复旧页缺陷);
   * - alpha 剔除 >1 的值(alpha ∈ (0,1]);
   * - cm/cp/cc 必须 >0,cd 允许 0(但 cd=0 会导致扫描全 0,去重后不足两项);
   * - 重复值去重(精度 6 位);
   * @param {string} param - 参数名(cm/cd/cp/cc/alpha)
   * @param {Object} appliedParams - 已应用决策参数
   * @returns {{values:number[], invalid:number[]}} 有效值与被剔除值(供 UI 标明)
   */
  function buildSensitivityValues(param, appliedParams) {
    const base = Number(appliedParams && appliedParams[param]);
    if (!isFinite(base)) return { values: [], invalid: [] };

    const all = SENS_MULTIPLIERS.map(m => round6(base * m));
    const invalid = [];
    const seen = new Set();
    const values = [];

    all.forEach(v => {
      // alpha 上界 1:剔除大于 1 的扫描值
      if (param === 'alpha' && v > 1) { invalid.push(v); return; }
      // cm/cp/cc 必须 > 0;cd 允许 0 但不允许负数
      if (param === 'cd' ? v < 0 : v <= 0) { invalid.push(v); return; }
      // 去重(cd=0 时 0.5×0..2×0 全为 0,去重后仅 [0])
      if (seen.has(v)) return;
      seen.add(v);
      values.push(v);
    });

    return { values, invalid };
  }

  // ───────── 配置构建(注入绑定字段) ─────────

  /**
   * 校验 UI 配置并注入 S15 绑定字段
   * @param {Object} uiConfig - 视图层构建的配置(模式/step/min_cycle/k_nn/
   *   n_repeats/random_seed/n_calibration_bins/sensitivity_param)
   * @param {Object} s - PO.getState()
   * @returns {{ok:boolean, config?:Object, error?:string,
   *            sensValues?:number[], sensInvalid?:number[]}}
   */
  function buildFullConfig(uiConfig, s) {
    const applied = s.appliedScenario;
    if (!applied || !applied.params) {
      return { ok: false, error: '尚未应用决策方案,无法绑定回测参数。请先在工作台完成分析并应用方案。' };
    }
    if (s.context.unitId == null) {
      return { ok: false, error: '尚未选择设备单元,无法绑定回测范围。' };
    }

    // 注入绑定字段:decision_params=已应用参数、unit_ids=[当前设备]、
    // h_max=已应用方案 h_max(顶层优先,params 兜底)、include_points=true(S16 强耦合)
    const hMax = applied.h_max != null ? applied.h_max
      : (applied.params && applied.params.h_max != null ? applied.params.h_max : 150);
    const config = Object.assign({}, uiConfig, {
      decision_params: clone(applied.params),
      unit_ids: [s.context.unitId],
      h_max: hMax,
      include_points: true,
    });

    // 敏感性分析:基点取已应用值
    if (config.sensitivity_param) {
      const sens = buildSensitivityValues(config.sensitivity_param, applied.params);
      if (sens.values.length < 2) {
        return {
          ok: false,
          error: '敏感性扫描有效值不足两项(基点 ' + config.sensitivity_param + '='
            + Number(applied.params[config.sensitivity_param]) + ' 去重/剔除后仅 '
            + sens.values.length + ' 项),请调整参数为合法值或关闭敏感性分析',
          sensValues: sens.values,
          sensInvalid: sens.invalid,
        };
      }
      config.sensitivity_values = sens.values;
    } else {
      delete config.sensitivity_param;
      delete config.sensitivity_values;
    }

    return { ok: true, config, sensValues: config.sensitivity_values || [], sensInvalid: [] };
  }

  // ───────── 统一运行入口 ─────────

  /**
   * 以已应用方案为基准运行回测
   * @param {Object} uiConfig - 视图层配置(不含绑定字段,由本函数注入)
   * @returns {Promise<{ok:boolean, stale?:boolean, result?:Object,
   *            runId?:string, error?:string, sensInvalid?:number[]}>}
   *          ok=false 时 error 为阻止原因;stale=true 表示迟到回包仅归档
   */
  async function runCurrent(uiConfig) {
    const s = PO.getState();
    const built = buildFullConfig(uiConfig, s);
    if (!built.ok) {
      return { ok: false, error: built.error, sensInvalid: built.sensInvalid || [] };
    }

    // 运行快照:含双版本号,回包时校验上下文/方案是否已变化
    const snapshot = {
      contextRev: s.context.contextRev,
      scenarioRev: s.context.scenarioRev,
      sessionId: s.context.sessionId,
      config: built.config,
    };

    const r = await PO.requests.runTask(
      'backtest',
      snapshot,
      (signal) => API.backtestRun(
        { session_id: s.context.sessionId, config: built.config },
        { signal }
      )
    );

    // null = 同 key 业务锁占用(回测已在运行)
    if (r === null) return { ok: false, error: '回测正在运行中,请稍候' };

    return { ok: true, stale: r.stale, result: r.result, runId: r.runId };
  }

  return { runCurrent, buildSensitivityValues, buildFullConfig, SENS_PARAMS, SENS_MULTIPLIERS };
})();