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

/**
 * 选择本地 Chrome 可执行文件路径（登录/上传用，作为 `LOCAL_CHROME_PATH`）。
 * 跨平台：Windows 选 `chrome.exe`，macOS 选 `Google Chrome.app` 内的二进制。
 * 不限定扩展名，让用户定位到具体可执行文件。
 */
export async function pickChromePath(): Promise<string | null> {
  return pickFile({ title: "选择 Chrome 可执行文件（chrome.exe / Chrome 二进制）" });
}

async function pickFile(opts: OpenDialogOptions): Promise<string | null> {
  if (!isTauri()) {
    throw new Error("仅桌面应用环境支持路径选择");
  }
  const selected = await open({ multiple: false, ...opts });
  return typeof selected === "string" ? selected : null;
}
