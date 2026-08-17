/**
 * 领域类型（单一来源）—— 对应 CONTEXT.md 术语与 daemon REST 契约。
 * 与后端字段命名保持一致（snake_case）。
 */

export type Platform = "douyin" | "xiaohongshu" | "wechat";

export type JobStatus =
  | "pending"
  | "publishing"
  | "success"
  | "failed"
  | "manual"
  | "needs_relogin"
  | "missed";
export type TaskStatus = JobStatus | "partial";
export type AccountStatus = "active" | "needs_relogin" | "disabled";
export type InterventionKind = "manual" | "needs_relogin";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type SchedulePolicy = "immediate" | "scheduled";
export type CoverMode = "file" | "auto";
export type PublishMode = "platform_time" | "local_time";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:5409";

export interface DaemonHealth {
  status: string;
  version: string;
  port?: number;
}

export interface PlatformConstraint {
  platform: Platform;
  label: string;
  min_lead_time_seconds: number;
  schedule_min_seconds: number;
  schedule_max_seconds: number;
  max_scheduled_per_day: number | null;
  cover_required: boolean;
  auto_cover_first_frame: boolean;
}

export type ConstraintMap = Partial<Record<Platform, PlatformConstraint>>;

export interface Account {
  id: number;
  platform: Platform;
  name: string;
  profile_dir: string;
  cdp_port: number;
  chrome_path: string | null;
  status: AccountStatus;
  last_login_at: string | null;
  last_publish_at: string | null;
  created_at: string;
  updated_at: string;
  launch_warning?: string;
}

export interface Task {
  id: number;
  title: string;
  media_type: string;
  video_path: string | null;
  image_paths: string | null;
  caption: string | null;
  tags: string | null;
  cover_horizontal: string | null;
  cover_vertical: string | null;
  schedule_policy: string;
  publish_mode: string;
  publish_at: string | null;
  silent: number;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface PlatformJob {
  id: number;
  task_id: number;
  account_id: number;
  platform: Platform;
  status: JobStatus;
  schedule_policy: string | null;
  publish_mode: string | null;
  publish_at: string | null;
  retry_at: string | null;
  title: string | null;
  caption: string | null;
  tags: string | null;
  cover_horizontal: string | null;
  cover_vertical: string | null;
  platform_fields: string | null;
  post_id: string | null;
  post_url: string | null;
  attempt_count: number;
  last_error: string | null;
  last_error_type: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface TaskItem {
  task: Task;
  jobs: PlatformJob[];
}

export interface TaskResult {
  task: Task;
  jobs: PlatformJob[];
}

export interface ManifestIssue {
  index: number | null;
  message: string;
}

export interface ManifestEntry {
  index: number;
  file: string;
  title: string;
  content: string | null;
  tags: string[];
  cover_landscape: string | null;
  cover_portrait: string | null;
  schedule: string | null;
  warnings: string[];
}

export interface ImportResult {
  version: number;
  entries: ManifestEntry[];
  hard_errors: ManifestIssue[];
}

export interface Intervention {
  id: number;
  kind: InterventionKind;
  job_id: number;
  task_id: number;
  account_id: number;
  platform: Platform;
  message: string | null;
  error_type: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

export interface LogEntry {
  id: number;
  task_id: number | null;
  job_id: number | null;
  level: LogLevel;
  source: string;
  message: string;
  created_at: string;
}

/**
 * 官方后端 user_info 的一行：`/getAccounts` / `/getValidAccounts` 官方实现
 * `[list(row) for row in rows]` 返回的是数组行（非对象），顺序与 db/createTable.py
 * 列顺序一致：`[id, type, filePath, userName, status]`。
 * 这是 cookie 导入/导出的账号维度：`filePath` = playwright storage_state
 * cookie 文件在 `BASE_DIR/cookiesFile/` 下的相对文件名（如 `xxx.json`）。
 */
export type OfficialAccountRow = readonly [
  id: number,
  type: OfficialPlatform,
  filePath: string,
  userName: string,
  status: OfficialCookieStatus,
];

/** 官方 user_info.type 释义：1 小红书 2 视频号 3 抖音 4 快手。 */
export type OfficialPlatform = 1 | 2 | 3 | 4;

/** 官方 user_info.status：1 有效 / 0 失效。 */
export type OfficialCookieStatus = 0 | 1;

/** 解析后的官方账号（cookie 维度）。type 用官方释义：1 小红书 2 视频号 3 抖音 4 快手。 */
export interface CookiedAccount {
  id: number;
  type: OfficialPlatform;
  filePath: string;
  userName: string;
  status: OfficialCookieStatus;
}

export interface CreateTaskPayload {
  title: string;
  video_path: string;
  caption: string;
  tags: string[];
  cover_horizontal: string | null;
  cover_vertical: string | null;
  schedule_policy: SchedulePolicy;
  publish_mode: PublishMode;
  publish_at: string | null;
  silent: boolean;
  jobs: { platform: Platform; account_id: number }[];
}
