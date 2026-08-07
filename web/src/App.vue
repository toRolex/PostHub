<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useDaemonStore } from "./stores/daemon";

const store = useDaemonStore();
const autostart = ref(false);
const autostartLoading = ref(false);
let timer: number | undefined;

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const statusTagType = computed(() =>
  store.connected ? "success" : "danger",
);
const statusText = computed(() =>
  store.connected ? "已连通" : "未连接",
);

async function loadDaemonUrl(): Promise<void> {
  if (!isTauri()) return;
  try {
    const url = await invoke<string>("get_daemon_url");
    store.url = url;
  } catch {
    // 非 Tauri 环境或命令不可用时使用默认地址
  }
}

async function loadAutostart(): Promise<void> {
  if (!isTauri()) return;
  autostartLoading.value = true;
  try {
    autostart.value = await invoke<boolean>("get_autostart");
  } catch {
    // 忽略：非 Tauri 环境或插件不可用
  } finally {
    autostartLoading.value = false;
  }
}

async function toggleAutostart(value: string | number | boolean): Promise<void> {
  if (!isTauri()) return;
  autostartLoading.value = true;
  try {
    await invoke("set_autostart", { enabled: Boolean(value) });
    autostart.value = Boolean(value);
  } catch {
    autostart.value = !Boolean(value);
  } finally {
    autostartLoading.value = false;
  }
}

async function refresh(): Promise<void> {
  await loadDaemonUrl();
  await store.checkHealth();
}

onMounted(() => {
  void refresh();
  void loadAutostart();
  timer = window.setInterval(() => void store.checkHealth(), store.pollIntervalMs);
});

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <header class="page__header">
      <h1>PostHub 发布中枢</h1>
      <p class="page__subtitle">一个视频，一键 / 定时发布到 抖音、小红书、视频号</p>
    </header>

    <el-card class="card" shadow="never">
      <template #header>
        <div class="card__header">
          <span>守护进程</span>
          <el-tag :type="statusTagType" size="small">{{ statusText }}</el-tag>
        </div>
      </template>

      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="健康接口">
          <code>{{ store.url }}/health</code>
        </el-descriptions-item>
        <el-descriptions-item label="版本">
          {{ store.health?.version ?? "-" }}
        </el-descriptions-item>
        <el-descriptions-item label="监听端口">
          {{ store.health?.port ?? "-" }}
        </el-descriptions-item>
        <el-descriptions-item label="最近错误">
          {{ store.error || "无" }}
        </el-descriptions-item>
      </el-descriptions>

      <div class="card__actions">
        <el-button size="small" :loading="store.checking" @click="refresh">
          立即检查
        </el-button>
      </div>
    </el-card>

    <el-card class="card" shadow="never">
      <template #header>
        <span>开机自启</span>
      </template>
      <el-switch
        v-model="autostart"
        :loading="autostartLoading"
        :disabled="!isTauri()"
        @change="toggleAutostart"
      />
      <span class="card__hint">
        随系统启动常驻（托盘 / 菜单栏）。仅桌面应用环境可用。
      </span>
    </el-card>

    <footer class="page__footer">
      MIT License · 参考 <a href="https://github.com/dreammis/social-auto-upload">social-auto-upload</a>
    </footer>
  </div>
</template>

<style scoped>
.page {
  max-width: 640px;
  margin: 0 auto;
  padding: 32px 20px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", sans-serif;
}

.page__header h1 {
  margin: 0 0 4px;
  font-size: 24px;
}

.page__subtitle {
  margin: 0 0 24px;
  color: #909399;
  font-size: 14px;
}

.card {
  margin-bottom: 16px;
}

.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card__actions {
  margin-top: 12px;
}

.card__hint {
  margin-left: 12px;
  color: #909399;
  font-size: 12px;
}

.page__footer {
  margin-top: 24px;
  color: #c0c4cc;
  font-size: 12px;
  text-align: center;
}
</style>
