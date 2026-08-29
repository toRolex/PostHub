/**
 * 官方 seam API 客户端 —— 对接 daemon/sau_backend.py 的官方接口。
 *
 * 参考契约（P2/P5 阅读 daemon/sau_backend.py 确认）：
 * - GET /getAccounts         -> { code, msg, data: Array<[id,type,filePath,userName,status]> }
 *   仅读库，不做 cookie 校验（快速列表）。
 * - GET /getValidAccounts    -> 同结构；先验证 cookie，失效时把 user_info.status 落库为 0。
 * - GET /deleteAccount?id=N  -> { code, msg, data }，删除账号 + 关联 cookie 文件。
 * - GET /login?type=N&id=账号名 -> text/event-stream（轮询式 SSE）：
 *   `data: <二维码 base64/src>` -> `data: "200"`（成功）或 `data: "500"`（失败/超时）。
 *   type：1 小红书 2 视频号 3 抖音 4 快手；id = 账号名（写入 user_info.userName）。
 * - POST /uploadSave        multipart 上传 → 存 disk/videoFile + 写 file_records 表；
 * - GET  /getFiles          列出 file_records 全量（含 uuid 派生字段）；
 * - GET  /deleteFile?id=N   删磁盘文件 + 删数据库记录；
 * - GET  /getFile?filename= 返回文件内容（预览/下载）。
 *
 * 前端到官方后端的唯一 HTTP seam：所有官方端点（含 cookie 导入/导出）都经
 * `officialApi`；统一响应 `{ code, msg, data }`：code=200 成功；否则视为错误并抛 msg
 * （错误解析约定单点在 `request<T>`，downloadCookie 的文件流除外）。
 * 设计：SSE 相关纯函数（parseSseDataLine/parseSseChunk）可单测；`openLoginSse`
 * 返回可中止句柄。
 */
import type {
  DaoUserInfo,
  OfficialFileRecord,
  OfficialPlatformType,
  Platform,
} from "./types";
import { OFFICIAL_PLATFORM_TYPE } from "./types";
import { trimPlatformFields, type PlatformFields } from "../domain/declarations";
import { parseTags } from "../domain/tags";
import { buildBatchItemRefs, type BatchItem } from "../domain/batch";
import {
  nearestWholeHour,
  normalizeDailyTimes,
  normalizeHHMM,
  resolveWechatTimer,
  type WechatTimerResolution,
} from "../domain/time";

/** 官方 /login SSE 事件类型。 */
export type LoginSseEvent =
  | { kind: "qr"; src: string }
  | { kind: "success" }
  | { kind: "failed" };

/** 单个 SSE 事件所携带的二维码数据源（base64 data URL 或 https URL）。 */
export interface LoginQr {
  src: string;
}

/** 登录 SSE 会话句柄：订阅二维码与结果，可中止。 */
export interface LoginSseHandle {
  /** 首个二维码帧（通常也是唯一一帧）。 */
  readQr: Promise<LoginQr>;
  /** 轮询结果：真=成功、假=失败/超时，或 reject（网络错误）。 */
  readResult: Promise<boolean>;
  /** 关闭连接（取消订阅）——关闭 dialog 时应调用。 */
  abort: () => void;
}

/** 解析单个 SSE 行："data: xxx"。非法/注释行返回 null。 */
export function parseSseDataLine(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  return payload === "" ? null : payload;
}

/**
 * 从 SSE 文本块中提取「完整消息」（以空行分隔）。返回本次新增的完整消息；
 * 未闭合的尾部缓冲由调用方通过 `takeTrailing` 保留，跨网络分片时下个 chunk 续拼。
 */
export function parseSseChunk(chunk: string): LoginSseEvent[] {
  const events: LoginSseEvent[] = [];
  let buffer = "";
  let hasDataInMessage = false;
  for (const rawLine of chunk.split(/\r?\n/)) {
    if (rawLine === "") {
      // 消息结束（空行分隔）。官方服务端每条消息以一个 `\n\n` 结束。
      if (hasDataInMessage && buffer !== "") {
        const parsed = parseSsePayload(buffer);
        if (parsed) events.push(parsed);
      }
      buffer = "";
      hasDataInMessage = false;
      continue;
    }
    const line = rawLine.trimStart();
    if (!line.startsWith(":")) {
      const data = parseSseDataLine(line);
      if (data !== null) {
        buffer += (buffer === "" ? "" : "\n") + data;
        hasDataInMessage = true;
      }
      // 其它字段（event:/id:/retry:）忽略——官方只发 `data:`。
    }
  }
  return events;
}

