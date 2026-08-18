import { useEffect, useState } from "react";
import { Clock3, RotateCcw } from "lucide-react";
import { usePublishStore } from "../stores/publish";
import { useToastStore } from "../stores/toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";

const DEFAULT_TIMER = {
  timerEnabled: false,
  videosPerDay: 1,
  dailyTimes: [10, 14, 20],
  startDays: 0,
};

/** 时刻输入（整数小时）→ number[]：逗号/空格分隔，丢弃非 0-23 与重复项。 */
function parseDailyTimes(raw: string): number[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,，]+/)
        .map(Number)
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),
    ),
  ).sort((a, b) => a - b);
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
    <div className="mx-auto max-w-[720px] animate-fade-in px-8 pb-12 pt-8">
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
              placeholder="整点小时，空格分隔，如 10 14 20"
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
