<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { ElMessage } from "element-plus";

import { useBatchesStore, type ManifestEntry } from "../stores/batches";
import { useAccountsStore } from "../stores/accounts";
import { usePlatformStore, type Platform } from "../stores/platform";
import { useDaemonStore } from "../stores/daemon";
import { isTauri } from "../lib/isTauri";
import { pickFolderPath } from "../lib/picker";

const store = useBatchesStore();
const accounts = useAccountsStore();
const platforms = usePlatformStore();
const daemon = useDaemonStore();

const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "视频号",
};

const accountOptions = computed(() =>
  accounts.accounts.map((a) => ({
    id: a.id,
    label: `${a.name}（${PLATFORM_LABELS[a.platform] ?? a.platform}）`,
  })),
);

/** 读取条目当前生效账号（逐条覆盖优先，否则批次默认）。 */
function entryAccountId(entry: ManifestEntry): number | null {
  return store.accountOverrides[entry.index] ?? store.selectedAccountId;
}

function platformLabelFor(entry: ManifestEntry): string {
  const accId = entryAccountId(entry);
  const acc = accounts.accounts.find((a) => a.id === accId);
  return acc ? (PLATFORM_LABELS[acc.platform] ?? acc.platform) : "未选账号";
}

function tagsText(entry: ManifestEntry): string {
  return (entry.tags ?? []).join("，");
}

function onTagsChange(entry: ManifestEntry, value: string): void {
  store.patchEntry(entry.index, {
    tags: value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
  });
}

function onFolderPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;
  const first = files[0] as File & { path?: string };
  const rel = first.webkitRelativePath;
  if (first.path && rel) {
    // 非 Tauri 浏览器 dev：file.path 不可用，仅 webkitRelativePath 兜底
    store.folderPath = first.path.slice(0, first.path.length - rel.length - 1);
  } else {
    store.folderPath = rel ? rel.split("/")[0] : first.name;
  }
}

async function pickFolder(): Promise<void> {
  try {
    const path = await pickFolderPath();
    if (path) store.folderPath = path;
  } catch {
    // 仅桌面环境可用；失败静默（浏览器回退原生 input）
  }
}