/** 把单条 SSE 消息 payload 转成登录事件。 */
export function parseSsePayload(payload: string): LoginSseEvent | null {
  if (payload === "200") return { kind: "success" };
  if (payload === "500") return { kind: "failed" };
  // 其余 payload 视为二维码 src（base64 data URL / http URL / 纯文本）。
  if (payload.length > 0) return { kind: "qr", src: payload };
  return null;
}

/**
 * 打开 /login 的 SSE 流并解析二维码/结果事件。
 *
 * 官方是「轮询式 SSE」：每条帧立即推送，不按固定间隔刷新；
 * 登录完成后推 `"200"`（成功）终止。这里只用主线程一个 fetch 读取，
 * 事件流由 `parseSseChunk` 增量解析；网络中断或服务端关流时按失败处理。
 */
export async function openLoginSse(options: {
  url: string;
  type: OfficialPlatformType;
  accountName: string;
  signal?: AbortSignal;
}): Promise<LoginSseHandle> {
  const { url, type, accountName, signal } = options;
  const params = new URLSearchParams({ type: String(type), id: accountName });
  const ctrl = new AbortController();
  signal?.addEventListener("abort", () => ctrl.abort());

  const res = await fetch(`${url}/login?${params.toString()}`, {
    headers: { Accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`登录 SSE 建立失败: HTTP ${res.status}`);
  }

  let resolveQr!: (qr: LoginQr) => void;
  let rejectQr!: (e: Error) => void;
  let resolveResult!: (ok: boolean) => void;
  let rejectResult!: (e: Error) => void;
  const qrDone = new Promise<LoginQr>((r, j) => {
    resolveQr = r;
    rejectQr = j;
  });
  const resultDone = new Promise<boolean>((r, j) => {
    resolveResult = r;
    rejectResult = j;
  });
  // 标记已处理，避免调用方只消费其中一条 promise 时触发 unhandled rejection；
  // await 该 promise 的真实调用方仍能正常收到值或异常。
  qrDone.catch(() => {});
  resultDone.catch(() => {});

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let qrResolved = false;
  let resultResolved = false;

  async function pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        for (const ev of parseSseChunk(sseBuffer)) {
          if (!qrResolved && ev.kind === "qr") {
            qrResolved = true;
            resolveQr({ src: ev.src });
          }
          if (!resultResolved && (ev.kind === "success" || ev.kind === "failed")) {
            resultResolved = true;
            resolveResult(ev.kind === "success");
          }
        }
        // 保留未闭合的尾部缓冲：一个消息可能跨多个网络分片到达。
        sseBuffer = takeTrailing(sseBuffer);
        // 官方 /login 的 sse_stream 是死循环（不主动关流）；拿到结果后立刻断开，
        // 避免连接与官方 active_queues 项残留到 dialog 关闭才释放。
        if (resultResolved) {
          ctrl.abort();
          break;
        }
      }
      // 流正常结束：登录流程完成前就断流 -> 视为失败（避免悬挂）。
      if (!resultResolved) {
        resultResolved = true;
        resolveResult(false);
      }
      if (!qrResolved) {
        qrResolved = true;
        rejectQr(new Error("登录流未返回二维码"));
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!qrResolved) {
        qrResolved = true;
        rejectQr(err);
      }
      if (!resultResolved) {
        resultResolved = true;
        rejectResult(err);
      }
    } finally {
      ctrl.abort(); // 读取结束即断开
    }
  }
  void pump();

  return {
    readQr: qrDone,
    readResult: resultDone,
    abort: () => {
      ctrl.abort();
      // 未完成的 promise 以错误结束，避免界面悬挂。
      if (!qrResolved) {
        qrResolved = true;
        rejectQr(new Error("登录已取消"));
      }
      if (!resultResolved) {
        resultResolved = true;
        rejectResult(new Error("登录已取消"));
      }
    },
  };
}

