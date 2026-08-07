<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";

import { useTasksStore, type Platform, type PlatformJob, type TaskItem, type TaskStatus } from "../stores/tasks";
import { useDaemonStore } from "../stores/daemon";
import { formatDateTime } from "../lib/publishValidation";
import {
  decideNotification,
  notifyLocal,
  requestNotifyPermission,
} from "../lib/notify";

const store = useTasksStore();
const daemon = useDaemonStore();

const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "视频号",
};

const STATUS_META: Record<
  string,
  { label: string; type: "success" | "warning" | "info" | "danger" | "primary" }
> = {
  pending: { label: "待发布", type: "info" },
  publishing: { label: "发布中", type: "primary" },
  success: { label: "成功", type: "success" },
  failed: { label: "失败", type: "danger" },
  manual: { label: "需人工", type: "warning" },
  needs_relogin: { label: "需重登", type: "warning" },
  missed: { label: "错过", type: "info" },
  partial: { label: "部分成功", type: "warning" },
};

const RETRYABLE = new Set(["failed", "manual", "needs_relogin"]);

const fromDate = ref<Date | null>(null);
const toDate = ref<Date | null>(null);
let pollTimer: number | undefined;

function platformLabel(p: Platform): string {
  return PLATFORM_LABELS[p] ?? p;
}

function platformsSummary(jobs: PlatformJob[]): string {
  return jobs.map((j) => platformLabel(j.platform)).join(" / ");
}

function statusMeta(s: string) {
  return STATUS_META[s] ?? { label: s, type: "info" as const };
}

function fmtTime(v: string | null): string {
  return v ?? "-";
}

function canCancel(task: TaskItem): boolean {
  return task.jobs.some((j) => j.status === "pending");
}

function canRetry(job: { status: string }): boolean {
  return RETRYABLE.has(job.status);
}

async function refresh(): Promise<void> {
  await store.fetchTasks();
}

function applyFilters(): void {
  store.setFilters({
    platform: store.filters.platform,
    status: store.filters.status,
    from: fromDate.value ? formatDateTime(fromDate.value) : "",
    to: toDate.value ? formatDateTime(toDate.value) : "",
  });
}

async function cancelTask(task: TaskItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定取消任务「${task.task.title}」？尚未发布的平台子任务将标记为失败。`,
      "取消任务",
      {
        type: "warning",
        confirmButtonText: "取消任务",
        cancelButtonText: "保留",
      },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await store.cancelTask(task.task.id);
    ElMessage.success("任务已取消");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function retryJob(job: { id: number }): Promise<void> {
  try {
    await store.retryJob(job.id);
    ElMessage.success("已重新排队，等待发布");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// ---- 轮询任务状态 → 本地通知（任务完成 / 需人工介入）----

const prevStatus = new Map<number, TaskStatus>();

async function pollAndNotify(): Promise<void> {
  await store.fetchTasks();
  const titleById = new Map(store.tasks.map((t) => [t.task.id, t.task.title]));
  const current = new Map<number, TaskStatus>(
    store.tasks.map((t) => [t.task.id, t.task.status]),
  );
  for (const [id, next] of current) {
    const prev = prevStatus.get(id) ?? null;
    const decision = decideNotification(prev, next, titleById.get(id) ?? `#${id}`);
    if (decision.shouldNotify) notifyLocal(decision);
  }
  for (const [id] of prevStatus) {
    if (!current.has(id)) prevStatus.delete(id);
  }
  for (const [id, status] of current) prevStatus.set(id, status);
}

onMounted(() => {
  void requestNotifyPermission();
  void pollAndNotify();
  pollTimer = window.setInterval(() => void pollAndNotify(), daemon.pollIntervalMs);
});