async function parse(): Promise<void> {
  try {
    await store.parse();
    if (store.hasHardErrors) {
      ElMessage.error(
        `批次校验失败，共 ${store.result!.hard_errors.length} 处硬错误`,
      );
    } else {
      ElMessage.success(`解析成功，共 ${store.pendingEntries.length} 条待确认`);
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function confirm(): Promise<void> {
  try {
    const ids = await store.confirm();
    ElMessage.success(`已生成 ${ids.length} 个发布任务：#${ids.join(", #")}`);
    store.reset();
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
        <span>批量导入（manifest）</span>
        <el-tag v-if="!daemon.connected" type="danger" size="small">守护进程未连接</el-tag>
      </div>
    </template>

    <div class="batch__toolbar">
      <el-input
        v-model="store.folderPath"
        placeholder="批次文件夹路径（含 manifest.json）"
        clearable
        class="batch__folder"
      />
      <input
        v-if="!isTauri()"
        class="batch__native-folder"
        type="file"
        webkitdirectory
        title="选择批次文件夹"
        @change="onFolderPick"
      />
      <el-button v-else @click="pickFolder">选择文件夹</el-button>
      <el-select
        v-model="store.selectedAccountId"
        placeholder="目标账号"
        clearable
        class="batch__account"
      >
        <el-option
          v-for="a in accountOptions"
          :key="a.id"
          :label="a.label"
          :value="a.id"
        />
      </el-select>
      <el-button
        type="primary"
        :loading="store.parsing"
        :disabled="!daemon.connected"
        @click="parse"
      >
        解析批次
      </el-button>
    </div>
    <p class="batch__hint">
      批次 = 一个账号下的若干视频；账号在导入时选定，发布到该账号所属平台。多账号 = 多次导入。
    </p>

    <!-- 硬错误：整批拒绝，明确列出（哪条、为什么） -->
    <div v-if="store.hasHardErrors" class="batch__errors">
      <p class="batch__errors-title">批次校验失败（整批拒绝）：</p>
      <p v-for="(err, i) in store.result?.hard_errors ?? []" :key="i" class="batch__error">
        {{ err.message }}
      </p>
    </div>

    <!-- 待确认列表：逐条可覆盖标题/正文/封面/定时/账号/平台 -->
    <div v-else-if="store.pendingEntries.length > 0" class="batch__pending">
      <el-table :data="store.pendingEntries" size="small" border>
        <el-table-column label="文件" min-width="150">
          <template #default="{ row }">
            <span class="batch__file">{{ row.file }}</span>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="120">
          <template #default="{ row }">
            <el-input
              v-model="row.title"
              size="small"
              placeholder="标题（必填）"
            />
          </template>
        </el-table-column>
        <el-table-column label="正文" min-width="120">
          <template #default="{ row }">
            <el-input v-model="row.content" size="small" placeholder="正文（可选）" />
          </template>
        </el-table-column>
        <el-table-column label="tags" min-width="110">
          <template #default="{ row }">
            <el-input
              :model-value="tagsText(row)"
              size="small"
              placeholder="逗号分隔"
              @change="(v: string) => onTagsChange(row, v)"
            />
          </template>
        </el-table-column>
        <el-table-column label="封面（横/竖）" min-width="150">
          <template #default="{ row }">
            <el-input
              :model-value="row.cover_landscape ?? ''"
              size="small"
              placeholder="横版封面路径"
              @change="(v: string) => store.patchEntry(row.index, { cover_landscape: v || null })"
            />
            <el-input
              :model-value="row.cover_portrait ?? ''"
              size="small"
              placeholder="竖版封面路径"
              @change="(v: string) => store.patchEntry(row.index, { cover_portrait: v || null })"
            />
          </template>
        </el-table-column>
        <el-table-column label="定时" min-width="140">
          <template #default="{ row }">
            <el-input
              :model-value="row.schedule ?? ''"
              size="small"
              placeholder="YYYY-MM-DD HH:mm:ss，留空=立即发布"
              @change="(v: string) => store.patchEntry(row.index, { schedule: v || null })"
            />
          </template>
        </el-table-column>
        <el-table-column label="账号 / 平台" min-width="150">
          <template #default="{ row }">
            <el-select
              :model-value="entryAccountId(row)"
              size="small"
              placeholder="账号"
              @change="(v: number) => store.setEntryAccount(row.index, v)"
            >
              <el-option
                v-for="a in accountOptions"
                :key="a.id"
                :label="a.label"
                :value="a.id"
              />
            </el-select>
            <span class="batch__platform">{{ platformLabelFor(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="提示" min-width="120">
          <template #default="{ row }">
            <el-tag
              v-for="(w, i) in row.warnings"
              :key="i"
              type="warning"
              size="small"
              class="batch__warning"
            >
              {{ w }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <div class="batch__confirm-row">
        <el-button
          type="success"
          :loading="store.confirming"
          :disabled="!daemon.connected"
          @click="confirm"
        >
          确认放行（生成发布任务）
        </el-button>
        <span class="batch__hint">
          确认后逐条进入与发布页相同的执行通道（create_task 落库，调度器接管）。
        </span>
      </div>
    </div>

    <p v-else class="batch__hint">
      选择批次文件夹并解析，待确认列表将在此展示。
    </p>
  </el-card>
</template>

<style scoped>
.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.batch__toolbar {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: center;
  flex-wrap: wrap;
}

.batch__folder {
  flex: 1 1 260px;
  min-width: 220px;
}

.batch__account {
  width: 200px;
}

.batch__native-folder {
  max-width: 180px;
}

.batch__hint {
  margin: 6px 0 0;
  color: #909399;
  font-size: 12px;
}

.batch__errors {
  margin: 12px 0;
  padding: 8px 12px;
  background: #fef0f0;
  border-radius: 4px;
}

.batch__errors-title {
  margin: 0 0 4px;
  font-weight: 600;
  color: #f56c6c;
  font-size: 13px;
}

.batch__error {
  margin: 2px 0;
  color: #f56c6c;
  font-size: 12px;
}

.batch__pending {
  margin-top: 12px;
}

.batch__file {
  font-size: 12px;
  word-break: break-all;
}

.batch__platform {
  display: inline-block;
  margin-left: 6px;
  color: #909399;
  font-size: 12px;
}

.batch__warning {
  margin: 2px 4px 2px 0;
}

.batch__confirm-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
