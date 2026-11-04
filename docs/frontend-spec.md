# 前端重构规格 · 二轮

> agent 撰写。基于当前代码实测，非一轮文档的复述。
> 一轮已完成 11 项。本文只写还没对的部分，和整改过程中新引入的损伤。

---

## 一 · 账面

| 已完成 | 验证方式 |
|---|---|
| `body` / `h2` 边距归零 | 计算样式 `0px` |
| 令牌错名归位 | 圆角实测 `8px`，等宽字体生效 |
| 输入行坍陷修复 | textarea 实测 214px（原 26px） |
| 面板 16px 垂直节奏 | 父级 `gap` 接管 |
| 空态 46ch 限宽 | 单行不再断三行 |
| 右列不再被拉伸 | `align-items: start` 生效 |
| 顶栏 390px 单行 | `nowrap` + 导航横滚 |
| 占位文案去 S 编号 | 7 处已改中性表述 |
| 上下文栏竖分隔 | `border-left` 生效 |
| 图表容器控高 | `!important` 已移除 |
| 面板扁平化 | `data-area` 六处到位 |

| 待修 | 性质 |
|---|---|
| R1 字号被重置打穿 | 一轮引入的回归 |
| R2 行高被跨行面板撑断 | 一轮引入的回归 |
| P2-01 层级丢失 | 一轮执行时削掉 |
| P2-04 chip 密度 | 新发现，360px 栏里六块竖排成墙 |

---

## 二 · R1 · 字号被重置打穿

### 现象

| 元素 | 实测 | 契约 |
|---|---|---|
| `.po-nav-link` | 16px | 14px |
| `.po-suggestion-chip` | 16px | 12px |
| `.po-btn-accent` | 16px | 14px |
| `.po-btn-primary` | 14px | 14px |

### 成因

`tokens.css` 末尾那条重置：

```css
.po-app button, .po-app input, .po-app select, .po-app textarea { font: inherit; margin: 0; }
```

`.po-app button` 特异性 `(0,1,1)`，高于 `.po-btn` / `.po-nav-link` / `.po-suggestion-chip` 的 `(0,1,0)`。

`font` 是简写，`inherit` 把 `font-size` 一并展开为继承父级。组件类写的字号全部让位。

所以按钮字号实际等于父级字号。`.po-btn-primary` 显示 14px 只是因为它落在 `.po-empty`（14px）里，属于巧合；`.po-btn-accent` 落在 `#ws-ready` 里就变成 16px。**同一套按钮出现两个字号**，这是契约被击穿后的必然表现，不是偶发。

### 修复

特异性归零，组件类自然恢复优先。

```css
/* tokens.css 末尾，替换原重置中的表单条目 */
:where(.po-app) :is(button, input, select, textarea) {
  font: inherit;
  margin: 0;
}
```

同时把其余重置条目一并降权，避免同类问题复现：

```css
:where(.po-app) :is(h1, h2, h3, h4, p, figure, dl, dd) { margin: 0; }
:where(.po-app) :is(ul, ol) { margin: 0; padding: 0; list-style: none; }
:where(.po-app) :is(img, svg, canvas) { display: block; max-width: 100%; }
```

`.po-app { margin: 0 }` 保持原样，它作用于 `body`，不需要 `:where()`。

`font: inherit` 保留。它解决的是「按钮不继承字体族」这个真问题，只是不该带着特异性去碾压组件。

### 断言

```js
['.po-nav-link', 14], ['.po-suggestion-chip', 12], ['.po-btn-accent', 14], ['.po-btn-primary', 14]
```

---

## 三 · R2 · 行高被跨行面板撑断

### 现象

主操作面板底边 367px，结论面板顶边 550px。**中间空 183px**。

### 成因

`layout.css` 里：

```css
.po-panel[data-area="task"]     { grid-column: 2; grid-row: 1 / span 2; }
.po-panel[data-area="evidence"] { grid-column: 2; grid-row: 3 / span 2; }
```

实测 `grid-template-rows` = `410.667px 410.667px 251.333px 251.333px`。

跨两行的 `task` 高 845px，把第 1、2 行各撑到 410.667px。左列的 `op` 与 `concl` 各只有 251px，`align-items: start` 又让它们保持原高，于是每块下面空 159.667px，再加 24px `gap`，就是肉眼看到的 183px。

**`align-items: start` 与 `grid-row: span` 在这里互相拆台**：前者禁止拉伸，后者制造拉伸需求。同一行内两块面板高度差多大，空洞就多大。

### 判断

一轮把这条列为「可选」，是错的。两列布局下，网格行内元素共享行高是硬约束。要让左右两列各自独立堆叠，CSS 只有两条路：给每列一个容器，或用 float 双流。后者能同时满足 DOM 顺序契约，但 float 的清除与边距折叠在 6 个面板、2 处断点下不可控，不值得。

选容器。**用视觉正确性换读屏顺序偏好**，这个取舍成立：183px 空洞是每个用户都能看见的缺陷，DOM 顺序只影响 Tab 与朗读。

### 修复

保留 `data-area` 属性，只恢复容器与流式堆叠。

```css
/* layout.css：删除 @media 内这 6 条 [data-area] 定位，以及 grid-auto-rows */
```

