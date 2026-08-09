<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";

import { usePublishStore } from "../stores/publish";
import { usePlatformStore, type Platform } from "../stores/platform";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { effectiveMinLeadSeconds, HOUR } from "../lib/publishValidation";
import { isTauri } from "../lib/isTauri";
import { pickImagePath, pickVideoPath } from "../lib/picker";

const store = usePublishStore();
const platforms = usePlatformStore();
const accounts = useAccountsStore();
const daemon = useDaemonStore();

const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "视频号",
};

const publishAtDate = ref<Date | null>(null);

const accountOptions = computed(() => (p: Platform) =>
  accounts.accounts.filter((a) => a.platform === p),
);

function platformLabel(p: Platform): string {
  return PLATFORM_LABELS[p] ?? p;
}

/** 各平台约束展示：min_lead / 定时窗口 / 每日上限 / 封面。 */
function constraintSummary(p: Platform): string {
  const c = platforms.constraints[p];
  if (!c) return "";
  const effMin = effectiveMinLeadSeconds(c);
  const windowMax = Math.floor(c.schedule_max_seconds / HOUR);
  const parts: string[] = [
    `定时最小提前 ${Math.floor(effMin / HOUR)} 小时`,
    `定时窗口 ≤ ${windowMax} 小时`,
  ];
  if (c.max_scheduled_per_day != null) {
    parts.push(`每日上限 ${c.max_scheduled_per_day} 条`);
  }
  parts.push(
    c.cover_required
      ? "封面：强制（自动选推荐封面）"
      : "封面：缺省自动取首帧",
  );
  return parts.join("；");
}

function onVideoFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const p = (file as unknown as { path?: string }).path ?? file.name;
  store.videoPath = p;
}

async function pickVideo(): Promise<void> {
  try {
    const path = await pickVideoPath();
    if (path) store.videoPath = path;
  } catch {
    // 仅桌面环境可用；失败静默（浏览器回退原生 input）
  }
}

function onCoverFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  store.coverHorizontal =
    (file as unknown as { path?: string }).path ?? file.name;
}

async function pickCover(): Promise<void> {
  try {
    const path = await pickImagePath();
    if (path) store.coverHorizontal = path;
  } catch {
    // 仅桌面环境可用；失败静默（浏览器回退原生 input）
  }
}

function onPublishAtChange(value: Date | null): void {
  store.setPublishAt(value);
}

function togglePlatform(p: Platform): void {
  const next = store.selectedPlatforms.includes(p)
    ? store.selectedPlatforms.filter((x) => x !== p)
    : [...store.selectedPlatforms, p];
  store.setPlatforms(next, accounts.accounts);
}

