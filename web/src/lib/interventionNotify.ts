/**
 * 人工介入提示（issue #21）：验证码挂起 / 需重新扫码 的可观测呈现。
 *
 * 无原生弹窗命令（正式后端不提供弹窗能力），统一走应用内 Toast。
 */
import { useToastStore } from "../stores/toast";

import type { Intervention } from "../api/types";

export function interventionTitle(iv: Intervention): string {
  return iv.kind === "manual" ? "发布需要人工处理" : "账号需重新扫码";
}

export function interventionMessage(iv: Intervention): string {
  const platformLabel = iv.platform;
  const base =
    iv.message ||
    (iv.kind === "manual"
      ? "遇到验证码 / 风控拦截，请在浏览器中完成人工处理后重试该任务"
      : "登录态已失效，请在该账号的 Chrome 中重新扫码登录");
  return `[${platformLabel}] ${base}`;
}

export async function notifyIntervention(iv: Intervention): Promise<void> {
  const message = interventionMessage(iv);
  useToastStore.getState().show(
    message,
    iv.kind === "manual" ? "warn" : "err",
  );
}
