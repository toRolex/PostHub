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
 * 与旧 daemon REST 客户端 `api/client.ts` 并存；本模块只承载官方 seam 相关端点。
 * 设计：SSE 相关纯函数（parseSseDataLine/parseSseChunk）可单测；`openLoginSse`
 * 返回可中止句柄。统一响应 `{ code, msg, data }`：code=200 成功；否则视为错误并抛 msg。
 */
import type {
  DaoUserInfo,
  OfficialApiResponse,
  OfficialFileRecord,
  OfficialPlatformType,
  Platform,
} from "./types";
import { OFFICIAL_PLATFORM_TYPE } from "./types";

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
  let sawData = false;
  for (const rawLine of chunk.split(/\r?\n/)) {
    if (rawLine === "") {
      // 消息结束（空行分隔）。官方服务端每条消息以一个 `\n\n` 结束。
      if (sawData && buffer !== "") {
        const parsed = parseSsePayload(buffer);
        if (parsed) events.push(parsed);
      }
      buffer = "";
      sawData = false;
      continue;
    }
    const line = rawLine.trimStart();
    if (!line.startsWith(":")) {
      const data = parseSseDataLine(line);
      if (data !== null) {
        buffer += (buffer === "" ? "" : "\n") + data;
        sawData = true;
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

interface RequestOptions {
  signal?: AbortSignal;
}

async function parseOfficialResponse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as OfficialApiResponse<T>;
  if (!res.ok || body.code !== 200) {
    throw new Error(body.msg ?? `HTTP ${res.status}`);
  }
  return body.data;
}

/** 快速账号列表（不校验 cookie）。data: user_info 行数组。 */
export async function getAccounts(
  baseUrl: string,
  opts?: RequestOptions,
): Promise<DaoUserInfo[]> {
  const res = await fetch(
    `${baseUrl}/getAccounts`,
    opts && opts.signal ? { signal: opts.signal } : undefined,
  );
  const data = await parseOfficialResponse<unknown[]>(res);
  return mapRows(data, "getAccounts");
}

/** 有效账号列表（逐个校验 cookie，失效则落库 status=0）。 */
export async function getValidAccounts(
  baseUrl: string,
  opts?: RequestOptions,
): Promise<DaoUserInfo[]> {
  const res = await fetch(
    `${baseUrl}/getValidAccounts`,
    opts && opts.signal ? { signal: opts.signal } : undefined,
  );
  const data = await parseOfficialResponse<unknown[]>(res);
  return mapRows(data, "getValidAccounts");
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

/** 官方 getAccounts 返回：[id, type, filePath, userName, status] 行 -> DaoUserInfo。 */
function mapRows(data: unknown[], from: string): DaoUserInfo[] {
  return data.map((row) => {
    if (!Array.isArray(row)) {
      throw new Error(`${from}: data 行应为数组，实际 ${typeof row}`);
    }
    const [id, type, filePath, userName, status] = row;
    return {
      id: Number(id),
      type: type as DaoUserInfo["type"],
      filePath: String(filePath),
      userName: String(userName),
      status: Number(status),
    };
  });
}

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
  getFiles: (base: string): Promise<OfficialFileRecord[]> =>
    request<OfficialFileRecord[]>(base, "/getFiles"),

  /** 单视频发布：走官方 /postVideo（仅契约级提交，真实发布需登录态）。 */
  postVideo: (base: string, payload: PostVideoRequest) =>
    request<null>(base, "/postVideo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  /** 批量发布：走官方 /postVideoBatch（请求体 = postVideo 对象数组，契约级提交）。 */
  postVideoBatch: (base: string, payload: PostVideoBatchRequest) =>
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
  dailyTimes?: string[] | null;
  startDays?: number;
  thumbnail?: string;
  isDraft?: boolean;
  productLink?: string;
  productTitle?: string;
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
}): PostVideoRequest {
  // 官方单个发布动作只针对单一平台（type 唯一）；多平台则由页面拆成多次提交。
  let title = input.title;
  const caption = input.caption?.trim();
  if (caption) {
    // 官方契约仅 title/tags 两处承载文本；正文（小红书/抖音以 title 作为正文，视频号作标题）
    // 与标题拆分无官方字段承接，故合入 title 一并下发，避免信息丢失。
    title = input.title ? `${input.title}\n${caption}` : caption;
  }
  const body: PostVideoRequest = {
    fileList: input.files,
    accountList: input.accounts,
    type: OFFICIAL_PLATFORM_TYPE[input.platform],
    title,
    tags: input.tags ?? [],
    enableTimer: false,
  };
  if (input.thumbnail) body.thumbnail = input.thumbnail;
  return body;
}

/* ───────────────────────── 批量发布（/postVideoBatch 契约）───────────────────────── */

/**
 * 官方 /postVideoBatch 请求体（@see daemon/sau_backend.py:519 postVideoBatch）。
 * 契约要点：请求体是 **JSON 数组**，每项即一个 /postVideo 形态对象（多文件 fileList ×
 * 多账号 accountList），后端对每项做 `files × accounts` 笛卡尔发布。
 * 响应统一 `{ code: 200, msg: null, data: null }`（异步 fire-and-forget，无逐子项状态）；
 * 非数组或请求级错误时按 `{ code, msg }` 返回（400/500）——由前端中继展示。
 */
export type PostVideoBatchRequest = PostVideoRequest[];

/**
 * 前端批量表单（多文件 + 多账号，可按平台勾选）→ 官方 /postVideoBatch 请求体。
 * 每选中一个平台生成一个数组项：fileList = 全部所选文件，accountList = 该平台所选账号
 * 的 cookie 文件名，type = 官方平台整型。标题/描述折叠与单视频规则一致（caption 合入 title）。
 */
export function buildPostVideoBatchRequest(input: {
  /** 多选素材 file_path（videoFile 磁盘名）。 */
  files: string[];
  title: string;
  caption?: string;
  tags: string[];
  /** 按平台分组的账号：每项 platform + 该平台所选账号 cookie 文件名。 */
  platforms: { platform: Platform; accounts: string[] }[];
}): PostVideoBatchRequest {
  let title = input.title;
  const caption = input.caption?.trim();
  if (caption) {
    title = input.title ? `${input.title}\n${caption}` : caption;
  }
  return input.platforms.map(({ platform, accounts }) => ({
    fileList: input.files,
    accountList: accounts,
    type: OFFICIAL_PLATFORM_TYPE[platform],
    title,
    tags: input.tags ?? [],
    enableTimer: false,
  }));
}