/** 官方 JSON 错误：保留 HTTP status、响应 code 与 data，供冲突 UI 使用。 */
export class OfficialApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, status: number, code: number, data: unknown) {
    super(message);
    this.name = "OfficialApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** 从 409 受理冲突中提取后端保留的已有 run id。 */
export function existingRunIdFromError(error: unknown): string | undefined {
  if (!(error instanceof OfficialApiError) || error.status !== 409) return undefined;
  const data = error.data;
  if (!data || typeof data !== "object") return undefined;
  const runId = (data as { existingRunId?: unknown }).existingRunId;
  return typeof runId === "string" && runId ? runId : undefined;
}

interface RequestOptions {
  signal?: AbortSignal;
}

export type RunStatus = "pending" | "running" | "completed" | "completed_with_failures";
export type RunItemStatus = "pending" | "running" | "success" | "failed";

export interface AcceptedRun {
  runId: string;
  status: "pending" | "running";
  itemCount: number;
}

export interface RunSummary {
  itemCount: number;
  pendingCount: number;
  runningCount: number;
  successCount: number;
  failedCount: number;
  completedCount: number;
}

export interface RunItemDiagnostic {
  level: "warning" | "info";
  kind: string;
  account?: string;
  reason?: string;
  message?: string;
  selector?: string;
  entrySelector?: string;
  selectors?: string[];
  requestedValue?: string;
  displayValue?: string;
  screenshot?: string | null;
}

export interface RunItemSnapshot {
  itemId: string;
  /** 人类可读的 1-based 执行顺序。旧 daemon 响应可能没有。 */
  seq?: number;
  status: RunItemStatus;
  /** 兼容旧 daemon 的错误字段；新响应与 errorSummary 相同。 */
  error: string | null;
  /** 单行短摘要，用于列表展示。 */
  errorSummary?: string | null;
  /** 可查询的完整错误（通常含 traceback）。 */
  errorDetail?: string | null;
  /** DOM wrapper warning/debug screenshot 等结构化诊断；旧 daemon 响应可能没有。 */
  diagnostics?: RunItemDiagnostic[];
  /** 受理时的调用方 payload 快照；旧 daemon 响应可能没有。 */
  submitted?: PostVideoRequest;
  /** 账号粒度 effective payload；抖音 timer 含 naive ISO publishDatetimes。 */
  effective?: PostVideoRequest & { publishDatetimes?: string[] };

}

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** 后端按持久化 run_items 聚合的事实汇总。 */
  summary: RunSummary;
  items: RunItemSnapshot[];
}

export type PublishRecordStatus = "scheduled" | "published" | "failed" | "canceled";

/** 本机 publish_record 的账号/时间快照；不随官方账号变更而更新。 */
export interface PublishRecord {
  id: number;
  accountId: number;
  accountFile: string;
  accountName: string;
  platform: Platform;
  videoId: string;
  videoTitle: string;
  effectiveScheduledFor: string;
  scheduledFor: string;
  status: PublishRecordStatus;
  publishedAt: string | null;
  runId: string | null;
  runItemId: string | null;
  recordedAt: string;
}

async function parseOfficialResponse<T>(res: Response): Promise<T> {
  // 先读文本再解析，避免 `res.json()` 直接抛在非 JSON 响应（如 500 错误页）上，
  // 也避免 `.catch(() => ({}))` 静默吞掉 HTTP 状态——统一走 `body.msg ?? HTTP {status}`。
  const text = await res.text().catch(() => "");
  let body: { code?: number; msg?: string | null; data?: unknown } = {};
  if (text) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // 非 JSON 响应按空处理：视为无错误体，靠 res.ok/status 判定
    }
  }
  if (!res.ok || (typeof body.code === "number" && body.code !== 200)) {
    const label = body.msg ?? `HTTP ${res.status}`;
    throw new OfficialApiError(label, res.status, body.code ?? res.status, body.data);
  }
  return body.data as T;
}