onUnmounted(() => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
});
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div class="tasks__header">
        <div class="tasks__title">
          <span>任务管理</span>
          <el-tag v-if="!daemon.connected" type="danger" size="small">守护进程未连接</el-tag>
        </div>
        <div class="tasks__filters">
          <el-select
            v-model="store.filters.platform"
            size="small"
            class="tasks__filter"
            aria-label="平台筛选"
            @change="applyFilters"
          >
            <el-option label="全部平台" value="" />
            <el-option
              v-for="(label, value) in PLATFORM_LABELS"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
          <el-select
            v-model="store.filters.status"
            size="small"
            class="tasks__filter"
            aria-label="状态筛选"
            @change="applyFilters"
          >
            <el-option label="全部状态" value="" />
            <el-option
              v-for="(meta, value) in STATUS_META"
              :key="value"
              :label="meta.label"
              :value="value"
            />
          </el-select>
          <el-date-picker
            v-model="fromDate"
            type="datetime"
            size="small"
            class="tasks__filter"
            placeholder="创建起始"
            @change="applyFilters"
          />
          <el-date-picker
            v-model="toDate"
            type="datetime"
            size="small"
            class="tasks__filter"
            placeholder="创建截止"
            @change="applyFilters"
          />
          <el-button size="small" :loading="store.loading" @click="refresh">
            刷新
          </el-button>
        </div>
      </div>
    </template>

    <el-table
      v-if="store.tasks.length > 0"
      :data="store.tasks"
      size="small"
      row-key="task.id"
      class="tasks__table"
    >
      <el-table-column type="expand">
        <template #default="{ row }">
          <el-table :data="row.jobs" size="small" class="tasks__jobs">
            <el-table-column label="平台" width="100">
              <template #default="{ row: job }">
                {{ platformLabel(job.platform) }}
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row: job }">
                <el-tag :type="statusMeta(job.status).type" size="small">
                  {{ statusMeta(job.status).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="attempt_count" label="已尝试" width="80" />
            <el-table-column label="发布时间" width="170">
              <template #default="{ row: job }">
                {{ fmtTime(job.publish_at) }}
              </template>
            </el-table-column>
            <el-table-column label="原因" min-width="150">
              <template #default="{ row: job }">
                <span :class="{ 'tasks__job-error': job.last_error }">
                  {{ job.last_error ?? "-" }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" align="right">
              <template #default="{ row: job }">
                <el-button
                  v-if="canRetry(job)"
                  size="small"
                  text
                  type="primary"
                  @click="retryJob(job)"
                >
                  重试
                </el-button>
                <span v-else class="tasks__muted">-</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-table-column>
      <el-table-column label="任务标题" min-width="160">
        <template #default="{ row }">
          {{ row.task.title }}
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusMeta(row.task.status).type" size="small">
            {{ statusMeta(row.task.status).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="平台" width="160">
        <template #default="{ row }">
          {{ platformsSummary(row.jobs) }}
        </template>
      </el-table-column>
      <el-table-column prop="task.created_at" label="创建时间" width="170" />
      <el-table-column label="操作" width="90" align="right">
        <template #default="{ row }">
          <el-button
            size="small"
            text
            type="danger"
            :disabled="!canCancel(row)"
            @click="cancelTask(row)"
          >
            取消
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-else description="暂无任务" :image-size="60" />

    <p v-if="store.error" class="tasks__error">{{ store.error }}</p>
    <p class="tasks__hint">
      取消仅对「待发布」的平台子任务生效；发布中不可取消。失败任务可展开查看原因并重试。
    </p>
  </el-card>
</template>

<style scoped>
.tasks__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.tasks__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tasks__filters {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.tasks__filter {
  width: 130px;
}

.tasks__table {
  margin-top: 4px;
}

.tasks__jobs {
  margin: 4px 0 4px 24px;
}

.tasks__job-error {
  color: #f56c6c;
}

.tasks__muted {
  color: #c0c4cc;
}

.tasks__error {
  margin: 8px 0 0;
  color: #f56c6c;
  font-size: 12px;
}

.tasks__hint {
  margin: 12px 0 0;
  color: #909399;
  font-size: 12px;
}
</style>
