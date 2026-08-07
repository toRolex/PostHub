<script setup lang="ts">
import { onMounted } from "vue";

import { useLogsStore, type LogLevel } from "../stores/logs";
import { useDaemonStore } from "../stores/daemon";

const store = useLogsStore();
const daemon = useDaemonStore();

const LEVEL_META: Record<LogLevel, { label: string; type: "info" | "warning" | "danger" | "primary" }> = {
  debug: { label: "DEBUG", type: "info" },
  info: { label: "INFO", type: "primary" },
  warn: { label: "WARN", type: "warning" },
  error: { label: "ERROR", type: "danger" },
};

const LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: "debug", label: "DEBUG" },
  { value: "info", label: "INFO" },
  { value: "warn", label: "WARN" },
  { value: "error", label: "ERROR" },
];

function levelMeta(level: string) {
  return LEVEL_META[level as LogLevel] ?? { label: level, type: "info" as const };
}

async function refresh(): Promise<void> {
  await store.fetchLogs();
}

onMounted(() => {
  void store.fetchLogs();
});
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div class="logs__header">
        <div class="logs__title">
          <span>应用日志</span>
          <el-tag v-if="!daemon.connected" type="danger" size="small">守护进程未连接</el-tag>
        </div>
        <div class="logs__filters">
          <el-select
            v-model="store.filters.level"
            size="small"
            class="logs__filter"
            aria-label="级别筛选"
            @change="store.setFilters({ level: store.filters.level })"
          >
            <el-option label="全部级别" value="" />
            <el-option
              v-for="opt in LEVEL_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
          <el-input
            v-model="store.filters.task_id"
            size="small"
            class="logs__task-filter"
            placeholder="按任务 ID 筛选"
            clearable
            @change="store.setFilters({ task_id: store.filters.task_id })"
          />
          <el-button size="small" :loading="store.loading" @click="refresh">
            刷新
          </el-button>
        </div>
      </div>
    </template>

    <el-table
      v-if="store.logs.length > 0"
      :data="store.logs"
      size="small"
      class="logs__table"
    >
      <el-table-column label="级别" width="90">
        <template #default="{ row }">
          <el-tag :type="levelMeta(row.level).type" size="small">
            {{ levelMeta(row.level).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="时间" width="170" />
      <el-table-column label="来源" width="110">
        <template #default="{ row }">
          <code>{{ row.source }}</code>
        </template>
      </el-table-column>
      <el-table-column label="任务" width="90">
        <template #default="{ row }">
          {{ row.task_id ? `#${row.task_id}` : "-" }}
        </template>
      </el-table-column>
      <el-table-column prop="message" label="消息" min-width="220" />
    </el-table>

    <el-empty v-else description="暂无日志" :image-size="60" />

    <p v-if="store.error" class="logs__error">{{ store.error }}</p>
  </el-card>
</template>

<style scoped>
.logs__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.logs__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logs__filters {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.logs__filter {
  width: 120px;
}

.logs__task-filter {
  width: 150px;
}

.logs__table {
  margin-top: 4px;
}

.logs__error {
  margin: 8px 0 0;
  color: #f56c6c;
  font-size: 12px;
}
</style>
