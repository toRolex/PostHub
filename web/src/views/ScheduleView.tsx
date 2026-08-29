import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, RotateCcw } from "lucide-react";
import { usePublishStore } from "../stores/publish";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { useCalendarStore } from "../stores/calendar";
import {
  buildCalendarRows,
  calendarAccountKey,
  formatCalendarDate,
  getWeekDates,
  mondayOfWeek,
  recordsByAccountDate,
  shiftWeek,
} from "../domain/calendar";
import { PLATFORM_NAMES } from "../api/platformNames";
import { PlatformMark } from "../components/ui/platform-mark";
import { normalizeDailyTimes } from "../domain/time";
import { useToastStore } from "../stores/toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";

const DEFAULT_TIMER = {
  timerEnabled: false,
  videosPerDay: 1,
  dailyTimes: ["10:00", "14:00", "20:00"],
  startDays: 0,
};

/** 时刻输入（HH:MM）→ string[]：逗号/空格分隔，非法项不写入。 */
function parseDailyTimes(raw: string): string[] {
  const values = raw.split(/[\s,，]+/).filter(Boolean);
  try {
    return normalizeDailyTimes(values);
  } catch {
    return [];
  }
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function recordTime(value: string): string {
  const separator = value.includes("T") ? "T" : " ";
  return value.split(separator)[1]?.slice(0, 5) ?? value;
}

function recordBucketKey(accountId: number, date: string): string {
  return `${accountId}|${date}`;
}

export function ScheduleView() {
  const timerEnabled = usePublishStore((s) => s.timerEnabled);
  const videosPerDay = usePublishStore((s) => s.videosPerDay);
  const dailyTimes = usePublishStore((s) => s.dailyTimes);
  const startDays = usePublishStore((s) => s.startDays);
  const setTimerPref = usePublishStore((s) => s.setTimerPref);
  const [timesText, setTimesText] = useState("");
  const [enabled, setEnabled] = useState(timerEnabled);
  const [perDay, setPerDay] = useState(videosPerDay);
  const [days, setDays] = useState(startDays);
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const daemonUrl = useDaemonStore((s) => s.url);
  const accounts = useAccountsStore((s) => s.accounts);
  const records = useCalendarStore((s) => s.records);
  const recordsLoading = useCalendarStore((s) => s.loading);
  const recordsError = useCalendarStore((s) => s.error);
  const fetchRecords = useCalendarStore((s) => s.fetchRecords);
  const weekStart = mondayOfWeek(weekAnchor);
  const weekDates = getWeekDates(weekStart);
  const from = formatCalendarDate(weekDates[0]);
  const to = formatCalendarDate(weekDates[6]);
  const recordBuckets = useMemo(() => recordsByAccountDate(records), [records]);
  const calendarAccounts = useMemo(
    () =>
      buildCalendarRows(
        accounts.map((account) => ({
          id: account.id,
          file: account.cookieFile,
          name: account.name,
          platform: account.platform,
        })),
        records,
      ),
    [accounts, records],
  );
  const today = formatCalendarDate(new Date());

  useEffect(() => {
    void fetchRecords(daemonUrl, from, to);
  }, [daemonUrl, fetchRecords, from, to]);

  // 进入页面时同步为当前 store 里的默认定时配置。
  useEffect(() => {
    setEnabled(timerEnabled);
    setPerDay(videosPerDay);
    setDays(startDays);
    setTimesText(dailyTimes.join(" "));
  }, [timerEnabled, videosPerDay, dailyTimes, startDays]);

  function handleSave(): void {
    const parsed = parseDailyTimes(timesText);
    if (parsed.length === 0) {
      useToastStore.getState().show("每日时刻不能为空", "err");
      return;
    }
    setTimerPref({
      timerEnabled: enabled,
      videosPerDay: Number.isFinite(perDay) && perDay > 0 ? perDay : 1,
      dailyTimes: parsed,
      startDays: Number.isFinite(days) && days >= 0 ? days : 0,
    });
    useToastStore.getState().show("默认定时配置已保存", "ok");
  }

  function handleReset(): void {
    setTimerPref({ ...DEFAULT_TIMER });
    useToastStore.getState().show("已恢复默认定时配置", "ok");
  }

  return (
    <div className="mx-auto max-w-[1120px] animate-fade-in px-8 pb-12 pt-8">
      <section aria-labelledby="schedule-calendar-title" className="mb-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <CalendarDays className="size-5 text-accent-ink" />
            <div>
              <h2 id="schedule-calendar-title" className="text-page font-semibold tracking-[-0.015em]">
                账号周日历
              </h2>
              <p className="text-label text-muted">查看 scheduled / published 记录（运行机器本地时间）</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" aria-label="上一周" onClick={() => setWeekAnchor((date) => shiftWeek(date, -1))}>
              <ChevronLeft className="size-4" />
              上一周
            </Button>
            <Button variant="ghost" onClick={() => setWeekAnchor(new Date())}>本周</Button>
            <Button variant="ghost" aria-label="下一周" onClick={() => setWeekAnchor((date) => shiftWeek(date, 1))}>
              下一周
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="mb-3 text-label font-medium text-fg-2">{from} – {to}</div>
        {recordsError && (
          <p role="alert" className="mb-3 rounded-md bg-danger-tint px-3 py-2 text-label text-danger-deep">
            查询失败：{recordsError}
          </p>
        )}
        <div className="overflow-x-auto rounded-lg border border-border-soft bg-bg">
          <table className="w-full min-w-[900px] table-fixed text-label">
            <thead className="bg-surface-warm">
              <tr>
                <th className="w-[180px] px-3 py-2 text-left font-medium text-meta">账号</th>
                {weekDates.map((date, index) => {
                  const dateText = formatCalendarDate(date);
                  return (
                    <th
                      key={dateText}
                      className={`px-2 py-2 text-left font-medium ${dateText === today ? "bg-accent-tint text-accent-ink" : "text-meta"}`}
                    >
                      <div>{WEEKDAY_LABELS[index]}</div>
                      <div className="tabular-nums text-caption">{dateText.slice(5)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {calendarAccounts.map((account) => (
                <tr key={calendarAccountKey(account)} className="border-t border-border-soft align-top">
                  <th className="px-3 py-3 text-left font-medium text-fg">
                    <div className="flex items-center gap-2">
                      <PlatformMark platform={account.platform} />
                      <span>{account.name}</span>
                    </div>
                    <div className="mt-0.5 pl-4 text-caption font-normal text-meta">
                      {PLATFORM_NAMES[account.platform]} · {account.file}
                    </div>
                  </th>
                  {weekDates.map((date) => {
                    const dateText = formatCalendarDate(date);
                    const bucket = recordBuckets.get(recordBucketKey(account.id, dateText)) ?? [];
                    return (
                      <td
                        key={dateText}
                        className={`min-h-20 px-2 py-2 ${dateText === today ? "bg-accent-tint" : ""}`}
                      >
                        {bucket.map((record) => (
                          <div
                            key={record.id}
                            className={`mb-1 rounded-sm border-l-2 px-2 py-1 text-caption ${record.status === "published" ? "border-success bg-success-tint text-success-deep" : "border-accent bg-accent-tint text-accent-ink"}`}
                            title={record.videoTitle}
                          >
                            <span className="font-medium tabular-nums">{recordTime(record.effectiveScheduledFor)}</span>{" "}
                            <span>{record.videoTitle}</span>
                          </div>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!recordsLoading && calendarAccounts.length === 0 && (
            <p className="px-4 py-6 text-center text-label text-muted">本周暂无定时记录</p>
          )}
          {recordsLoading && <p className="px-4 py-3 text-label text-muted">正在查询日历记录…</p>}
        </div>
      </section>

      <div className="mb-6 flex items-baseline gap-3">
        <h2 className="text-page font-semibold tracking-[-0.015em]">定时设置</h2>
        <span className="text-label text-muted">
          配置发布页的默认定时发布参数，保存后发布新视频时自动带出
        </span>
      </div>

      <div className="flex flex-col gap-6 rounded-lg border border-border-soft bg-bg p-6">
        <div className="flex items-center gap-3">
          <Switch
            id="schedule-timer-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <h3 className="text-title font-semibold tracking-[-0.01em]">定时发布</h3>
          <span className="text-label text-muted">
            启用后随发布请求提交官方 enableTimer 三字段
          </span>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-timer-perday">每日条数（videosPerDay）</Label>
            <Input
              id="schedule-timer-perday"
              type="number"
              min={1}
              value={perDay}
              onChange={(e) => setPerDay(Number(e.target.value))}
            />
            <span className="text-caption text-meta">
              每日发布的视频数，需 ≤ 每日时刻数量
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-timer-times">每日时刻（dailyTimes）</Label>
            <Input
              id="schedule-timer-times"
              value={timesText}
              placeholder="HH:MM，空格分隔，如 10:00 14:30 20:05"
              onChange={(e) => setTimesText(e.target.value)}
            />
            <span className="text-caption text-meta">
              当前 {parseDailyTimes(timesText).length} 个时刻
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-timer-days">起始天（startDays）</Label>
            <Input
              id="schedule-timer-days"
              type="number"
              min={0}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
            <span className="text-caption text-meta">0 = 明天起</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-soft pt-4">
          <Button variant="ghost" onClick={handleReset}>
            <RotateCcw className="size-4" />
            恢复默认
          </Button>
          <Button variant="primary" onClick={handleSave}>
            <Clock3 className="size-4" />
            保存配置
          </Button>
        </div>
      </div>
    </div>
  );
}
