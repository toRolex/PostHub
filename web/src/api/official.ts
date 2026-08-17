/**
 * 面向官方后端 seam 的 REST 客户端（ticket 07：文件页）。
 *
 * 契约以 daemon/sau_backend.py（官方上游原样拷贝）为准，与自研 daemon REST
 * （client.ts，/files /tasks 等）相互独立：
 *
 *   - POST /uploadSave        multipart 上传 → 存 disk/videoFile + 写 file_records 表；
 *   - GET  /getFiles          列出 file_records 全量（含 uuid 派生字段）；
 *   - GET  /deleteFile?id=N   删磁盘文件 + 删数据库记录；
 *   - GET  /getFile?filename= 返回文件内容（预览/下载）。
 *
 * 统一响应 `{ code, msg, data }`：code=200 成功；否则视为错误并抛 msg（或 HTTP 状态）。
 */
import type { OfficialFileRecord } from "./types";

interface OfficialResponse<T> {
  code: number;
  msg: string | null;
  data: T;
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(`${base}${path}`, init) : await fetch(`${base}${path}`);
  const body = (await res.json()) as OfficialResponse<T>;
  if (!res.ok || body.code !== 200) {
    throw new Error(body?.msg || `HTTP ${res.status}`);
  }
  return body.data;
}

export const officialApi = {
  /** 列出官方素材库（file_records 全量）。 */
  getFiles: (base: string): Promise<OfficialFileRecord[]> =>
    request<OfficialFileRecord[]>(base, "/getFiles"),

  /** 上传并记录素材：走 /uploadSave，文件同时进入磁盘与官方 file_records。 */
  upload: (base: string, file: File, customName?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (customName) form.append("filename", customName);
    return request<{ filename: string; filepath: string }>(base, "/uploadSave", {
      method: "POST",
      body: form,
    });
  },

  /** 删除素材：磁盘文件 + 数据库记录一起删。 */
  deleteFile: (base: string, id: number) =>
    request<{ id: number; filename: string }>(base, `/deleteFile?id=${id}`),

  /** 素材下载/预览地址（GET /getFile）。 */
  fileUrl: (base: string, filePath: string) =>
    `${base}/getFile?filename=${encodeURIComponent(filePath)}`,
};