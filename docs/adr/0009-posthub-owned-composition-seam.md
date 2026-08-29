# ADR-0009: PostHub-owned 后端组合 seam 与受限本机扩展边界

- **状态**：已批准
- **日期**：2026-08-27
- **范围**：官方 Flask 后端的组合入口、PostHub-owned 路由/数据库/生命周期组件，以及 batch runner/history 的领域边界。

## 背景

ADR-0006 将发布执行收敛到 social-auto-upload 官方后端，避免 PostHub 复制上游能力。随着桌面产品需要账号默认声明、批量提交记录与恢复入口，PostHub 仍需要少量官方没有的本机扩展。

此前“没有自研后端/状态机”的表述容易被理解为 PostHub 不能拥有任何后端组合组件，也容易把新的本机扩展再次直接堆进 `sau_backend.py`。这既模糊了官方能力与 PostHub-owned 能力的边界，也让重复启动/初始化的生命周期难以验证。

## 决策

1. **独立组合入口**：PostHub 通过独立组合入口导入官方 Flask 应用，并一次性组合以下组件：
   - 官方 `database.db` 的幂等初始化与必要增量迁移；
   - PostHub-owned 路由（当前包括账号默认声明）；
   - PostHub-owned 生命周期钩子（当前包括发布 seam 的平台声明适配与清理）；
   - 不改上游源码的发布函数 wrapper。
2. **幂等初始化**：组合入口以应用实例为边界保存初始化标记。重复调用返回同一应用，不重复注册路由、钩子或破坏既有数据库数据；官方路由保持原有 URL、方法和响应契约。
3. **官方执行真源**：账号、素材、单视频、批量、登录与官方定时语义继续由官方后端提供。组合层只能适配 HTTP/SSE seam，不复制官方发布流程。
4. **受限本机扩展**：允许 PostHub-owned 的 batch runner/history，用于桌面端本机批量提交编排所需的记录、历史回看、受限 item retry 与恢复入口。该扩展不得成为通用 scheduler，不跨机器执行，不定义独立限速、并发或平台定时语义；retry 只复制首次受理时冻结的 effective payload。
5. **保留不 fork 约束**：`sau_backend.py`、`myUtils`、`uploader/*` 与官方前端仍保持上游副本/依赖语义；PostHub 新能力放在独立组合层与桌面壳侧，不在官方模块内继续堆入业务代码。

## Supersede 关系

- **收窄 ADR-0006 的绝对表述**：
  - “没有自研后端”改为“没有通用自研发布后端”；允许受限本机 PostHub-owned 组合扩展。
  - “没有自研状态机/调度器”改为“没有通用发布状态机/调度器”；本机 batch runner/history 可以保存产品记录和恢复信息，但不执行替代官方的调度策略。
- **不改变 ADR-0006 的核心决策**：发布执行、账号登录态、官方接口契约与官方定时语义仍由上游承担；PostHub 不 fork、不修改上游执行代码。
- **不恢复 ADR-0001 的通用自研模型**：`task` / `platform_job` / `account` / `batch` 表和其状态机、通用限速、并发设计仍不作为执行真源；本 ADR 允许的 retry 仅是受限 item 复制，不是通用调度重试。

## 后果

- 官方副本可以保持可审计，不再因为 PostHub-owned 路由与声明适配持续产生漂移。
- `run_backend.py` 只负责进程入口与本机监听，组合职责集中在独立模块，便于单测和后续扩展。
- 组合入口需要显式维护幂等标记；新的 PostHub-owned 组件必须通过该入口注册，不得在官方模块导入时隐式注册。
- batch runner/history 的后续实现必须继续证明“本机记录/恢复”而非“通用调度器”，并以官方 HTTP/SSE seam 为执行边界。

## 验证

- 组合入口重复初始化测试断言 PostHub-owned 路由只出现一次，且 `/getAccounts`、`/getFiles`、`/postVideo`、`/postVideoBatch` 仍可通过官方契约 smoke。
- daemon 全量测试覆盖数据库幂等、官方账号/素材/单视频/批量接口与 PostHub-owned 路由。
