/**
 * 本地通知触发条件（#18 任务完成 / 需人工介入）。
 *
 * - `decideNotification`：纯函数，任务聚合状态变化 → 是否弹本地通知。
 *   真实弹窗不做自动化，只覆盖触发条件判断。
 * - `notifyLocal`：实际弹窗（Web Notification API），失败静默降级。
 */

export type TaskStatus =
  | "pending"
  | "publishing"
  | "success"
  | "failed"
  | "manual"
  | "needs_relogin"
  | "missed"
  | "partial";

export type NotifyKind = "success" | "warning" | "error" | "info";

export interface NotificationDecision {
  shouldNotify: boolean;
  kind: NotifyKind;
  title: string;
  body: string;
}

const NO_NOTIFY: NotificationDecision = {
  shouldNotify: false,
  kind: "info",
  title: "",
  body: "",
};

interface NotifyMeta {
  kind: NotifyKind;
  title: string;
  body: (title: string) => string;
}

const NOTIFIABLE: Partial<Record<TaskStatus, NotifyMeta>> = {
  success: {
    kind: "success",
    title: "发布完成",
    body: (t) => `任务「${t}」已全部发布完成`,
  },
  manual: {
    kind: "warning",
    title: "需要人工介入",
    body: (t) => `任务「${t}」需要人工处理（风控 / 验证码）`,
  },
  needs_relogin: {
    kind: "warning",
    title: "需要重新登录",
    body: (t) => `任务「${t}」登录态失效，请重新扫码`,
  },
  failed: {
    kind: "error",
    title: "发布失败",
    body: (t) => `任务「${t}」发布失败，请查看原因`,
  },
  missed: {
    kind: "warning",
    title: "发布错过",
    body: (t) => `任务「${t}」错过发布窗口`,
  },
};

/**
 * 判断任务状态变化是否触发本地通知。
 *
 * - prev 为 null（首次观测）不作为变更触发，避免应用启动时对历史终态任务轰炸。
 * - 仅「完成 / 需人工介入 / 失败 / 错过」等值得打扰的状态触发；进行中不触发。
 */
export function decideNotification(
  prev: TaskStatus | null,
  next: TaskStatus,
  taskTitle: string,
): NotificationDecision {
  if (prev === null || prev === next) return NO_NOTIFY;
  const meta = NOTIFIABLE[next];
  if (!meta) return NO_NOTIFY;
  return {
    shouldNotify: true,
    kind: meta.kind,
    title: meta.title,
    body: meta.body(taskTitle),
  };
}

/** 实际弹本地通知（Web Notification API）；不可用时静默降级为 console。 */
export function notifyLocal(decision: NotificationDecision): void {
  if (!decision.shouldNotify) return;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      // eslint-disable-next-line no-new
      new Notification(decision.title, { body: decision.body });
      return;
    }
    console.info(`[posthub-notify] ${decision.title}: ${decision.body}`);
  } catch {
    // 通知失败不阻塞业务
  }
}

/** 申请通知权限（用户首次打开任务页时调用一次）。 */
export async function requestNotifyPermission(): Promise<void> {
  try {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      await Notification.requestPermission();
    }
  } catch {
    // 忽略权限申请失败
  }
}
