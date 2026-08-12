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

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:8756";

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
