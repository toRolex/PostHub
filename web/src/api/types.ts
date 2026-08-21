/**
 * 领域类型（单一来源）—— 对应 CONTEXT.md 术语与 daemon REST 契约。
 * 与后端字段命名保持一致（snake_case）。
 */

import type { PlatformFields } from "./declarations";

export type { PlatformFields };

export type Platform = "douyin" | "xiaohongshu" | "wechat" | "kuaishou";

/**
 * 官方平台类型号（user_info.type）：1 小红书 2 视频号 3 抖音 4 快手。
 * @see daemon/sau_backend.py:387 /login 注释
 */
export type OfficialPlatformType = 1 | 2 | 3 | 4;

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:5409";

export interface DaoUserInfo {
  id: number;
  type: OfficialPlatformType;
  /** 相对 daemon/conf BASE_DIR/cookiesFile 的 cookie 文件名。 */
  filePath: string;
  /** 官方 /login 的 id 参数 = 账号名（user_info.userName）。 */
  userName: string;
  /** 1 有效 / 0 无效（官方 getValidAccounts 校验后落库）。 */
  status: number;
}

/**
 * 平台展示名（单一来源）。值来自官方 `myUtils/login.py` 的 4 种登录生成器。
 * @see daemon/sau_backend.py:387
 */
export const OFFICIAL_PLATFORM_NAMES: Record<OfficialPlatformType, string> = {
  1: "小红书",
  2: "视频号",
  3: "抖音",
  4: "快手",
};

/** 前端 Platform -> 官方 type 号（登录时 /login?type= 所需）。 */
export const OFFICIAL_PLATFORM_TYPE: Record<Platform, OfficialPlatformType> = {
  xiaohongshu: 1,
  wechat: 2,
  douyin: 3,
  kuaishou: 4,
};

/** 官方 type 号 -> 前端 Platform（列表展示映射）。 */
export const OFFICIAL_TYPE_PLATFORM: Record<OfficialPlatformType, Platform> = {
  1: "xiaohongshu",
  2: "wechat",
  3: "douyin",
  4: "kuaishou",
};

/**
 * 官方账号展示模型：合并 user_info 与 cookie 校验结果，供 UI 使用。
 */
export interface OfficialAccount {
  id: number;
  platform: Platform;
  /** 显示名 = 官方账号名（userInfo.userName）。 */
  name: string;
  /** 官方平台类型号（原样保留，便于排查）。 */
  typeNum: OfficialPlatformType;
  /** cookie 文件相对名（BASE_DIR/cookiesFile 下）。 */
  cookieFile: string;
  /** 上次校验时的 cookie 有效性（true=可用）。 */
  cookieValid: boolean;
  /** 官方存储的校验状态：1 有效 / 0 无效。 */
  status: number;
  /** 账号粒度默认声明；undefined = 未设置。 */
  defaultPlatformFields?: PlatformFields;
}

export type Account = OfficialAccount;

/**
 * 官方后端 user_info 的一行：`/getAccounts` / `/getValidAccounts` 官方实现
 * `[list(row) for row in rows]` 返回的是数组行（非对象），顺序与 db/createTable.py
 * 列顺序一致：`[id, type, filePath, userName, status]`。
 * 这是 cookie 导入/导出的账号维度：`filePath` = playwright storage_state
 * cookie 文件在 `BASE_DIR/cookiesFile/` 下的相对文件名（如 `xxx.json`）。
 */
export type OfficialAccountRow = readonly [
  id: number,
  type: OfficialPlatform,
  filePath: string,
  userName: string,
  status: OfficialCookieStatus,
];

/** 官方 user_info.type 释义：1 小红书 2 视频号 3 抖音 4 快手。 */
export type OfficialPlatform = 1 | 2 | 3 | 4;

/** 官方 user_info.status：1 有效 / 0 失效。 */
export type OfficialCookieStatus = 0 | 1;

/** 解析后的官方账号（cookie 维度）。type 用官方释义：1 小红书 2 视频号 3 抖音 4 快手。 */
export interface CookiedAccount {
  id: number;
  type: OfficialPlatform;
  filePath: string;
  userName: string;
  status: OfficialCookieStatus;
}

/** 官方 file_records 表记录（GET /getFiles，daemon/sau_backend.py）。 */
export interface OfficialFileRecord {
  id: number;
  filename: string; // 不带 uuid 前缀的用户可见文件名
  filesize: number; // MB（uploadSave 写入时 round(...,2)）
  upload_time: string; // "YYYY-MM-DD HH:MM:SS"
  file_path: string; // 磁盘/videoFile/ 下的实际文件名（uuid_原名）
  uuid: string; // 官方从 file_path 提 uuid 的派生字段
}
