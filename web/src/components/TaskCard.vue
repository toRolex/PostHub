<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { ElMessage } from "element-plus";

import { useTasksStore, type PlatformJobRecord, type TaskDetail } from "../stores/tasks";
import { useDaemonStore } from "../stores/daemon";
import type { Platform } from "../stores/accounts";

const store = useTasksStore();
const daemon = useDaemonStore();

const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "视频号",
};

const JOB_STATUS_META: Record<
  string,
  { label: string; type: "success" | "warning" | "info" | "danger" }
> = {
  pending: { label: "待发布", type: "info" },
  publishing: { label: "发布中", type: "warning" },
  success: { label: "成功", type: "success" },
  failed: { label: "失败", type: "danger" },
  manual: { label: "需人工", type: "warning" },
  needs_relogin: { label: "需重新扫码", type: "danger" },
  missed: { label: "错过", type: "info" },
};

const TASK_STATUS_META: Record<
  string,
  { label: string; type: "success" | "warning" | "info" | "danger" }
> = {
  pending: { label: "待发布", type: "info" },
  publishing: { label: "发布中", type: "warning" },
  success: { label: "成功", type: "success" },
  failed: { label: "失败", type: "danger" },
  manual: { label: "需人工", type: "warning" },
  needs_relogin: { label: "需重新扫码", type: "danger" },
  missed: { label: "错过", type: "info" },
  partial: { label: "部分成功", type: "warning" },
};

function platformLabel(p: string): string {
  return PLATFORM_LABELS[p as Platform] ?? p;
}

function jobMeta(s: string) {
  return JOB_STATUS_META[s] ?? { label: s, type: "info" as const };
}

function taskMeta(s: string) {
  return TASK_STATUS_META[s] ?? { label: s, type: "info" as const };
}

const needsAttention = computed(() =>
  store.tasks.filter(
    (d) =>
      d.task.status === "manual" ||
      d.task.status === "needs_relogin" ||
      d.jobs.some(
        (j) => j.status === "manual" || j.status === "needs_relogin",
      ),
  ),
);

async function retryJob(task: TaskDetail, job: PlatformJobRecord): Promise<void> {
  try {
    await store.retryJob(task.task.id, job.id);
    ElMessage.success(`已重试「${platformLabel(job.platform)}」，任务回到待发布队列`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() => {
  void store.fetchTasks();
});

watch(
  () => daemon.connected,
  (connected) => {
    if (connected) void store.fetchTasks();
  },
);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div class="card__header">
        <span>任务</span>
        <div class="card__header-actions">
          <el-tag
            v-if="needsAttention.length > 0"
            type="warning"
            size="small"
          >
            {{ needsAttention.length }} 个任务需人工处理
          </el-tag>
          <el-button
            size="small"
            text
            :loading="store.loading"
            @click="store.fetchTasks"
          >
            刷新
          </el-button>
        </div>
      </div>
    </template>

    <template v-if="store.tasks.length > 0">
      <div
        v-for="detail in store.tasks"
        :key="detail.task.id"
        class="tasks__item"
      >
        <div class="tasks__item-head">
          <span class="tasks__title">#{{ detail.task.id }} {{ detail.task.title }}</span>
          <el-tag :type="taskMeta(detail.task.status).type" size="small">
            {{ taskMeta(detail.task.status).label }}
          </el-tag>
        </div>
        <div class="tasks__jobs">
          <div
            v-for="job in detail.jobs"
            :key="job.id"
            class="tasks__job"
          >
            <span class="tasks__job-platform">{{ platformLabel(job.platform) }}</span>
            <el-tag :type="jobMeta(job.status).type" size="small">
              {{ jobMeta(job.status).label }}
            </el-tag>
            <span v-if="job.last_error" class="tasks__job-error" :title="job.last_error">
              {{ job.last_error }}
            </span>
            <el-button
              v-if="['failed', 'manual', 'needs_relogin'].includes(job.status)"
              size="small"
              text
              type="primary"
              @click="retryJob(detail, job)"
            >
              重试
            </el-button>
          </div>
        </div>
      </div>
    </template>

    <el-empty
      v-else-if="!store.loading"
      description="暂无任务，在「发布」页创建任务"
      :image-size="60"
    />

    <p v-if="store.error" class="tasks__error">{{ store.error }}</p>
  </el-card>
</template>

<style scoped>
.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tasks__item {
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #f5f7fa;
  border-radius: 6px;
}

.tasks__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.tasks__title {
  font-weight: 600;
  font-size: 13px;
}

.tasks__jobs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tasks__job {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.tasks__job-platform {
  width: 56px;
  white-space: nowrap;
}

.tasks__job-error {
  flex: 1;
  color: #e6a23c;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tasks__error {
  margin: 8px 0 0;
  color: #f56c6c;
  font-size: 12px;
}
</style>
