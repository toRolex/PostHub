---
name: PostHub
description: 多平台短视频发布的桌面中枢
colors:
  accent: "oklch(0.543 0.215 255)"
  accent-hover: "oklch(0.568 0.22 255)"
  accent-active: "oklch(0.494 0.196 255)"
  accent-ink: "oklch(0.418 0.17 258)"
  accent-tint: "oklch(0.955 0.02 255)"
  accent-tint-2: "oklch(0.91 0.05 255)"
  bg: "oklch(1 0 0)"
  surface: "oklch(0.966 0.0018 286)"
  surface-warm: "oklch(0.986 0.0013 286)"
  surface-sunk: "oklch(0.948 0.0022 286)"
  fg: "oklch(0.181 0.0028 300)"
  fg-2: "oklch(0.324 0.0035 300)"
  muted: "oklch(0.51 0.0045 300)"
  meta: "oklch(0.53 0.006 300)"
  border: "oklch(0.845 0.004 280)"
  border-soft: "oklch(0.92 0.0036 280)"
  success: "oklch(0.63 0.19 152)"
  success-tint: "oklch(0.953 0.03 152)"
  success-deep: "oklch(0.35 0.14 152)"
  warn: "oklch(0.577 0.15 64)"
  warn-tint: "oklch(0.965 0.028 75)"
  warn-deep: "oklch(0.4 0.12 64)"
  danger: "oklch(0.577 0.208 27)"
  danger-tint: "oklch(0.965 0.024 27)"
  danger-deep: "oklch(0.42 0.18 27)"
  info: "oklch(0.51 0.0045 300)"
  p-douyin: "oklch(0.176 0.013 270)"
  p-xhs: "oklch(0.61 0.26 15)"
  p-wechat: "oklch(0.72 0.19 155)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace"
    fontSize: "12px"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "6px 14px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-active:
    backgroundColor: "{colors.accent-active}"
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
    height: "34px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
    height: "34px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "7px 12px"
    height: "36px"
  chip:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
    height: "28px"
  switch-track:
    backgroundColor: "{colors.border}"
    rounded: "{rounded.pill}"
    width: "36px"
    height: "21px"
  card:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.lg}"
    padding: "16px"
  nav-item-active:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
---

# Design System: PostHub

> 正式值来源：`docs/prototypes/posthub-app.html`（2026-08-12 固化）补齐 DESIGN.md 空白；方向决策以本文件 + PRODUCT.md 为准，prototype 不越权覆盖。

## 1. Overview

**Creative North Star: "The Quiet Control Room"**

PostHub 是短视频创作者的发布控制室——一个安静、克制、可靠的面板，让「选素材、定平台、盯状态」三件事各自清晰，界面本身退到任务背后。以亮色为基底，Arc 浏览器的现代克制为姿态，落地为 Apple DS 语系（SF 系统字体栈 + Action Blue 单色 accent）：干净收边、低噪、不表演。密度为信息服务：任务列表、状态筛选、平台结果排布紧凑而有序，让创作者在深夜也能一眼读到「发没发、成没成、要不要人工介入」。

这套系统明确拒绝两种观感：Element Plus 默认企业后台的死板模板感，以及 SaaS 式玻璃拟态 / 渐变文字 / 大数字 hero 的花哨表演。

**Key Characteristics:**
- 克制：单一 accent、中性色占主体、无多余动效
- 状态优先：发布/任务/账号状态一眼可读，异常主动浮现
- 密度有序：紧凑的表格与列表，信息为操作服务
- 亮色现代：冷调近白基底 + 边框分层，阴影仅交互响应

## 2. Colors

亮色 + Restrained：冷调近白中性色为主体，单一 Apple Action Blue accent 用于主行动与状态指示，占比 ≤10%。全部为 OKLCH，原型逐值固化（见 frontmatter）。

### Primary
- **Action Blue**（oklch(0.543 0.215 255)）：主按钮、当前选中、发布中状态点。悬停变亮、按压变深，选中用 tint 浅底 + accent-ink 文字。

### Neutral
- **Cold White** 基底（oklch(1 0 0)）：内容区底，避免暖沙白 AI 默认
- **Surface 三档**：surface（0.966，hover 底）/ surface-warm（0.986，侧栏第二中性层）/ surface-sunk（0.948，输入框底）
- **Ink 三档**：fg（正文）/ fg-2（次级）/ muted（弱文本）/ meta（辅助，已从 Apple 默认加深至 ≥4.5:1 对比）
- **Border 两档**：border（控件描边）/ border-soft（分隔线）