/** 拉取官方账号列表并映射为 DaoUserInfo。path 为 /getAccounts 或 /getValidAccounts。 */
async function fetchAccountRows(
  baseUrl: string,
  path: "/getAccounts" | "/getValidAccounts",
  opts?: RequestOptions,
): Promise<DaoUserInfo[]> {
  const res = await fetch(
    `${baseUrl}${path}`,
    opts && opts.signal ? { signal: opts.signal } : undefined,
  );
  const data = await parseOfficialResponse<unknown[]>(res);
  return mapRows(data, path);
}

/** 快速账号列表（不校验 cookie）。data: user_info 行数组。 */
export function getAccounts(
  baseUrl: string,
  opts?: RequestOptions,
): Promise<DaoUserInfo[]> {
  return fetchAccountRows(baseUrl, "/getAccounts", opts);
}

/** 有效账号列表（逐个校验 cookie，失效则落库 status=0）。 */
export function getValidAccounts(
  baseUrl: string,
  opts?: RequestOptions,
): Promise<DaoUserInfo[]> {
  return fetchAccountRows(baseUrl, "/getValidAccounts", opts);
}

/** 删除账号（仅 id），官方同时删除关联 cookie 文件。 */
export async function deleteAccount(
  baseUrl: string,
  id: number,
  opts?: RequestOptions,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/deleteAccount?id=${encodeURIComponent(id)}`,
    opts && opts.signal ? { signal: opts.signal } : undefined,
  );
  await parseOfficialResponse<unknown>(res);
}

/** 保留未闭合的 SSE 缓冲尾部：一个消息可能跨多个网络分片到达。 */
function takeTrailing(sseBuffer: string): string {
  const lastBreak = sseBuffer.lastIndexOf("\n\n");
  return lastBreak === -1 ? sseBuffer : sseBuffer.slice(lastBreak + 2);
}

/** 官方 user_info 行 [id,type,filePath,userName,status] -> DaoUserInfo。type 须在 1-4、status 须在 0/1 内，否则抛错。 */
const OFFICIAL_TYPE_VALUES = new Set<number>([1, 2, 3, 4]);

function mapRows(data: unknown[], from: string): DaoUserInfo[] {
  return data.map((row) => {
    if (!Array.isArray(row)) {
      throw new Error(`${from}: data 行应为数组，实际 ${typeof row}`);
    }
    const [id, type, filePath, userName, status] = row;
    const typeNum = Number(type);
    if (!OFFICIAL_TYPE_VALUES.has(typeNum)) {
      throw new Error(`${from}: 未知平台类型 ${typeNum}（应为 1-4）`);
    }
    const statusNum = Number(status);
    if (statusNum !== 0 && statusNum !== 1) {
      throw new Error(`${from}: 未知账号状态 ${statusNum}（应为 0/1）`);
    }
    return {
      id: Number(id),
      type: typeNum as DaoUserInfo["type"],
      filePath: String(filePath),
      userName: String(userName),
      status: statusNum as DaoUserInfo["status"],
    };
  });
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(`${base}${path}`, init) : await fetch(`${base}${path}`);
  return parseOfficialResponse<T>(res);
}

export const officialApi = {
  /**
   * 官方 `/uploadCookie`：把所选 cookie 文件写入该账号的 filePath。
   * multipart：file（.json 文件）+ id（user_info.id）+ platform（官方 type）。
   */
  uploadCookie: (base: string, file: File, id: number, platform: number) => {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("id", String(id));
    form.append("platform", String(platform));
    return request<null>(base, "/uploadCookie", { method: "POST", body: form });
  },

  /**
   * 官方 `/downloadCookie`：按 filePath 下载 cookie 文件附件（备份/迁移），返回 blob。
   * 不走 JSON 包装：成功是文件附件流，失败才是 {code,msg}；错误解析（!res.ok →
   * 官方 msg → throw）收敛在本函数内，调用方只管 blob 落盘。
   */
  downloadCookie: async (base: string, filePath: string): Promise<Blob> => {
    const res = await fetch(
      `${base}/downloadCookie?filePath=${encodeURIComponent(filePath)}`,
    );
    if (!res.ok) {
      // 官方 /downloadCookie 出错返回 {code, msg}（如「Cookie文件不存在」），优先透传官方 msg。
      const text = await res.text().catch(() => "");
      let msg = "";
      try {
        msg = (JSON.parse(text) as { msg?: string }).msg ?? "";
      } catch {
        // 非 JSON 错误体按空处理
      }
      throw new Error(msg || `下载失败（HTTP ${res.status}）`);
    }
    return res.blob();
  },

  getFiles: (base: string): Promise<OfficialFileRecord[]> =>
    request<OfficialFileRecord[]>(base, "/getFiles"),

  /** 查询本机 scheduled/published 记录；空结果是 []，查询失败由 request 抛错。 */
  getPublishRecords: (
    base: string,
    from: string,
    to: string,
  ): Promise<PublishRecord[]> =>
    request<PublishRecord[]>(
      base,
      `/publishRecords?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  /** 单视频发布：走官方 /postVideo（仅契约级提交，真实发布需登录态）。 */
  postVideo: (base: string, payload: PostVideoRequest) =>
    request<null>(base, "/postVideo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  /** PostHub-owned immediate accepted run：一次可受理一个或多个 item；200 仅表示已受理。 */
  acceptRun: (base: string, payload: PostVideoRequest | PostVideoRequest[]) =>
    request<AcceptedRun>(base, "/postRuns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  /** 查询 run/item 的持久化生命周期快照。 */
  getRun: (base: string, runId: string) =>
    request<RunSnapshot>(base, `/postRuns/${encodeURIComponent(runId)}`),
  /** 刷新后读取最近一次受理的 run；空库返回 null。 */
  getLatestRun: (base: string) => request<RunSnapshot | null>(base, "/postRuns/latest"),
  /** 批量发布：走官方 /postVideoBatch（请求体 = postVideo 对象数组，契约级提交）。 */
  postVideoBatch: (base: string, payload: PostVideoRequest[]) =>
    request<null>(base, "/postVideoBatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
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

  /** 更新账号的平台归属与名称：POST /updateUserinfo（官方 user_info 表改 type + userName）。 */
  updateAccount(base: string, payload: { id: number; type: OfficialPlatformType; userName: string }) {
    const { id, type, userName } = payload;
    return request<null>(base, "/updateUserinfo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, type, userName }),
    });
  },

  /**
   * 读取所有账号的「默认声明」JSON 字典（issue #43）。
   * 返回 `{[cookieFile: string]: PlatformFields}`；
   * 老库无 default_platform_fields 列时端点返 500，前端按空对象兜底。
   */
  getAccountDefaults: async (base: string): Promise<Record<string, PlatformFields>> => {
    try {
      return await request<Record<string, PlatformFields>>(base, "/getAccountDefaults");
    } catch {
      return {};
    }
  },

  /**
   * 持久化账号粒度默认声明：null 表示清除。
   */
  updateAccountDefaults: (
    base: string,
    payload: { id: number; default_platform_fields: PlatformFields | null },
  ): Promise<null> =>
    request<null>(base, "/updateAccountDefaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: payload.id,
        default_platform_fields: payload.default_platform_fields,
      }),
    }),

  getAccounts,
  getValidAccounts,
  deleteAccount,
  openLoginSse,
};

