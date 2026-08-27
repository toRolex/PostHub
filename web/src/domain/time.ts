/** 定时纯时间契约：只处理本地日内 HH:MM，不携带时区或日期。 */

/** 解析 H:MM / HH:MM；返回 0..1439 的日内分钟，非法输入显式抛错。 */
export function parseHHMM(value: unknown): number {
  if (typeof value !== "string") {
    throw new Error(`时间格式非法：${String(value)}（应为 HH:MM）`);
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`时间格式非法：${value}（应为 HH:MM）`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) {
    throw new Error(`时间越界：${value}（小时应在 0–23）`);
  }
  if (minute > 59) {
    throw new Error(`时间越界：${value}（分钟应在 0–59）`);
  }
  return hour * 60 + minute;
}

/** 把可读的 H:MM / HH:MM 规范化为唯一写入格式 HH:MM。 */
export function normalizeHHMM(value: unknown): string {
  return formatHHMM(parseHHMM(value));
}

/** 把日内分钟格式化为唯一写入格式 HH:MM。 */
export function formatHHMM(totalMinutes: number): string {
  if (!Number.isInteger(totalMinutes) || totalMinutes < 0 || totalMinutes > 1439) {
    throw new Error(`日内分钟越界：${totalMinutes}（应为 0–1439）`);
  }
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 读取旧小时数组或新 HH:MM 数组，统一为排序去重的日内分钟。 */
export function readTimeList(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new Error("每日时刻必须为数组");
  const minutes = raw.map((value) => {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0 || value > 23) {
        throw new Error(`旧定时时刻越界：${String(value)}（小时应在 0–23）`);
      }
      return value * 60;
    }
    return parseHHMM(value);
  });
  return Array.from(new Set(minutes)).sort((a, b) => a - b);
}

/** 统一把日内分钟写成排序去重的 HH:MM 字符串数组。 */
export function writeTimeList(minutes: number[]): string[] {
  return Array.from(new Set(minutes)).sort((a, b) => a - b).map(formatHHMM);
}

/** 双读单写归一化入口：旧 number[] / 新 string[] 均只产出 HH:MM。 */
export function normalizeDailyTimes(raw: unknown): string[] {
  return writeTimeList(readTimeList(raw));
}

export interface LocalTime {
  hour: number;
  minute: number;
}

/** 读取机器本地时钟；不使用 UTC，传入 Date 便于测试冻结时间。 */
export function localTimeOf(now: Date = new Date()): LocalTime {
  if (Number.isNaN(now.getTime())) throw new Error("本地时间无效");
  return { hour: now.getHours(), minute: now.getMinutes() };
}

export interface RoundedHour {
  hour: number;
  /** 取整跨过 23:xx → 00:00 时为 1，否则为 0。 */
  dayCarry: 0 | 1;
}

/** 将时刻降级到最近整点；正好 30 分钟向后取整，并显式返回午夜进位。 */
export function nearestWholeHour(value: string | number | Date): RoundedHour {
  let totalMinutes: number;
  if (typeof value === "string") {
    totalMinutes = parseHHMM(value);
  } else if (value instanceof Date) {
    const local = localTimeOf(value);
    totalMinutes = local.hour * 60 + local.minute;
  } else {
    totalMinutes = value;
  }
  if (!Number.isInteger(totalMinutes) || totalMinutes < 0 || totalMinutes > 1439) {
    throw new Error(`日内分钟越界：${String(totalMinutes)}（应为 0–1439）`);
  }
  const rounded = Math.floor(totalMinutes / 60) + (totalMinutes % 60 >= 30 ? 1 : 0);
  return {
    hour: rounded % 24,
    dayCarry: rounded >= 24 ? 1 : 0,
  };
}

/** 把最近整点的午夜进位并入起始天，保持 startDays 非负整数语义。 */
export function carryStartDays(startDays: number, dayCarry: 0 | 1): number {
  if (!Number.isInteger(startDays) || startDays < 0) {
    throw new Error(`起始天无效：${String(startDays)}`);
  }
  return startDays + dayCarry;
}
