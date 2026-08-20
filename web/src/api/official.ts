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
  OfficialFileRecord,
  OfficialPlatformType,
  Platform,
} from "./types";
import { OFFICIAL_PLATFORM_TYPE } from "./types";
import type { BatchItem } from "../types/batch";

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

interface RequestOptions {
  signal?: AbortSignal;
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
    throw new Error(label);
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

/** 官方 user_info 行 [id,type,filePath,userName,status] -> DaoUserInfo。type 须在 1-4 内，否则抛错。 */
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
    return {
      id: Number(id),
      type: typeNum as DaoUserInfo["type"],
      filePath: String(filePath),
      userName: String(userName),
      status: Number(status),
    };
  });
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(`${base}${path}`, init) : await fetch(`${base}${path}`);
  return parseOfficialResponse<T>(res);
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

  /** 更新账号的平台归属与名称：POST /updateUserinfo（官方 user_info 表改 type + userName）。 */
  updateAccount(base: string, payload: { id: number; type: OfficialPlatformType; userName: string }) {
    const { id, type, userName } = payload;
    return request<null>(base, "/updateUserinfo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, type, userName }),
    });
  },

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
 *   @see daemon/.venv/.../utils/files_times.py `generate_schedule_time_next_day`：
 *   dailyTimes 为「整点小时」数组（0-23），videosPerDay 每日条数（<=0 或 > len(dailyTimes) 时官方抛错），
 *   startDays 为起始天数（0 = 明天起）。
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
  dailyTimes?: number[];
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
  /**
   * 定时发布配置。启用时（enableTimer=true）随请求提交完整三字段；
   * 缺省/未启用时保持 enableTimer: false（立即发布）。
   */
  timer?: {
    enableTimer: boolean;
    videosPerDay: number;
    dailyTimes: number[];
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
    body.dailyTimes = input.timer.dailyTimes;
    body.startDays = input.timer.startDays;
  }
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

/**
 * 前端 tags 输入态字符串 → 官方 tags 数组。按空白/逗号（中英文）拆，去前缀 `#`，去空白，去空串。
 */
export function parseTagsInput(tags: string): string[] {
  if (!tags) return [];
  return tags
    .split(/[\s,，]+/)
    .map((t) => t.replace(/^#+/, "").trim())
    .filter(Boolean);
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

/* ───────────────────────── 矩阵批量（每视频×每账号展开）───────────────────────── */

/**
 * 把 "HH:MM" 字符串解析为官方整型小时（0-23）。非整点按 Math.floor 取整；
 * 越界（>= 24 或负数 / 非数字）抛错。不静默丢弃（验收硬要求）。
 *
 * 例：parseHHMMToHour("10:00") -> 10；"14:30" -> 14；"24:00" -> 抛错。
 */
export function parseHHMMToHour(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`dailyTimes 格式非法：${hm}（应为 HH:MM）`);
  const hour = Number(m[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour >= 24) {
    throw new Error(`dailyTimes 越界：${hm}（小时应在 0–23）`);
  }
  // 分钟字段语义保留（用于将来支持半点等）；当前版本按整点取整，丢弃 minute。
  void m[2];
  return Math.floor(hour);
}

/**
 * 矩阵批量表单 → 官方 /postVideoBatch 请求体（issue #38）。
 *
 * 与旧 buildPostVideoBatchRequest 的语义差异：
 * - 旧：按平台笛卡尔展开（一个平台一项，fileList = 全部所选文件，accountList = 该平台账号）。
 * - 新：按「每视频×每账号」展开（一个 (item, platform, accountId) 一个 postVideo 项）；
 *       同一平台多账号展开为多个 postVideo 项（result 维度变化的原因）。
 *
 * 模式：
 * - mode='immediate'：enableTimer: false；严格不带 timer 四字段
 *   （enableTimer/videosPerDay/dailyTimes/startDays 都不在请求体键集合里）。
 * - mode='timer'：enableTimer: true；videosPerDay 硬写 1（不暴露）；dailyTimes
 *   从 item.timeOfDay 解析（按整点取整回官方 0–23 整数）；startDays 透传。
 *
 * 校验：
 * - item.timeOfDay 必须命中 dailyTimes 池（防止 UI 与提交语义漂移）。
 * - dailyTimes 越界（HH:MM 解析后 hour >= 24）抛错。
 *
 * 命名约定：函数名 buildBatchItemsFromMatrix 沿用 issue #37 PRD 命名。
 */
export function buildBatchItemsFromMatrix(
  items: BatchItem[],
  dailyTimes: string[],
): PostVideoRequest[] {
  const dailyTimesSet = new Set(dailyTimes);
  const result: PostVideoRequest[] = [];
  for (const item of items) {
    for (const [platform, accounts] of Object.entries(item.accountIdsByPlatform) as [
      Platform,
      string[],
    ][]) {
      if (!accounts || accounts.length === 0) continue;
      // 每账号一个 postVideo 项（矩阵维度 = 每视频×每账号）。
      for (const accountCookie of accounts) {
        result.push(buildOneMatrixItem(item, platform, accountCookie, dailyTimesSet));
      }
    }
  }
  return result;
}

/** 单个 (item, platform, account) → PostVideoRequest。 */
function buildOneMatrixItem(
  item: BatchItem,
  platform: Platform,
  accountCookie: string,
  dailyTimesSet: Set<string>,
): PostVideoRequest {
  const tags = parseTagsInput(item.tags);

  if (item.mode === "immediate") {
    return {
      fileList: [item.filePath],
      accountList: [accountCookie],
      type: OFFICIAL_PLATFORM_TYPE[platform],
      title: mergeTitleWithCaption(item.title, item.caption),
      tags,
      enableTimer: false,
    };
  }

  // mode='timer'
  if (item.timeOfDay === undefined || item.startDays === undefined) {
    throw new Error(
      `mode='timer' 必须提供 startDays 与 timeOfDay（item=${item.filePath}）`,
    );
  }
  if (!dailyTimesSet.has(item.timeOfDay)) {
    throw new Error(
      `item.timeOfDay="${item.timeOfDay}" 不在 dailyTimes 池中（${Array.from(dailyTimesSet).join(", ")}）`,
    );
  }
  const hour = parseHHMMToHour(item.timeOfDay);
  return {
    fileList: [item.filePath],
    accountList: [accountCookie],
    type: OFFICIAL_PLATFORM_TYPE[platform],
    title: mergeTitleWithCaption(item.title, item.caption),
    tags,
    enableTimer: true,
    videosPerDay: 1,
    dailyTimes: [hour],
    startDays: item.startDays,
  };
}