/* ───────────────────────── 单视频发布（/postVideo 契约）───────────────────────── */

/**
 * 官方 /postVideo 请求体（@see daemon/sau_backend.py:408 postVideo）。
 * 契约要点：
 * - `fileList`   素材数组（videoFile/ 下的磁盘文件名，postVideo.py 会拼接 BASE_DIR）。
 * - `accountList` 账号数组（cookiesFile/ 下的 cookie 文件名，postVideo.py 拼接 BASE_DIR）。
 * - `type`       平台整型：1 小红书 2 视频号 3 抖音 4 快手。
 * - `tags`       字符串数组（上线器逐项加 # 前缀）。
 * - `enableTimer` 为 false 时立即发布；true 才用到 videosPerDay/dailyTimes/startDays。
 *   dailyTimes 在 PostHub seam 上统一为 HH:MM 字符串数组，分钟必须保真；
 *   videosPerDay 每日条数（<=0 或 > len(dailyTimes) 时官方抛错），startDays 为起始天数（0 = 明天起）。
 * - `category=0` 官方会置为 None；typing 上沿用官方默认 LIFESTYLE。
 */
export interface PostVideoRequest {
  fileList: string[];
  accountList: string[];
  type: OfficialPlatformType;
  title: string;
  tags: string[];
  category?: number;
  enableTimer?: boolean;
  videosPerDay?: number;
  dailyTimes?: string[];
  startDays?: number;
  thumbnail?: string;
  isDraft?: boolean;
  productLink?: string;
  productTitle?: string;
  /** 平台内容声明按平台分键透传（issue #43 / ADR-0008）。任务级覆盖账号默认。 */
  platformFields?: PlatformFields;
  /** 视频号 timer 的原始时刻、最终整点与降级原因（PostHub-owned metadata）。 */
  timerOriginalTime?: string;
  timerFinalTime?: string;
  timerDowngradeReason?: string;
  /** 窗口风险仅提示，不阻断提交。 */
  timerWindowWarning?: string;
  /** 视频号各 dailyTimes 槽位的完整降级结果；首项字段保留兼容。 */
  timerResolutions?: WechatTimerResolution[];
  /** 绝对执行时刻快照；由 daemon 结合本地日期写入/消费。 */
  publishDatetimes?: string[];
}

