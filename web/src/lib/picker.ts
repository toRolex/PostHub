/**
 * 文件 / 文件夹选择（Tauri v2 真实路径）。
 *
 * 浏览器原生 `<input type="file">` 在 Tauri v2 拿不到真实路径（`file.path` 已移除），
 * 桌面端改用 `@tauri-apps/plugin-dialog` 的 `open()` 返回绝对路径；非 Tauri
 * （浏览器开发环境）由组件回退原生 input。
 */
import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";

import { isTauri } from "./isTauri";

export async function pickVideoPath(): Promise<string | null> {
  return pickFile({
    title: "选择视频",
    filters: [{ name: "视频", extensions: ["mp4", "mov", "mkv", "avi", "webm"] }],
  });
}

export async function pickImagePath(): Promise<string | null> {
  return pickFile({
    title: "选择封面",
    filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
}

export async function pickFolderPath(): Promise<string | null> {
  return pickFile({ title: "选择批次文件夹", directory: true });
}

async function pickFile(opts: OpenDialogOptions): Promise<string | null> {
  if (!isTauri()) {
    throw new Error("仅桌面应用环境支持路径选择");
  }
  const selected = await open({ multiple: false, ...opts });
  return typeof selected === "string" ? selected : null;
}