### Semantic
低饱和状态色 + 浅底：success / warn（需人工、需重登）/ danger / info。状态点 + 标签组合，标签文字用同色加深档（非浅灰）。另备**深色档**（success-deep / warn-deep / danger-deep）用于深底反白语境（Toast、状态徽标），与浅色档同色相、降亮度。

### Platform（领域标识，限定使用）
- 抖音黑（0.176 0.013 270）、小红书红（0.61 0.26 15）、视频号绿（0.72 0.19 155）

**The Restrained Rule.** The accent appears on ≤10% of any given screen——只用于主行动、当前选中与状态指示，绝不用于装饰。中性色承担背景、文本、边框，亮度靠排版层级而非彩色填充。

**The Platform Mark Rule.** 平台品牌色只以 8px 色点出现；文字一律中性（视频号绿对比不足 4.5:1，文字落品牌色即失可读性）。

## 3. Typography

单一家族系统无衬线承担全部文本（product register：工具界面无需 display/body 配对）。固定 rem 阶梯，桌面工具密度。

### Hierarchy
- **Title**（600 / 20px / 1.4，letter-spacing -0.01em）：页面标题、区内主标题
- **Body**（400 / 14px / 1.55）：正文、列表内容；行宽 ≤75ch
- **Label**（500 / 13px）：表头、状态标签、按钮
- **Caption**（12px）：辅助、约束提示、时间
- **Mono**（12px，tabular-nums）：调试端口、用户名、时间戳、日志

**Character:** 中性、直接、紧凑；标题与正文靠字重与字号层级区分，不引入第二家族制造噪音。

## 4. Elevation

扁平默认 + 极轻分层：表面以 1px border-soft 分隔线 + surface 色阶区分层级，阴影不做默认表达。阴影仅作为交互响应出现，极轻三档：sm（hover 投影）/ md（下拉、浮层）/ lg（对话框、toast）。这与 Restrained 动效一致。

## 5. Components

### Buttons
- **Shape**：8px 圆角（rounded.md），min-height 34px，sm 28px / lg 40px
- **Primary**：Action Blue 底 + 白字 + shadow-sm；hover 变亮、active 变深
- **Secondary**：白底 + border 描边；ghost：透明 + fg-2 文字；danger：danger 文字 + tint hover
- **状态**：disabled 半透明；active 下压 0.5px；svg 图标内联 15px

### Chips（筛选）
- **Style**：pill 999px，surface-warm 底 + border-soft 描边 + fg-2 文字，28px 高
- **State**：active = accent-tint 底 + accent 描边 + accent-ink 文字；带 tabular-nums 计数

### Cards / Containers
- **Corner**：12px（rounded.lg），边框 1px border-soft，背景 bg
- **变体**：asset 素材卡（96×58 缩略图）、check-row 账号勾选行（selected = accent 描边 + tint 底）；**嵌套卡片禁止**

### Inputs / Fields
- **Style**：36px 高，border 描边 + bg 底，8px 圆角
- **Focus**：accent 描边 + 3px accent-tint 光晕环
- **Error / Disabled**：disabled 半透明；校验错误用 danger 描边

### Switch
36×21 pill，thumb 白 + shadow-sm；checked = accent 底、thumb 平移；focus-visible 2px accent outline

### Dialog
原生 `<dialog>`，rounded.lg + shadow-lg，backdrop 深灰 oklch(0.16 0.01 300 / 0.42)，宽 min(440px, 92vw)

### Status（签名组件）
语义色点 + 标签；publishing 带脉冲动画（1.6s ease-out）；异常态（manual / needs_relogin）任务行 tint 底高亮

### Toast
fg 底 + bg 字，语义变体用**深色档**（success-deep / warn-deep / danger-deep），shadow-lg，底部居中，自动消失

## 6. Do's and Don'ts

### Do:
- **Do** 用单一 accent 表达「主行动 / 当前选中 / 状态」三件事，其余一律中性色。
- **Do** 让异常状态（人工介入、需重新扫码、错过排期）一眼可读且主动浮现（nav badge、行高亮、置顶）。
- **Do** 保持表格与列表密度紧凑、行高一致，信息为操作服务。
- **Do** 动效克制在 150–220ms、只表达状态变化；支持 `prefers-reduced-motion`。
- **Do** 平台品牌色只做色点，文字不落品牌色（对比 ≥4.5:1 底线）。

### Don't:
- **Don't** 做 Element Plus 企业后台观感——死板、模板化、一眼「管理后台」。
- **Don't** 做 SaaS 花哨风——玻璃拟态、渐变文字、大数字 hero、重复的图标+标题+文本卡片。
- **Don't** 让发布流程显得复杂：主行动永远可辨认，排期与平台约束在需要时才展开。
- **Don't** 用彩色的非活动态：非选中、非异常的状态一律中性。