/** 前端表单（发布页语义）→ 官方 /postVideo 请求体的纯函数。 */
export function buildPostVideoRequest(input: {
  platform: Platform;
  files: string[];
  accounts: string[];
  title: string;
  tags: string[];
  /** 正文/描述：官方 /postVideo 无独立 desc 字段，折叠进 title（title\ncaption）。 */
  caption?: string;
  thumbnail?: string;
  /** 任务级平台声明（覆盖账号 default_platform_fields）。 */
  platformFields?: PlatformFields;
  /**
   * 定时发布配置。启用时（enableTimer=true）随请求提交完整三字段；
   * 缺省/未启用时保持 enableTimer: false（立即发布）。
   */
  timer?: {
    enableTimer: boolean;
    videosPerDay: number;
    dailyTimes: string[];
    startDays: number;
  };
}): PostVideoRequest {
  // 官方单个发布动作只针对单一平台（type 唯一）；多平台则由页面拆成多次提交。
  const body: PostVideoRequest = {
    fileList: input.files,
    accountList: input.accounts,
    type: OFFICIAL_PLATFORM_TYPE[input.platform],
    title: mergeTitleWithCaption(input.title, input.caption),
    tags: input.tags ?? [],
    enableTimer: false,
  };
  if (input.thumbnail) body.thumbnail = input.thumbnail;
  // 启用定时发布：随请求提交官方 enableTimer 完整三字段。
  if (input.timer?.enableTimer) {
    body.enableTimer = true;
    body.videosPerDay = input.timer.videosPerDay;
    body.dailyTimes = normalizeDailyTimes(input.timer.dailyTimes);
    body.startDays = input.timer.startDays;
    if (input.platform === "wechat") {
      const resolutions: WechatTimerResolution[] = body.dailyTimes.map(resolveWechatTimer);
      const first = resolutions[0];
      // 保留原始 HH:MM 和用户 startDays 交给 daemon；daemon 是最终 effective
      // producer，避免前端先降级后端再次规范化时丢失原值或重复进位。
      if (first) {
        body.timerOriginalTime = first.originalTime;
        body.timerFinalTime = first.finalTime;
        body.timerDowngradeReason = first.reason;
        body.timerWindowWarning = first.warning;
        body.timerResolutions = resolutions;
      }
    }
  }
  // 平台声明：仅当调用方显式传入时透传。后端 `_merge_platform_fields` 会按
  // 「任务级 > 账号级 > 不传」合并，调用方未给 = 后端走账号默认。
  if (input.platformFields) body.platformFields = input.platformFields;
  return body;
}

/**
 * 标题 + 描述折叠：官方契约仅 title/tags 两处承载文本；正文（小红书/抖音以 title 作正文，
 * 视频号作标题）与标题拆分无官方字段承接，故合入 title 一并下发，避免信息丢失。
 */
export function mergeTitleWithCaption(title: string, caption?: string): string {
  const trimmed = caption?.trim();
  if (!trimmed) return title;
  return title ? `${title}\n${trimmed}` : trimmed;
}

/* ───────────────────────── 矩阵批量（每视频×每账号展开）───────────────────────── */

