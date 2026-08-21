# ADR-0008: 平台内容声明按平台分键透传（不抽象统一键）

- **状态**：已批准（grill-with-docs 收口）
- **日期**：2026-08-21
- **范围**：执行规范，含代码。PostHub 任务级 `platform_fields.<platform>` JSON 子键的命名与透传边界。

## 背景

抖音/小红书/视频号三家平台在发布页都要求创作者选择「内容声明」类字段（视频号「添加声明」/ 抖音「自主声明」/ 小红书「添加内容类型声明」），用于合规标识（是否 AI 生成 / 是否虚构 / 是否实拍 / 是否营销 / 是否转载 / 是否个人观点）。

痛点：批量发布视频号视频时，平台默认预选「含 AI 生成内容」，social-auto-upload 上游 `tencent_uploader/main.py` 仅尝试回避项（无需声明/不声明/无），新 UI 文本「无需标注」不在候选内，预选保留 → 批量发布全部被打 AIGC 标签。

调研（详见 `docs/research/2026-08-21-three-platform-aigc-declaration-fields.md`，2026-08-21）发现三家 UI 字段名与候选文案**均不统一**：
- 视频号 8 选项（含「无需标注 / 含 AI 生成内容 / 内容为自行拍摄 / 添加拍摄时间和地点 / ...」）
- 抖音 6 选项（含「内容由 AI 生成 / 个人观点 / 虚构演绎 / 无需添加 / ...」）
- 小红书 4 选项（含「笔记含 AI 合成内容 / 内容来源声明 / ...」）

## 决策

### 决策一：按平台分键，不抽象成统一键

PostHub 任务级 `platform_fields` JSON 字段（ADR-0001 预留位）按 **CONTEXT.md glossary 已定义的平台命名** (`wechat` / `douyin` / `xiaohongshu`) 分键：

```json
{
  "wechat":       { "declaration": "no_label", "origin": true },
  "douyin":       { "declaration": "no_need" },
  "xiaohongshu":  { "source": "self_declare", "origin": true }
}
```

**不**抽象成统一键（如 `content_declaration`），理由：三家平台语义不对齐（视频号 `declaration` ≈ 抖音 `declaration` ≈ 小红书 `source`，但选项不重叠），强行统一会丢精度，且违背各平台法规要求的精确语义。

### 决策二：内部枚举 + 中文文案映射

PostHub 这层定义英文枚举值（`no_label` / `ai_generated` / `fictional` / ...），`daemon/sau_backend.py` 在调用 social-auto-upload 时映射成上游能识别的中文文案（如 `no_label → "无需标注"`）。

不直接让前端传中文文案的理由：UI 文案随平台版本变动，存英文枚举可避免持久化数据失效。

### 决策三：不 fork 上游（ADR-0006 延伸）

social-auto-upload 上游支持度（实测）：
- 抖音 `DouYinVideo.declaration` 已全链通（属性 + CLI `--declaration` + 单测）
- 视频号 `tencent_uploader/main.py:696` 候选列表不含「无需标注」—— PostHub wrapper 层做 DOM 兜底（命中候选失败时按枚举顺序强点）
- 小红书 `source` 字段上游零代码 —— PostHub DOM wrapper 层补

不向上游提 PR / 不 fork 上游源码（ADR-0006 约束），所有扩展在 PostHub 这层完成。

### 决策四：账号维度默认声明（解决批量痛点）

账号管理页增加「默认声明」配置入口；批量任务未在表单覆盖时使用账号默认。**关键开关**：解决「批量发布全部被预选 AI 生成」。

## 取舍

| 选项 | 选 | 不选 | 理由 |
|---|---|---|---|
| 统一键 vs 平台分键 | 平台分键 | 统一键 | 三家语义不对齐 |
| 英文枚举 vs 中文文案 | 英文枚举 | 中文文案 | UI 文案变动会让持久化数据失效 |
| 上游 PR vs PostHub wrapper | wrapper | PR | 不 fork 约束 + PR 合并周期不可控 |
| 任务粒度 vs 账号粒度 | 两者都要 | 只任务粒度 | 批量场景必须账号默认 |
| 新增 ADR vs 只补 glossary | **写 ADR-0008** | 只补 glossary | 决策一/三改变了 seam 行为，glossary 不够 |

## 后果

- **正面**：PostHub 可主动选择/覆盖平台预选声明；批量场景可一键设账号默认
- **负面**：键名平台分立，前端要按平台分别展示候选下拉；PostHub 需维护「枚举 ↔ 中文文案」映射表
- **风险**：上游 UI 文案变更会让映射失效；需在 PostHub 发布期加 screenshot + 断言兜底

## 关联

- ADR-0001：`platform_fields` JSON 字段位（line 131）由本 ADR 落地
- ADR-0006：约束「不 fork 上游」由本 ADR 决策三继承
- `CONTEXT.md` glossary 新增 5 条术语（内容声明 / 平台声明字段 / `platform_fields.<platform>` / `declaration` / `source` / `origin` / 平台默认声明）
- `docs/research/2026-08-21-three-platform-aigc-declaration-fields.md`：三家 UI 调研证据