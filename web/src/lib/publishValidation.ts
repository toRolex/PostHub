/**
 * 发布表单校验（纯函数，引用平台约束注册表）。
 *
 * 前端校验为主：表单按所选平台动态显示约束并拦截非法输入；后端 create_task
 * 二次校验兜底（防御性）。校验规则与 daemon/posthub/constraints.py 一致：
 *
 * - min_lead_time：定时最小提前量；有效最小提前量 = max(min_lead_time, schedule_min)
 * - 定时窗口：publish_at - now 必须在 [有效最小, schedule_max] 内
 * - 每日上限（视频号 5 条/日）本票件只展示约束，具体调度侧限制属 #17
 */

import type { Platform, PlatformConstraint } from "../api/types";

export const HOUR = 3600;

export type SchedulePolicy = "immediate" | "scheduled";
export type CoverMode = "file" | "auto";

export interface PublishFormValues {
  title: string;
  videoPath: string;
  caption: string;
  coverMode: CoverMode;
  coverHorizontal: string;
  coverVertical: string;
  selectedPlatforms: Platform[];
  accountByPlatform: Partial<Record<Platform, number | null>>;
  schedulePolicy: SchedulePolicy;
  publishAt: string | null; // YYYY-MM-DD HH:MM:SS
}

/** 有效最小提前量 = max(min_lead_time, schedule_min)。 */
export function effectiveMinLeadSeconds(c: PlatformConstraint): number {
  return Math.max(c.min_lead_time_seconds, c.schedule_min_seconds);
}

/** 本地时间格式化为 `YYYY-MM-DD HH:MM:SS`（与 daemon 存储约定一致）。 */
export function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 解析 `YYYY-MM-DD HH:MM:SS` 为本地时间 Date。 */
export function parseDateTime(s: string): Date {
  const [datePart, timePart] = s.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, ss);
}

/**
 * 校验发布表单，返回错误消息列表（空 = 通过）。
 * `constraints` 为平台约束注册表（经 daemon IPC 拉取），`now` 可注入便于测试。
 */
export function validatePublishForm(
  form: PublishFormValues,
  constraints: Partial<Record<Platform, PlatformConstraint>>,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];

  if (!form.title.trim()) {
    errors.push("标题不能为空");
  }
  if (!form.videoPath) {
    errors.push("请选择视频文件");
  }
  if (form.selectedPlatforms.length === 0) {
    errors.push("至少选择一个发布平台");
  }

  if (form.schedulePolicy === "scheduled") {
    if (!form.publishAt) {
      errors.push("定时发布请选择发布时间");
    } else {
      const lead = Math.floor(
        (parseDateTime(form.publishAt).getTime() - now.getTime()) / 1000,
      );
      for (const p of form.selectedPlatforms) {
        const c = constraints[p];
        if (!c) continue;
        const effMin = effectiveMinLeadSeconds(c);
        if (lead < effMin) {
          errors.push(
            `${c.label} 定时发布时间距现在至少 ${Math.floor(effMin / HOUR)} 小时`,
          );
        } else if (lead > c.schedule_max_seconds) {
          errors.push(
            `${c.label} 定时窗口最大 ${Math.floor(c.schedule_max_seconds / HOUR)} 小时`,
          );
        }
      }
    }
  }

  for (const p of form.selectedPlatforms) {
    if (form.accountByPlatform[p] == null) {
      errors.push(`请为平台「${p}」选择账号`);
      break;
    }
  }

  return errors;
}
