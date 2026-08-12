# ADR-0003: 前端从 Vue 迁移到 React + shadcn/ui

- **状态**：已批准（前端 redesign grilling 收口）
- **日期**：2026-08-12
- **范围**：执行规范，不改代码。前端全量重构（IA + 交互 + 视觉）的技术栈决策依据。

## 背景

前端现状是单页 `App.vue` + 5 卡片组件 + 3 顶部 tabs，Vue 3 + Vite + Element Plus + Pinia，EP 默认主题零定制。redesign grilling 确定**全量重构**（IA + 交互 + 视觉）：新 IA 为左侧栏 + 内容区、三区（多平台发布 / 任务管理 / 账号管理），视觉基调亮色 Arc 现代风，硬约束「不能丑、不能死板」。

## 决策

前端技术栈切换为 **React + Vite + shadcn/ui（Tailwind + Radix）**，弃 Vue 3 / Element Plus / Pinia。现有组件、store、测试按 React 栈全量重写。

## 动机（为什么是 shadcn/ui）

1. **可定制性是硬需求。** grilling 结论：现有 UI「丑、死板」。Element Plus 观感强、定制受限于其 CSS 变量模型；shadcn 无样式 + 组件源码进项目 + Tailwind token 化，提供最大定制空间。
2. **与 impeccable 工作流契合。** design system 走 token + 自定义组件；shadcn 的形态（源码可改、语义化 token）正是为这套定制工作流设计的。
3. **跨平台无冲突。** Tauri 2 用 WebView（Windows = WebView2/Chromium），前端栈与 Tauri 解耦，React 完全兼容。

## 被拒的替代方案

- **保留 Vue + Element Plus 主题定制**：可解耦合但可定制性不足，无法满足视觉目标；现有单页结构本就计划全量重写。
- **Vue 生态换库（Naive UI 等）**：仍在 Vue 生态内，用户明确不要 Vue。
- **全自建组件**：复杂控件（任务表格、平台约束日期选择、人工介入弹窗）自建成本高；shadcn 给成熟基座 + 定制自由。

## 后果（下游影响）

- 5 个 .vue 组件（约 1500 行）+ 7 个 Pinia store 的领域逻辑（调度状态机、平台约束、发布校验）→ TSX / React 状态方案重写，**store 单测语义保留**。
- Vite 插件换 React、加 Tailwind 构建链；`vue-tsc` → `tsc`。
- 领域术语（账号 / 任务 / 批次 / 平台 / 状态机）不变，仅实现层迁移。
- 状态方案（Zustand / TanStack Query）与路由方案在实现轮确定，本 ADR 不锁定。
