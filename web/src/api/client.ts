/**
 * daemon REST 客户端 —— 统一 fetch + 错误约定（`body.error` 或 `HTTP {status}`）。
 * 每个端点显式接收 baseUrl（来自 daemon store），避免模块间循环依赖。
 */
import type {
  Account,
  AccountStatus,
  CreateTaskPayload,
  DaemonHealth,
  ImportResult,
  Intervention,
  LogEntry,
  Platform,
  PlatformConstraint,
  PlatformJob,
  TaskItem,
  TaskResult,
} from "./types";

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = init
    ? await fetch(`${base}${path}`, init)
    : await fetch(`${base}${path}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
  if (!res.ok) {
    throw new Error((body?.error as string) || `HTTP ${res.status}`);
  }
  return body as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export const api = {
  health: (base: string) => request<DaemonHealth>(base, "/health"),

  platformConstraints: (base: string) =>
    request<{ constraints: PlatformConstraint[] }>(base, "/platform-constraints"),

  accounts: (base: string) => request<{ accounts: Account[] }>(base, "/accounts"),
  createAccount: (base: string, payload: { platform: Platform; name?: string }) =>
    request<{ account: Account }>(base, "/accounts", jsonInit("POST", payload)),
  deleteAccount: (base: string, id: number) =>
    request<unknown>(base, `/accounts/${id}`, { method: "DELETE" }),
  reloginAccount: (base: string, id: number) =>
    request<{ ok: boolean; launch_warning?: string }>(
      base,
      `/accounts/${id}/relogin`,
      jsonInit("POST"),
    ),
  setAccountStatus: (base: string, id: number, status: AccountStatus) =>
    request<unknown>(base, `/accounts/${id}/status`, jsonInit("POST", { status })),

  tasks: (base: string, query: string) =>
    request<{ tasks: TaskItem[] }>(base, `/tasks${query}`),
  createTask: (base: string, payload: CreateTaskPayload) =>
    request<TaskResult>(base, "/tasks", jsonInit("POST", payload)),
  cancelTask: (base: string, taskId: number) =>
    request<unknown>(base, `/tasks/${taskId}/cancel`, jsonInit("POST")),
  retryJob: (base: string, jobId: number) =>
    request<{ job: PlatformJob }>(base, `/jobs/${jobId}/retry`, jsonInit("POST")),
  taskDetail: (base: string, taskId: number) =>
    request<TaskItem>(base, `/tasks/${taskId}`),

  batchImport: (base: string, payload: { folder_path: string; account_id: number }) =>
    request<ImportResult>(base, "/batches/import", jsonInit("POST", payload)),
  batchConfirm: (
    base: string,
    payload: {
      account_id: number;
      entries: {
        file: string;
        title: string;
        content: string | null;
        tags: string[];
        cover_landscape: string | null;
        cover_portrait: string | null;
        schedule: string | null;
        account_id: number;
        platform?: Platform;
      }[];
    },
  ) => request<{ task_ids: number[] }>(base, "/batches/confirm", jsonInit("POST", payload)),

  interventions: (base: string) =>
    request<{ interventions: Intervention[] }>(base, "/interventions"),
  acknowledgeIntervention: (base: string, id: number) =>
    request<unknown>(base, `/interventions/${id}/ack`, jsonInit("POST")),

  logs: (base: string, query: string) =>
    request<{ logs: LogEntry[] }>(base, `/logs${query}`),
};
