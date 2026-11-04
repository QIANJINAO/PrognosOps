// S04 验收:样式与表单基础
// 核对计算样式、对比度(文字≥4.5:1,边界/焦点≥3:1)、绿色仅表成功、旧页不受影响
// 通过 addStyleTag 加载新 CSS + 创建 .po-app 测试容器验证

const { test, expect } = require('@playwright/test');

// ───────── WCAG 对比度工具 ─────────
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
function luminance(r, g, b) {
  const c = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(hex1, hex2) {
  const l1 = luminance(...hexToRgb(hex1));
  const l2 = luminance(...hexToRgb(hex2));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// 施工单规定的色值
const C = {
  primary: '#0f172a', primaryHover: '#1e293b', accent: '#4338ca', accentSoft: '#eef2ff', focus: '#4f46e5',
  bg: '#f8fafc', surface: '#ffffff', subtle: '#f1f5f9', text: '#0f172a', secondary: '#475569', muted: '#64748b',
  border: '#e2e8f0', controlBorder: '#64748b',
  successFg: '#047857', successBg: '#ecfdf5', warningFg: '#92400e', warningBg: '#fffbeb',
  errorFg: '#b91c1c', errorBg: '#fef2f2', infoFg: '#1d4ed8', infoBg: '#eff6ff',
};

test.describe('S04:样式与表单基础', () => {

  // 辅助:默认页(S20 已切换为新页,含 tokens/components/layout/motion CSS)上创建测试容器
  async function setupPoApp(page) {
    await page.goto('/static/index.html');
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.className = 'po-app';
      div.id = 'po-test-root';
      div.innerHTML = `
        <h1 class="po-page-title" id="t-page-title">页标题</h1>
        <div class="po-number" id="t-number">42.5</div>
        <button class="po-btn po-btn-primary" id="t-btn-primary">主按钮</button>
        <button class="po-btn po-btn-secondary" id="t-btn-secondary">次按钮</button>
        <div class="po-field" id="t-field">
          <label class="po-field-label" id="t-label">标签</label>
          <input class="po-input" id="t-input" type="text" placeholder="请输入" />
          <span class="po-field-error" id="t-field-error">字段错误</span>
        </div>
        <input class="po-input" id="t-input-num" type="number" />
        <span class="po-badge po-badge-success" id="t-badge-success">成功</span>
        <span class="po-badge po-badge-error" id="t-badge-error">错误</span>
        <div class="po-panel" id="t-panel"><h2 class="po-panel-title" id="t-panel-title">面板标题</h2></div>
        <div class="po-empty" id="t-empty">暂无数据</div>
        <div class="po-table-scroll" id="t-table-scroll"><table class="po-table" id="t-table">
          <thead><tr><th>列</th></tr></thead><tbody><tr><td class="po-num">1</td></tr></tbody>
        </table></div>
        <div class="po-error-banner" id="t-error-banner">错误横幅</div>
      `;
      document.body.appendChild(div);
    });
  }

  test('T04-1:设计令牌计算样式核对', async ({ page }) => {
    await setupPoApp(page);
    const s = await page.evaluate(() => {
      const cs = id => { const el = document.getElementById(id); const c = getComputedStyle(el); return {
        fontSize: c.fontSize, lineHeight: c.lineHeight, minHeight: c.minHeight, borderRadius: c.borderRadius,
        width: c.width, fontWeight: c.fontWeight, fontFamily: c.fontFamily.slice(0, 30),
      }; };
      return {
        pageTitle: cs('t-page-title'), number: cs('t-number'),
        btnPrimary: cs('t-btn-primary'), input: cs('t-input'), inputNum: cs('t-input-num'),
        badge: cs('t-badge-success'), panel: cs('t-panel'), fieldError: cs('t-field-error'),
        label: cs('t-label'), panelTitle: cs('t-panel-title'), empty: cs('t-empty'),
      };
    });
    // 字号/行高
    expect(s.pageTitle.fontSize).toBe('24px');
    expect(s.pageTitle.lineHeight).toBe('32px');
    expect(s.number.fontSize).toBe('32px');
    expect(s.number.lineHeight).toBe('40px');
    expect(s.panelTitle.fontSize).toBe('18px');
    expect(s.panelTitle.lineHeight).toBe('26px');
    expect(s.input.fontSize).toBe('14px');
    expect(s.input.lineHeight).toBe('22px');
    expect(s.fieldError.fontSize).toBe('12px');
    expect(s.fieldError.lineHeight).toBe('18px');
    // 命中区 ≥44px
    expect(s.btnPrimary.minHeight).toBe('44px');
    expect(s.input.minHeight).toBe('44px');
    // 控件 width:100%
    expect(s.input.width).not.toBe('0px');
    // 圆角
    expect(s.btnPrimary.borderRadius).toBe('6px');
    expect(s.panel.borderRadius).toBe('8px');
    // 数字 tabular-nums + 等宽
    const numFont = await page.evaluate(() => getComputedStyle(document.getElementById('t-number')).fontVariantNumeric);
    expect(numFont).toContain('tabular-nums');
    expect(s.inputNum.fontFamily).toContain('Cascadia');
  });

  test('T04-2:文字对比度≥4.5:1', async () => {
    // 正文/次要/辅助文字在面板白底上的对比度
    expect(contrast(C.text, C.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.secondary, C.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.muted, C.surface)).toBeGreaterThanOrEqual(4.5);
    // 语义色文字在其背景上的对比度
    expect(contrast(C.successFg, C.successBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.warningFg, C.warningBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.errorFg, C.errorBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(C.infoFg, C.infoBg)).toBeGreaterThanOrEqual(4.5);
    // 主按钮白字在主色底
    expect(contrast('#ffffff', C.primary)).toBeGreaterThanOrEqual(4.5);
  });

  test('T04-3:边界与焦点对比度≥3:1', async () => {
    // 控件边框在白底上
    expect(contrast(C.controlBorder, C.surface)).toBeGreaterThanOrEqual(3);
    // 焦点轮廓在白底上
    expect(contrast(C.focus, C.surface)).toBeGreaterThanOrEqual(3);
    // 错误边框在白底上
    expect(contrast(C.errorFg, C.surface)).toBeGreaterThanOrEqual(3);
  });

  test('T04-4:绿色仅表成功,主色调为靛蓝', async () => {
    // accent 不是绿色系(而是 #4338ca 靛蓝)
    const [ar, ag, ab] = hexToRgb(C.accent);
    expect(ag).toBeLessThan(Math.max(ar, ab)); // 绿色通道不是最大
    // success 是绿色系
    const [sr, sg, sb] = hexToRgb(C.successFg);
    expect(sg).toBeGreaterThan(Math.max(sr, sb));
    // warning/error/info 都不是绿色系
    for (const hex of [C.warningFg, C.errorFg, C.infoFg]) {
      const [r, g, b] = hexToRgb(hex);
      expect(g).toBeLessThan(Math.max(r, b));
    }
  });

  test('T04-5:默认页含 tokens/components CSS,设计令牌可用', async ({ page }) => {
    // S20:默认页已切换为新页,验证 CSS 引用与令牌可用(原旧页不受影响断言随之更新)
    await page.goto('/static/index.html');
    const html = await page.content();
    expect(html).toContain('tokens.css');
    expect(html).toContain('components.css');
    // .po-app 令牌在默认页可用
    const tokenVal = await page.evaluate(() => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const v = getComputedStyle(el).getPropertyValue('--po-primary');
      el.remove();
      return v.trim();
    });
    expect(tokenVal).not.toBe('');
  });

  test('T04-6:焦点轮廓 2px offset 2px', async ({ page }) => {
    await setupPoApp(page);
    await page.focus('#t-input');
    const focusStyle = await page.evaluate(() => {
      const el = document.getElementById('t-input');
      const cs = getComputedStyle(el);
      return { outlineWidth: cs.outlineWidth, outlineOffset: cs.outlineOffset, outlineColor: cs.outlineColor };
    });
    expect(focusStyle.outlineWidth).toBe('2px');
    expect(focusStyle.outlineOffset).toBe('2px');
    expect(focusStyle.outlineColor).toContain('89, 199, 255'); // #59C7FF 冰蓝的 rgb 形式
  });

  test('T04-7:移动端输入 16px 防缩放,数字 28/36', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupPoApp(page);
    const s = await page.evaluate(() => ({
      input: getComputedStyle(document.getElementById('t-input')).fontSize,
      number: {
        size: getComputedStyle(document.getElementById('t-number')).fontSize,
        line: getComputedStyle(document.getElementById('t-number')).lineHeight,
      },
    }));
    expect(s.input).toBe('16px');
    expect(s.number.size).toBe('28px');
    expect(s.number.line).toBe('36px');
  });

});