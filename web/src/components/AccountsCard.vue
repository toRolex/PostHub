<script setup lang="ts">
import { onMounted, reactive, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";

import { useAccountsStore, type Account, type AccountStatus, type Platform } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";

const store = useAccountsStore();
const daemon = useDaemonStore();

const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "视频号",
};

const STATUS_META: Record<
  AccountStatus,
  { label: string; type: "success" | "warning" | "info" | "danger" }
> = {
  active: { label: "可用", type: "success" },
  needs_relogin: { label: "需重新扫码", type: "warning" },
  disabled: { label: "已停用", type: "info" },
};

const form = reactive<{ platform: Platform; name: string }>({
  platform: "douyin",
  name: "",
});

function platformLabel(p: Platform): string {
  return PLATFORM_LABELS[p] ?? p;
}

function statusMeta(s: AccountStatus) {
  return STATUS_META[s] ?? { label: s, type: "info" as const };
}

async function addAccount(): Promise<void> {
  try {
    const account = await store.createAccount({
      platform: form.platform,
      name: form.name.trim() || undefined,
    });
    form.name = "";
    if (account.launch_warning) {
      ElMessage.warning(
        `账号已添加，但拉起 Chrome 失败：${account.launch_warning}`,
      );
    } else {
      ElMessage.success("账号已添加，请在弹出的 Chrome 中扫码登录");
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function removeAccount(account: Account): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除账号「${account.name}」（${platformLabel(account.platform)}）？将移除记录并关闭其关联 Chrome。`,
      "删除账号",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await store.removeAccount(account.id);
    ElMessage.success("账号已删除");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function reloginAccount(account: Account): Promise<void> {
  try {
    const result = await store.relogin(account.id);
    if (result.launch_warning) {
      ElMessage.warning(`拉起 Chrome 失败：${result.launch_warning}`);
    } else {
      ElMessage.success(
        `已拉起「${platformLabel(account.platform)}」的 Chrome，请完成扫码登录后点「恢复可用」`,
      );
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function markActive(account: Account): Promise<void> {
  try {
    await store.setStatus(account.id, "active");
    ElMessage.success("账号已恢复可用");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() => {
  void store.fetchAccounts();
});

watch(
  () => daemon.connected,
  (connected) => {
    if (connected) void store.fetchAccounts();
  },
);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div class="card__header">
        <span>账号管理</span>
        <el-button
          size="small"
          text
          :loading="store.loading"
          @click="store.fetchAccounts"
        >
          刷新
        </el-button>
      </div>
    </template>

    <div class="accounts__form">
      <el-select v-model="form.platform" class="accounts__platform" aria-label="平台">
        <el-option
          v-for="(label, value) in PLATFORM_LABELS"
          :key="value"
          :label="label"
          :value="value"
        />
      </el-select>
      <el-input
        v-model="form.name"
        class="accounts__name"
        placeholder="账号备注（可留空）"
        clearable
        @keyup.enter="addAccount"
      />
      <el-button
        type="primary"
        :loading="store.creating"
        :disabled="!daemon.connected"
        @click="addAccount"
      >
        添加账号
      </el-button>
    </div>
    <p class="accounts__hint">
      添加后应用将拉起独立本机 Chrome，请在弹出的浏览器中扫码登录；
      登录态保存在独立 profile，重启应用无需重复扫码。
    </p>

    <el-table
      v-if="store.accounts.length > 0"
      :data="store.accounts"
      size="small"
      class="accounts__table"
    >
      <el-table-column label="平台" width="110">
        <template #default="{ row }">
          {{ platformLabel(row.platform) }}
        </template>
      </el-table-column>
      <el-table-column prop="name" label="账号标识" min-width="140" />
      <el-table-column label="调试端口" width="110">
        <template #default="{ row }">
          <code>{{ row.cdp_port }}</code>
        </template>
      </el-table-column>
      <el-table-column label="登录状态" width="120">
        <template #default="{ row }">
          <el-tag :type="statusMeta(row.status).type" size="small">
            {{ statusMeta(row.status).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190" align="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'needs_relogin'"
            size="small"
            text
            type="warning"
            @click="reloginAccount(row)"
          >
            重新扫码
          </el-button>
          <el-button
            v-if="row.status === 'needs_relogin'"
            size="small"
            text
            type="success"
            @click="markActive(row)"
          >
            恢复可用
          </el-button>
          <el-button
            size="small"
            text
            type="danger"
            @click="removeAccount(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty
      v-else
      description="暂无账号，添加一个平台账号开始使用"
      :image-size="60"
    />

    <p v-if="store.error" class="accounts__error">{{ store.error }}</p>
  </el-card>
</template>

<style scoped>
.accounts__form {
  display: flex;
  gap: 8px;
  align-items: center;
}

.accounts__platform {
  width: 120px;
}

.accounts__name {
  flex: 1;
}

.accounts__hint {
  margin: 8px 0 16px;
  color: #909399;
  font-size: 12px;
}

.accounts__table {
  margin-top: 8px;
}

.accounts__error {
  margin: 8px 0 0;
  color: #f56c6c;
  font-size: 12px;
}
</style>
