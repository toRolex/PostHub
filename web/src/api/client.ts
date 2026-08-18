/**
 * 官方后端 seam 客户端 —— 统一 fetch + 错误约定（`body.error` 或 `HTTP {status}`）。
 * 每个端点显式接收 baseUrl（来自 daemon store），避免模块间循环依赖。
 *
 * 本模块只保留官方后端 seam 端点（cookie 导入/导出，直连 sau_backend）；
 * 旧 daemon 自研端点（tasks/logs/interventions/batches/platform-constraints）已被删除。
 */
import type { OfficialAccountRow } from "./types";

/**
 * 官方后端 seam 请求包装：官方路由返回 `{code, msg, data}`，且 code!=200 时
 * HTTP 状态码非 2xx（如 /uploadCookie 缺参返回 400）。统一在此收敛：
 * - HTTP 非 2xx 或 code!=200 → 抛错，优先透传官方 msg。
 * 注：仅用于 JSON 端点（getAccounts/getValidAccounts/uploadCookie）；
 * downloadCookie 直接 fetch 取文件，不经此包装。
 */
async function officialRequest<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text().catch(() => "");
  let body: { code?: number; msg?: string | null; data?: unknown } = {};
  if (text) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // 非 JSON 响应按空处理：视为无错误体
    }
  }
  if (!res.ok || (typeof body.code === "number" && body.code !== 200)) {
    const label = body.msg ?? `官方后端错误（HTTP ${res.status}）`;
    throw new Error(label);
  }
  return body.data as T;
}

export const api = {
  // ── 官方后端 seam（cookie 导入/导出，直连 sau_backend）─────────────────────

  /** 官方 `/getAccounts`：user_info 全部行（原样数组行，不校验 cookie）。 */
  officialAccounts: (base: string) =>
    officialRequest<OfficialAccountRow[]>(base, "/getAccounts"),

  /** 官方 `/getValidAccounts`：逐行 check_cookie 校验，失效行 status 置 0。 */
  officialValidAccounts: (base: string) =>
    officialRequest<OfficialAccountRow[]>(base, "/getValidAccounts"),

  /**
   * 官方 `/uploadCookie`：把所选 cookie 文件写入该账号的 filePath。
   * multipart：file（.json 文件）+ id（user_info.id）+ platform（官方 type）。
   */
  uploadCookie: (base: string, file: File, id: number, platform: number) => {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("id", String(id));
    form.append("platform", String(platform));
    return officialRequest<null>(base, "/uploadCookie", { method: "POST", body: form });
  },

  /**
   * 官方 `/downloadCookie`：按 filePath 下载 cookie 文件附件（备份/迁移）。
   * 返回 res，由调用方落盘。
   */
  downloadCookie: (base: string, filePath: string) =>
    fetch(`${base}/downloadCookie?filePath=${encodeURIComponent(filePath)}`),
};