/**
 * 兼容旧官方整点 seam 的降级适配：HH:MM 取最近整点，30 分钟向后；
 * 新的 PostHub payload 不经过此函数，直接保留 HH:MM。
 */
export function parseHHMMToHour(hm: string): number {
  return nearestWholeHour(hm).hour;
}

/**
 * 矩阵批量表单 → 官方 /postVideoBatch 请求体（issue #38）。
 *
 * 与 buildPostVideoRequest（单视频）的语义差异：
 * - 旧：按平台笛卡尔展开（一个平台一项，fileList = 全部所选文件，accountList = 该平台账号）。
 * - 新：按「每视频×每账号」展开（一个 (item, platform, accountId) 一个 postVideo 项）；
 *       同一平台多账号展开为多个 postVideo 项（result 维度变化的原因）。
 *
 * 模式：
 * - mode='immediate'：enableTimer: false；严格不带 timer 四字段
 *   （enableTimer/videosPerDay/dailyTimes/startDays 都不在请求体键集合里）。
 * - mode='timer'：enableTimer: true；videosPerDay 硬写 1（不暴露）；dailyTimes
 *   从 item.timeOfDay 读取并保留分钟；startDays 透传。
 *
 * 校验：
 * - item.timeOfDay 必须命中规范化后的 dailyTimes 池（防止 UI 与提交语义漂移）。
 * - dailyTimes 中任一 HH:MM 非法时显式抛错。
 *
 * 命名约定：函数名 buildBatchItemsFromMatrix 沿用 issue #37 PRD 命名。
 */
export function buildBatchItemsFromMatrix(
  items: BatchItem[],
  dailyTimes: string[],
): PostVideoRequest[] {
  const dailyTimesSet = new Set(normalizeDailyTimes(dailyTimes));
  // 每账号一个 postVideo 项（矩阵维度 = 每视频×每账号）。
  return buildBatchItemRefs(items).map(({ item, platform, cookie }) =>
    buildOneMatrixItem(item, platform, cookie, dailyTimesSet),
  );
}

/** 单个 (item, platform, account) → PostVideoRequest。 */
function buildOneMatrixItem(
  item: BatchItem,
  platform: Platform,
  accountCookie: string,
  dailyTimesSet: Set<string>,
): PostVideoRequest {
  const tags = parseTags(item.tags);
  const base = {
    fileList: [item.filePath],
    accountList: [accountCookie],
    type: OFFICIAL_PLATFORM_TYPE[platform],
    title: mergeTitleWithCaption(item.title, item.caption),
    tags,
  };
  // 仅当该平台在 platformFields 中**实际存在子键**时才透传，避免把空对象
  // 发到后端覆盖账号默认。`kuaishou` 在 PlatformFields 形状内缺席。
  const trimmed =
    platform !== "kuaishou" && item.platformFields
      ? trimPlatformFields(item.platformFields, platform)
      : undefined;
  if (trimmed) {
    (base as PostVideoRequest).platformFields = trimmed;
  }

  if (item.mode === "immediate") {
    return { ...base, enableTimer: false };
  }

  // mode='timer'
  if (item.timeOfDay === undefined || item.startDays === undefined) {
    throw new Error(
      `mode='timer' 必须提供 startDays 与 timeOfDay（item=${item.filePath}）`,
    );
  }
  const timeOfDay = normalizeHHMM(item.timeOfDay);
  if (!dailyTimesSet.has(timeOfDay)) {
    throw new Error(
      `item.timeOfDay="${item.timeOfDay}" 不在 dailyTimes 池中（${Array.from(dailyTimesSet).join(", ")}）`,
    );
  }
  const timer = {
    enableTimer: true as const,
    videosPerDay: 1,
    dailyTimes: [timeOfDay],
    startDays: item.startDays,
  };
  if (platform !== "wechat") return { ...base, ...timer };

  const resolution = resolveWechatTimer(timeOfDay);
  return {
    ...base,
    ...timer,
    // 同一份 raw item 进入 daemon 后再产出 effective final，避免双重跨日进位。
    timerOriginalTime: resolution.originalTime,
    timerFinalTime: resolution.finalTime,
    timerDowngradeReason: resolution.reason,
    timerWindowWarning: resolution.warning,
    timerResolutions: [resolution],
  };
}
