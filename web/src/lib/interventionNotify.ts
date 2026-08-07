/**
 * 人工介入提示（issue #21）：验证码挂起 / 需重新扫码 的可观测呈现。
 *
 * 桌面端（Tauri）调用原生弹窗命令 `show_intervention_dialog`；浏览器开发环境
 * 回退为 Element Plus 消息弹窗。非 Tauri 时 `invoke` 会抛错，catch 后走回退。
 */
import { invoke } from "@tauri-apps/api/core";
import { ElMessageBox } from "element-plus";

import type { Intervention } from "../stores/interventions";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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
  const title = interventionTitle(iv);
  const message = interventionMessage(iv);
  if (isTauri()) {
    try {
      await invoke("show_intervention_dialog", {
        title,
        message,
        kind: iv.kind,
      });
      return;
    } catch {
      // Tauri 命令不可用 → 回退浏览器内提示
    }
  }
  await ElMessageBox.alert(message, title, {
    confirmButtonText: "知道了",
    type: iv.kind === "manual" ? "warning" : "error",
  }).catch(() => undefined);
}
