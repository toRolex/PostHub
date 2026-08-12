import { cn } from "../../lib/utils";
import type { AccountStatus, JobStatus, TaskStatus } from "../../api/types";

export interface StatusMeta {
  /** 色点背景（浅档语义色） */
  dot: string;
  /** 标签文字（同色相加深档，保证对比） */
  text: string;
  label: string;
  pulse?: boolean;
}

export const TASK_STATUS_META: Record<TaskStatus, StatusMeta> = {
  pending: { dot: "bg-info", text: "text-muted", label: "待发布" },
  publishing: {
    dot: "bg-accent",
    text: "text-accent-ink",
    label: "发布中",
    pulse: true,
  },
  success: { dot: "bg-success", text: "text-success-deep", label: "成功" },
  failed: { dot: "bg-danger", text: "text-danger-deep", label: "失败" },
  manual: { dot: "bg-warn", text: "text-warn-deep", label: "需人工" },
  needs_relogin: { dot: "bg-warn", text: "text-warn-deep", label: "需重登" },
  missed: { dot: "bg-meta", text: "text-muted", label: "错过" },
  partial: { dot: "bg-warn", text: "text-warn-deep", label: "部分成功" },
};

export const ACCOUNT_STATUS_META: Record<AccountStatus, StatusMeta> = {
  active: { dot: "bg-success", text: "text-success-deep", label: "可用" },
  needs_relogin: { dot: "bg-warn", text: "text-warn-deep", label: "需重新扫码" },
  disabled: { dot: "bg-meta", text: "text-muted", label: "已停用" },
};

export const JOB_STATUS_META = TASK_STATUS_META as Record<JobStatus, StatusMeta>;

interface StatusProps {
  meta: StatusMeta;
  className?: string;
}

/** 签名组件：语义色点 + 标签；发布中带脉冲动效。 */
function Status({ meta, className }: StatusProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-label font-medium",
        meta.text,
        className,
      )}
    >
      <span
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          meta.dot,
          meta.pulse && "animate-pulse-dot",
        )}
      />
      {meta.label}
    </span>
  );
}

export { Status };