```css
/* workspace-view.js 模板：op/concl/compare/candidates 外包一层，task/evidence 外包一层 */
+ '<div class="po-layout">'
+ '  <div class="po-main-area">'
+ '    <div class="po-panel" data-area="op">…</div>'
+ '    <div class="po-panel" data-area="concl">…</div>'
+ '    <div class="po-panel" data-area="compare">…</div>'
+ '    <div class="po-panel" data-area="candidates">…</div>'
+ '  </div>'
+ '  <aside class="po-task-area">'
+ '    <div class="po-panel" data-area="task">…</div>'
+ '    <div class="po-panel" data-area="evidence">…</div>'
+ '  </aside>'
+ '</div>'
```

`.po-main-area` / `.po-task-area` 已是 `flex column` + `gap: 24px` + `min-width: 0`，无需新增样式。`data-view.js:259` 的选择器 `[data-area="op"]` 继续可用，不用改。

`data-area` 属性留着，它是结构标记，无副作用，将来若要回网格还有抓手。

### 断言

```js
// 任意相邻两面板，垂直间距应严格等于 24px
const p = [...document.querySelectorAll('.po-page:not([hidden]) .po-layout .po-panel')];
const gaps = p.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - p[i].getBoundingClientRect().bottom));
// 期望：左列与右列各自全部为 24，无 183 这类异常值
```

---

## 四 · P2-01 · 层级丢失

一轮执行时把 `.po-stat-card` 的底色删掉了，现在 `background` 为 `none`。面板内只剩白底 + 1px 边线，三档层次退成一档。

面板阴影被契约锁死为 `none`，浮起感只能来自底色差。分组块不下沉，整个页面就是一张白纸。

```css
.po-stat-card, .po-trace-block, .po-sensor-mini,
.po-cand-card, .po-artifact-card, .po-rh-row {
  background: var(--po-subtle);
  border: 1px solid transparent;
  border-radius: var(--po-radius-control);
}
```

保留 `--po-subtle` 底色，不追加阴影，不加渐变。层次只有一档差值可用，别把它用两次。

---

## 五 · P2-04 · chip 密度

R1 修好后 chip 会从 37px 回落到约 26px。360px 栏宽里 6 个 chip 竖排仍要吃掉约 180px，把快捷提问做成了一面墙。

```css
.po-agent-suggestions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(146px, 1fr));
  gap: var(--po-space-2);
}
.po-suggestion-chip {
  text-align: center;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}
```

两列之后 6 个 chip 占三行，高度减半。`minmax(146px, 1fr)` 保证窄屏自动回单列，不需要额外断点。

---

## 六 · 验收

### 静态：令牌审计

`file://` 下 `document.styleSheets[].cssRules` 会抛 `SecurityError`，浏览器里跑脚本读不到规则，会得到一份「通过」的假报告。别用浏览器做令牌审计。项目根目录执行：

```bash
node -e "const fs=require('fs'),p='app/static/css/';const f=fs.readdirSync(p).filter(x=>x.endsWith('.css'));const t=f.map(x=>fs.readFileSync(p+x,'utf8')).join('\n');const d=new Set([...t.matchAll(/(--po-[\w-]+)\s*:/g)].map(m=>m[1]));const u=new Set([...t.matchAll(/var\(\s*(--po-[\w-]+)/g)].map(m=>m[1]));console.log('defined:',d.size,'used:',u.size,'undefined:',[...u].filter(v=>!d.has(v)))"
```

当前输出 `undefined: []`，53 定义 51 使用，这一项已通过。回归时它会重新长出内容。

### 动态：布局断言

```js
const cs = s => getComputedStyle(document.querySelector(s));

[
  ['body margin',        cs('body').margin,                    '0px'],
  ['panel title margin', cs('.po-panel-title').margin,         '0px'],
  ['panel radius',       cs('.po-panel').borderRadius,          '8px'],
  ['panel shadow',       cs('.po-panel').boxShadow,             'none'],
  ['layout align',       cs('.po-layout').alignItems,           'start'],
  ['nav font',           cs('.po-nav-link').fontSize,           '14px'],
  ['chip font',          cs('.po-suggestion-chip').fontSize,    '12px'],
  ['btn font',           cs('.po-btn-accent').fontSize,         '14px'],
  ['panel gap',          cs('.po-main-area').rowGap,            '24px'],
  ['stat card bg',       cs('.po-stat-card').backgroundColor,   'rgb(241, 245, 249)'],
  ['textarea',           document.querySelector('.po-agent-input-row .po-textarea').getBoundingClientRect().width > 200, true],
  ['no h-overflow',      document.documentElement.scrollWidth <= innerWidth, true],
].forEach(([k, got, want]) => console.log(got === want ? 'PASS' : 'FAIL', k, got, '≠', want));
```

### 视口

2040 / 1440 / 1180 / 768 / 390 五档。重点看两处：面板之间的垂直间距是否一律 24px，390px 顶栏是否仍是单行。

---

## 七 · 纪律

先 R1，再 R2。R1 是纯 CSS 一行改动，影响全站字号，必须先稳定下来再动结构。

R2 要改模板，改完重新截图，不许只看代码判断。上一轮的空洞就是这么来的：代码看着对，行高实测 `410.667px`。

P2 两条随时可做，互不依赖。

不动配色、字号阶梯、圆角档位、面板阴影。它们已是验收线。

不动后端。JS 只改模板字符串与选择器。

每阶段报三件事：改了哪些文件的哪些规则、断言输出、遗留项。
