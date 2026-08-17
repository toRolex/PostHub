# ADR-0005: 调度与状态迁移规则单一真源（rules module）

- **状态**：已批准（架构审查 #Candidate1「收敛双实现的状态迁移与调度规则」grilling 收口）
- **日期**：2026-08-16
- **范围**：执行规范，含代码。将 `TaskStore` 双实现里的状态迁移与调度 frontier 规则收敛为纯函数单一真源；本 ADR 记录决策，代码实现随后的实现轮落地。

## 背景

`daemon/posthub/tasks.py`（1261 行）里 `TaskStore` Protocol（约 18 个方法）有两份实现：`InMemoryTaskStore`（测试用）与 `SqliteTaskStore`（生产用，`make_server` 缺省）。以下规则在两份实现里各手写一遍，语义相同、代码两份：

- **状态迁移**：`apply_success / apply_terminal / requeue / mark_missed / retry_job` 的字段变更（新 status、finished_at、last_error、锁清理、retry_at 等）。
- **调度 frontier**：`claim_eligible_jobs` 的 eligible 判定（定时到点、退避未到期、限速、账号 active、同账号串行、创建序排队）+ 排序键。
- **missed 判定**：`list_pending_missed / list_stale_publishing` 的谓词。

仅 `derive_task_status`（task 聚合状态）已收敛为 `state.py` 共享纯函数；其余规则 InMemory 用 Python 循环 + sort，Sqlite 用一整条 SQL（tasks.py:1025-1082）。同一规则维护两处：改一处必须同步另一处。

## 决策

1. **新建 `daemon/posthub/rules.py` 作为调度/迁移纯函数单一真源**，从 `state.py` 导入时间工具与 `derive_task_status`，无环依赖。内容：
   - `transition(job, new_status, **target) -> Transition(job_fields, account_effect)`：纯字段计算，返回该迁移应写入的 job 字段 + 账号副作用标记（仅两类：`success → set_last_publish_at`、`needs_relogin → set_needs_relogin`，否则 `None`）。
   - frontier 谓词（eligible 判定：定时/退避/限速/账号 active/同账号串行/创建序）+ 排序键。
   - missed 谓词（`local_time` 定时超容忍窗口；`publishing` 超时）。
   - **不引入 string 副作用清单层**：账号副作用仅两类且已经 `AccountStore` seam 共享、参数化测试已锁行为，套清单 + store 内 switch 是多余间接层（顾问审查修正）。
2. **`TaskStore` interface 不变**，`apply_*` 方法名保留：内部改为调用 `rules.transition` 拿 `job_fields` 做持久化 + 按 `account_effect` 执行副作用。scheduler / management 零改动；副作用执行留在 store 薄包装（持久化职责），规则收敛不改变调用语义。
3. **Sqlite `claim_eligible_jobs` SQL 退化为宽候选拉取 + 乐观锁领取**：`WHERE status='pending'` 剪枝保留（防历史终态膨胀），eligible 判定 / 排序 / claim 迁移字段（publishing + 锁 + attempt_count+1）全部走 `rules` 纯函数；乐观锁 `UPDATE ... WHERE status='pending'` 保留（存储层原子性职责，非规则重复）。拆分不引入新并发窗口——claim 全程持 store 自锁且单进程，乐观锁本就为跨进程防御；个人数据量级每 tick O(n) 可忽略（顾问审查验证）。
4. **测试**：新增规则单测直接测 `transition / eligible / 排序键 / missed 谓词`（现在规则只能经 store 间接测到）；现有 `params=["in-memory", "sqlite"]` 参数化行为测试原样保留作「薄包装正确接规则」的回归，不加新的双实现对照测试（参数化已覆盖一致性）。**保留 InMemory 实现**——双实现是行为一致性回归资产，不删除。

## 与 ADR-0001 的关系

仅 **supersede ADR-0001 §调度接口「调度器 Frontier 查询」小节**（其中把整条 frontier SQL 记作接口规范；实现改为纯函数真源后，SQL 逐字不再对应实现）。ADR-0001 的 schema、状态机、乐观锁领取、重试策略、限速语义均不变，不整份标注。

## 后果（下游影响）

- 调度规则一处修改，不再同步两份实现；测试与生产共用同一条规则（locality / leverage）。
- `tasks.py` 双实现各变薄，重复的 frontier/迁移逻辑删除。
- 未来探索者从 ADR-0005 而非 ADR-0001 的 SQL 找调度语义。
- CONTEXT.md「调度与重试约束」小节同步指向 `rules` 单一真源。
