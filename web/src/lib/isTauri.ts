/** 运行环境判定：Tauri 桌面壳 vs 浏览器开发环境。 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