async function submit(): Promise<void> {
  try {
    const result = await store.createTask();
    ElMessage.success(`任务 #${result.task.id} 已创建，共 ${result.jobs.length} 个平台子任务`);
    store.reset();
    publishAtDate.value = null;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() => {
  void platforms.fetchConstraints();
  void accounts.fetchAccounts();
});

watch(
  () => daemon.connected,
  (connected) => {
    if (connected) {
      void platforms.fetchConstraints();
      void accounts.fetchAccounts();
    }
  },
);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div class="card__header">
        <span>发布</span>
        <el-tag v-if="!daemon.connected" type="danger" size="small">守护进程未连接</el-tag>
      </div>
    </template>

    <el-form label-position="top" size="default" @submit.prevent="submit">
      <el-form-item label="视频文件">
        <div class="publish__file-row">
          <el-input
            v-model="store.videoPath"
            placeholder="本地视频路径（桌面端点选文件自动填入）"
            clearable
          />
          <input
            v-if="!isTauri()"
            class="publish__native-file"
            type="file"
            accept="video/*"
            title="选择视频"
            @change="onVideoFile"
          />
          <el-button v-else size="small" @click="pickVideo">选择视频</el-button>
        </div>
      </el-form-item>

      <el-form-item label="标题">
        <el-input v-model="store.title" placeholder="任务标题（必填）" maxlength="100" />
      </el-form-item>

      <el-form-item label="正文 / 描述">
        <el-input
          v-model="store.caption"
          type="textarea"
          :rows="3"
          placeholder="发布到各平台的正文（可选）"
        />
      </el-form-item>

      <el-form-item label="封面">
        <el-radio-group v-model="store.coverMode">
          <el-radio value="auto">自动取首帧</el-radio>
          <el-radio value="file">本地封面文件</el-radio>
        </el-radio-group>
        <div v-if="store.coverMode === 'file'" class="publish__file-row">
          <el-input
            v-model="store.coverHorizontal"
            placeholder="封面路径（横版）"
            clearable
          />
          <input
            v-if="!isTauri()"
            class="publish__native-file"
            type="file"
            accept="image/*"
            title="选择封面"
            @change="onCoverFile"
          />
          <el-button v-else size="small" @click="pickCover">选择封面</el-button>
        </div>
        <p class="publish__hint">
          抖音强制封面（自动选推荐封面）；小红书 / 视频号缺封面自动取首帧。
        </p>
      </el-form-item>

      <el-form-item label="发布平台">
        <el-checkbox-group
          :model-value="store.selectedPlatforms"
          class="publish__platforms"
        >
          <el-checkbox
            v-for="(label, value) in PLATFORM_LABELS"
            :key="value"
            :value="value"
            @change="togglePlatform(value as Platform)"
          >
            {{ label }}
          </el-checkbox>
        </el-checkbox-group>

        <div v-if="store.selectedPlatforms.length > 0" class="publish__constraints">
          <div
            v-for="p in store.selectedPlatforms"
            :key="p"
            class="publish__constraint"
          >
            <span class="publish__constraint-platform">{{ platformLabel(p) }}</span>
            <span>{{ constraintSummary(p) }}</span>
            <el-select
              v-model="store.accountByPlatform[p]"
              class="publish__account-select"
              placeholder="选择账号"
              size="small"
            >
              <el-option
                v-for="a in accountOptions(p)"
                :key="a.id"
                :label="a.name"
                :value="a.id"
              />
            </el-select>
          </div>
        </div>
        <p v-if="store.selectedPlatforms.length > 0 && !platforms.loading && platforms.error" class="publish__error">
          约束注册表加载失败：{{ platforms.error }}
        </p>
      </el-form-item>

      <el-form-item label="排期">
        <el-radio-group v-model="store.schedulePolicy">
          <el-radio value="immediate">立即发布</el-radio>
          <el-radio value="scheduled">定时发布</el-radio>
        </el-radio-group>
        <div v-if="store.schedulePolicy === 'scheduled'" class="publish__schedule-row">
          <el-radio-group v-model="store.publishMode" size="small">
            <el-radio value="platform_time">平台原生定时</el-radio>
            <el-radio value="local_time">工具到点（兜底）</el-radio>
          </el-radio-group>
          <el-date-picker
            v-model="publishAtDate"
            type="datetime"
            placeholder="选择定时发布时间"
            :disabled-date="(d: Date) => d.getTime() < Date.now()"
            @change="onPublishAtChange"
          />
        </div>
      </el-form-item>

      <el-form-item>
        <el-switch v-model="store.silent" />
        <span class="publish__hint">静默发布（不打扰、无弹窗）</span>
      </el-form-item>

      <div v-if="store.validationErrors.length > 0" class="publish__error-box">
        <p v-for="(err, i) in store.validationErrors" :key="i" class="publish__error">
          {{ err }}
        </p>
      </div>

      <el-button
        type="primary"
        :loading="store.submitting"
        :disabled="!daemon.connected"
        @click="submit"
      >
        创建发布任务
      </el-button>
    </el-form>
  </el-card>
</template>

<style scoped>
.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.publish__file-row {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: center;
}

.publish__native-file {
  max-width: 200px;
}

.publish__hint {
  margin: 6px 0 0;
  color: #909399;
  font-size: 12px;
}

.publish__platforms {
  display: block;
  margin-bottom: 8px;
}

.publish__constraints {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.publish__constraint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: #f5f7fa;
  border-radius: 4px;
  font-size: 12px;
  color: #606266;
}

.publish__constraint-platform {
  font-weight: 600;
  white-space: nowrap;
}

.publish__account-select {
  width: 160px;
  margin-left: auto;
}

.publish__schedule-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  align-items: flex-start;
}

.publish__error-box {
  margin: 8px 0;
  padding: 8px 12px;
  background: #fef0f0;
  border-radius: 4px;
}

.publish__error {
  margin: 2px 0;
  color: #f56c6c;
  font-size: 12px;
}
</style>
