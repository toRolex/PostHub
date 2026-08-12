# Design Brief · PostHub 前端全量重构

> 来源：前端 redesign grilling（2026-08-11~12）+ `/impeccable init` + `/impeccable shape`。编码前规划，供 `/impeccable craft` 实施引用。
> 关联文档：`PRODUCT.md`（战略）、`DESIGN.md`（视觉 seed）、`docs/adr/0003-frontend-react-shadcn-migration.md`（技术栈决策）。

## 1. Feature Summary

PostHub 桌面中枢（Windows / macOS，React + shadcn/ui）从 EP 单页 tabs 重构为「左侧栏 + 内容区」三区应用：**多平台发布 / 任务管理 / 账号管理**，顶栏常驻系统状态。设计服务「发布、盯状态、处理异常」三件事。

## 2. Primary User Action

把本地素材（单个视频，或 manifest 批量导入）一键发布到已配置的多平台账号——选素材 → 勾账号 → 定排期 → 立即/定时发布。

## 3. Design Direction

- **Color strategy**：Restrained 亮色，单一 accent ≤10%，非白底灰字
- **Scene**：创作者桌面（白天/深夜）打开面板快速发布、盯状态；界面安静可靠、状态一眼可读
- **Anchors**：Arc 浏览器（左侧栏、收边干净）、Linear（列表密度/状态视觉）、shadcn/ui 官方观感
- **反参考**：Element Plus 企业后台、SaaS 玻璃拟态/渐变文字/大数字 hero

## 4. Scope

高保真；应用壳 + 三区全覆盖；交互原型级（含关键状态流转）；锁定方向、编码前置。

## 5. Layout Strategy

**已选型：A · Workbench**（2026-08-13 经三变体原型 `docs/prototypes/posthub-app-variants.html` 验证胜出——窄文字侧栏 + 顶栏 + 垂直分节发布表单；B Master-Detail 双栏与 C 向导作为备选落选）。

- **应用壳**：左侧栏（三区 + 底部「日志」次级入口）+ 顶栏状态条（daemon 连接、版本、最近错误，常驻不占页）
- **发布区（动作中心）**：①素材来源（本地文件 / manifest 批量导入 → 待确认列表）②平台账号勾选（行内显示平台约束）③内容与排期（标题/正文/标签/封面，平台差异收敛于此）④主行动「立即发布 / 定时发布」
- **任务区（监控中心）**：任务列表 + 状态筛选（7 态），行内聚合各平台结果，展开看子任务明细，待发布可编辑，人工介入/需重登高亮置顶
- **账号区（配置中心）**：账号表格（平台/名称/用户名/调试端口/备注/状态）+ 添加流程（选平台 → 命名 → 拉起 Chrome 扫码登录）

## 6. Key States

三区各：default / empty / loading / error / success。
- 任务区重点：人工介入、需重新扫码、错过排期——异常态主动浮现
- 账号区：登录中 + active / needs_relogin / disabled 三态
- 发布区：素材校验失败、平台约束超窗即时反馈
- 空状态：账号区首启引导添加；任务区无任务引导发布

## 7. Interaction Model

发布 → 跳任务区看状态；任务筛选/展开/编辑/重试；账号添加 → 拉起 Chrome → 扫码 → 状态回填；人工介入 = Tauri 原生通知 + 任务区高亮双轨；顶栏状态条常驻。

## 8. Content Requirements

三区标题/空状态/错误文案；平台约束动态文案（「2h 内不可定时」「缺封面自动取首帧」）；状态枚举沿用 CONTEXT.md 术语（待发布/进行中/成功/失败/需人工/需重新扫码/错过）。

## 9. Recommended References

`layout.md`（应用壳 + 三区布局）、`interaction-design.md`（发布分步流程、表格）、`onboard.md`（账号区首启引导）、`animate.md`（状态切换，克制 ≤200ms）。

## 10. Open Questions

无剩余阻塞项。日志入口、daemon 状态条、批次归属已按 grilling 结论固化（对应 5. Layout Strategy）。
