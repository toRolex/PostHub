import type { PublishRecord } from "../api/official";
import type { Platform } from "../api/types";

export interface CalendarAccount {
  id: number;
  file: string;
  name: string;
  platform: Platform;
}

export function formatCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function mondayOfWeek(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay();
  result.setDate(result.getDate() - (day === 0 ? 6 : day - 1));
  return result;
}

export function getWeekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
    date.setDate(date.getDate() + index);
    return date;
  });
}

export function shiftWeek(weekStart: Date, offset: number): Date {
  const shifted = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  shifted.setDate(shifted.getDate() + offset * 7);
  return shifted;
}

export function recordDateTime(record: PublishRecord): string | null {
  return record.effectiveScheduledFor ?? record.publishedAt;
}

export function recordDate(record: PublishRecord): string {
  return recordDateTime(record)?.slice(0, 10) ?? "";
}

export function calendarAccountKey(account: Pick<CalendarAccount, "id" | "file">): string {
  return `${account.id}|${account.file}`;
}

export function recordAccountKey(record: Pick<PublishRecord, "accountId" | "accountFile">): string {
  return `${record.accountId}|${record.accountFile}`;
}

export function recordsByAccountDate(
  records: PublishRecord[],
): Map<string, PublishRecord[]> {
  const buckets = new Map<string, PublishRecord[]>();
  for (const record of records) {
    const date = recordDate(record);
    if (!date) continue;
    const key = `${record.accountId}|${date}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) =>
      (recordDateTime(a) ?? "").localeCompare(recordDateTime(b) ?? ""),
    );
  }
  return buckets;
}

export function buildCalendarRows(
  accounts: CalendarAccount[],
  records: PublishRecord[],
): CalendarAccount[] {
  const rows = new Map<string, CalendarAccount>();
  // 历史快照优先：当前账号可能已改名或换平台，不能覆盖记录当时的展示值。
  for (const record of records) {
    const key = recordAccountKey(record);
    if (!rows.has(key)) {
      rows.set(key, {
        id: record.accountId,
        file: record.accountFile,
        name: record.accountName,
        platform: record.platform,
      });
    }
  }
  for (const account of accounts) {
    const key = calendarAccountKey(account);
    if (!rows.has(key)) rows.set(key, account);
  }
  return [...rows.values()].sort((a, b) =>
    `${a.name}${a.file}`.localeCompare(`${b.name}${b.file}`),
  );
}
