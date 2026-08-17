/**
 * 领域类型（单一来源）—— 对应 CONTEXT.md 术语与 daemon REST 契约。
 * 与后端字段命名保持一致（snake_case）。
 */

export type Platform = "douyin" | "xiaohongshu" | "wechat" | "kuaishou";

/**
 * 官方平台类型号（user_info.type）：1 小红书 2 视频号 3 抖音 4 快手。
 * @see daemon/sau_backend.py:387 /login 注释
 */
export type OfficialPlatformType = 1 | 2 | 3 | 4;

export type JobStatus =
  | "pending"
  | "publishing"
  | "success"
  | "failed"
  | "manual"
  | "needs_relogin"
  | "missed";
export type TaskStatus = JobStatus | "partial";
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

export interface DaoUserInfo {
  id: number;
  type: OfficialPlatformType;
  /** 相对 daemon/conf BASE_DIR/cookiesFile 的 cookie 文件名。 */
  filePath: string;
  /** 官方 /login 的 id 参数 = 账号名（user_info.userName）。 */
  userName: string;
  /** 1 有效 / 0 无效（官方 getValidAccounts 校验后落库）。 */
  status: number;
}

/**
 * 平台展示名（单一来源）。值来自官方 `myUtils/login.py` 的 4 种登录生成器。
 * @see daemon/sau_backend.py:387
 */
export const OFFICIAL_PLATFORM_NAMES: Record<OfficialPlatformType, string> = {
  1: "小红书",
  2: "视频号",
  3: "抖音",
  4: "快手",
};

/** 前端 Platform -> 官方 type 号（登录时 /login?type= 所需）。 */
export const OFFICIAL_PLATFORM_TYPE: Record<Platform, OfficialPlatformType> = {
  xiaohongshu: 1,
  wechat: 2,
  douyin: 3,
  kuaishou: 4,
};

/** 官方 type 号 -> 前端 Platform（列表展示映射）。 */
export const OFFICIAL_TYPE_PLATFORM: Record<OfficialPlatformType, Platform> = {
  1: "xiaohongshu",
  2: "wechat",
  3: "douyin",
  4: "kuaishou",
};

/**
 * 官方账号展示模型：合并 user_info 与 cookie 校验结果，供 UI 使用。
 * 兼容旧 `Account` 核心字段（id/name/platform/status），发布页复用不受影响。
 */
export interface OfficialAccount {
  id: number;
  platform: Platform;
  /** 显示名 = 官方账号名（userInfo.userName）。 */
  name: string;
  /** 官方平台类型号（原样保留，便于排查）。 */
  typeNum: OfficialPlatformType;
  /** cookie 文件相对名（BASE_DIR/cookiesFile 下）。 */
  cookieFile: string;
  /** 上次校验时的 cookie 有效性（true=可用）。 */
  cookieValid: boolean;
  /** 官方存储的校验状态：1 有效 / 0 无效。 */
  status: number;
  profile_dir: string;
  cdp_port: number;
  chrome_path: string | null;
  last_login_at: string | null;
  last_publish_at: string | null;
  created_at: string;
  updated_at: string;
}

export type Account = OfficialAccount;

export interface OfficialApiResponse<T> {
  code: number;
  msg: string | null;
  data: T;
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
