import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, RotateCcw, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

type VariantKey = "A" | "B" | "C";

type VariantMeta = {
  key: VariantKey;
  name: string;
  summary: string;
};

const VARIANTS: readonly VariantMeta[] = [
  { key: "A", name: "经典双滚轮", summary: "像手机闹钟一样左右滑动" },
  { key: "B", name: "双滚轮 + 快捷时间", summary: "滚轮精确选择，预设减少操作" },
  { key: "C", name: "弹层双滚轮", summary: "页面简洁，点击后展开完整选择器" },
];

const HOURS = Array.from({ length: 24 }, (_, hour) => pad(hour));
const MINUTES = Array.from({ length: 60 }, (_, minute) => pad(minute));
const COMMON_TIMES = ["09:00", "10:00", "12:00", "14:00", "18:00", "20:00"];
const ROW_HEIGHT = 48;
const WHEEL_PADDING_ROWS = 2;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTime(hour: string, minute: string): string {
  return `${hour}:${minute}`;
}

function parseTime(value: string): { hour: string; minute: string } {
  const [hour, minute = "00"] = value.split(":");
  return { hour, minute };
}

function readVariant(): VariantKey {
  const value = new URLSearchParams(window.location.search).get("variant");
  return VARIANTS.some((item) => item.key === value) ? (value as VariantKey) : "A";
}

function useVariantNavigation(current: VariantKey, setCurrent: (value: VariantKey) => void) {
  function setVariant(next: VariantKey): void {
    const url = new URL(window.location.href);
    url.searchParams.set("prototype", "time-picker");
    url.searchParams.set("variant", next);
    window.history.replaceState({}, "", url);
    setCurrent(next);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, [contenteditable='true']") ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) {
        return;
      }
      const index = VARIANTS.findIndex((item) => item.key === current);
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = VARIANTS[(index + offset + VARIANTS.length) % VARIANTS.length];
      setVariant(next.key);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current]);

  return setVariant;
}

function PrototypeSwitcher({ current, onChange }: { current: VariantKey; onChange: (key: VariantKey) => void }) {
  const index = VARIANTS.findIndex((item) => item.key === current);
  const previous = VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length];
  const next = VARIANTS[(index + 1) % VARIANTS.length];

  return (
    <div className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-fg px-2 py-1.5 text-white shadow-lg">
      <button
        type="button"
        className="grid size-7 place-items-center rounded-full text-white/75 hover:bg-white/15 hover:text-white"
        onClick={() => onChange(previous.key)}
        aria-label={`上一个方案：${previous.name}`}
      >
        <ArrowLeft className="size-4" />
      </button>
      <button
        type="button"
        className="min-w-[210px] rounded-full px-3 py-1 text-center text-caption hover:bg-white/10"
        onClick={() => onChange(next.key)}
        aria-label={`下一个方案：${next.name}`}
      >
        <span className="font-semibold">{current} · {VARIANTS[index].name}</span>
        <span className="ml-2 text-white/65">{VARIANTS[index].summary}</span>
      </button>
      <button
        type="button"
        className="grid size-7 place-items-center rounded-full text-white/75 hover:bg-white/15 hover:text-white"
        onClick={() => onChange(next.key)}
        aria-label={`下一个方案：${next.name}`}
      >
        <ArrowRight className="size-4" />
      </button>
    </div>
  );
}

function WheelColumn({
  label,
  options,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const settleTimer = useRef<number | null>(null);
  const currentIndex = Math.max(0, options.indexOf(value));

  function scrollToIndex(index: number, behavior: ScrollBehavior = "smooth"): void {
    scrollerRef.current?.scrollTo({ top: index * ROW_HEIGHT, behavior });
  }

  useEffect(() => {
    scrollToIndex(currentIndex, "auto");
  }, [currentIndex]);

  useEffect(() => {
    return () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    };
  }, []);

  function settleSelection(): void {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const index = Math.max(0, Math.min(options.length - 1, Math.round(scroller.scrollTop / ROW_HEIGHT)));
    scrollToIndex(index);
    const nextValue = options[index];
    if (nextValue !== value) onChange(nextValue);
  }

  function handleScroll(): void {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(settleSelection, 90);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    let nextIndex: number | null = null;
    if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === "ArrowDown") nextIndex = Math.min(options.length - 1, currentIndex + 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    onChange(options[nextIndex]);
    scrollToIndex(nextIndex);
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-center text-caption font-medium text-meta">{label}</div>
      <div className="relative overflow-hidden rounded-xl border border-border-soft bg-surface-warm">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-surface-warm to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-16 bg-gradient-to-t from-surface-warm to-transparent" />
        <div className="pointer-events-none absolute inset-x-3 top-1/2 z-10 h-12 -translate-y-1/2 rounded-lg border-y border-accent/35 bg-accent-tint/60" />
        <div
          ref={scrollerRef}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${ariaLabel}-${value}`}
          tabIndex={0}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          className="relative h-[240px] snap-y snap-mandatory overflow-y-auto overscroll-contain [scrollbar-width:none] [touch-action:pan-y] [&::-webkit-scrollbar]:hidden"
          style={{ paddingBlock: `${WHEEL_PADDING_ROWS * ROW_HEIGHT}px` }}
        >
          {options.map((option, index) => (
            <button
              key={option}
              id={`${ariaLabel}-${option}`}
              ref={(node) => { itemRefs.current[index] = node; }}
              type="button"
              role="option"
              aria-selected={option === value}
              className={cn(
                "block w-full snap-center text-center font-mono text-body tabular-nums transition-all duration-100",
                option === value ? "font-semibold text-accent-ink" : "text-meta hover:text-fg-2",
              )}
              style={{ height: ROW_HEIGHT }}
              onClick={() => {
                onChange(option);
                scrollToIndex(index);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-meta">上下滑动 / 鼠标滚轮 / ↑ ↓</p>
    </div>
  );
}

function AlarmWheel({
  hour,
  minute,
  onHourChange,
  onMinuteChange,
}: {
  hour: string;
  minute: string;
  onHourChange: (value: string) => void;
  onMinuteChange: (value: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[440px] gap-3">
      <WheelColumn label="小时" options={HOURS} value={hour} onChange={onHourChange} ariaLabel="小时" />
      <div className="flex items-center pb-7 font-mono text-title font-semibold text-accent-ink">:</div>
      <WheelColumn label="分钟" options={MINUTES} value={minute} onChange={onMinuteChange} ariaLabel="分钟" />
    </div>
  );
}

function TimePool({ times, onRemove }: { times: string[]; onRemove: (time: string) => void }) {
  return (
    <div className="rounded-lg border border-border-soft bg-bg p-4">
      <div className="mb-2 flex items-center gap-2">
        <Clock3 className="size-4 text-accent" />
        <span className="text-label font-semibold text-fg-2">已添加的每日时刻</span>
        <span className="text-caption text-meta">确认后才进入候选池</span>
      </div>
      {times.length === 0 ? (
        <p className="rounded-md border border-dashed border-border-soft px-3 py-2 text-caption text-meta">还没有时刻</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {times.map((time) => (
            <span key={time} className="inline-flex items-center gap-1 rounded-md bg-accent-tint px-2.5 py-1 font-mono text-label font-medium text-accent-ink">
              {time}
              <button type="button" className="rounded p-0.5 hover:bg-accent-tint-2" onClick={() => onRemove(time)} aria-label={`删除 ${time}`}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatePanel({ times, draft, lastAction }: { times: string[]; draft: string; lastAction: string }) {
  return (
    <aside className="rounded-lg border border-border-soft bg-surface-warm p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-label font-semibold text-fg-2">原型状态（内存态）</span>
        <span className="rounded bg-warn-tint px-1.5 py-0.5 text-caption text-warn-deep">不写正式 store</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-caption">
        <dt className="text-meta">draftTime</dt>
        <dd className="font-mono text-fg-2">{draft}</dd>
        <dt className="text-meta">dailyTimes</dt>
        <dd className="font-mono text-fg-2">[{times.map((time) => `"${time}"`).join(", ")}]</dd>
        <dt className="text-meta">最近动作</dt>
        <dd className="text-fg-2">{lastAction}</dd>
      </dl>
      <p className="mt-3 rounded-md border border-warn bg-warn-tint px-3 py-2 text-caption text-warn-deep">
        原型支持每一分钟；正式接入前需同步修改后端时间契约，不能静默丢掉分钟。
      </p>
    </aside>
  );
}

function DraftActions({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border-soft pt-3">
      <Button variant="ghost" size="sm" onClick={onCancel}>
        <RotateCcw className="size-3.5" />
        取消选择
      </Button>
      <Button variant="primary" size="sm" onClick={onConfirm}>
        <Check className="size-3.5" />
        确认添加
      </Button>
    </div>
  );
}

function useTimeDraft() {
  const [times, setTimes] = useState<string[]>(["10:00", "14:00"]);
  const [draftHour, setDraftHour] = useState("10");
  const [draftMinute, setDraftMinute] = useState("00");
  const [lastAction, setLastAction] = useState("等待操作");
  const draft = formatTime(draftHour, draftMinute);
  const sortedTimes = useMemo(() => [...times].sort(), [times]);

  function chooseTime(value: string): void {
    const parsed = parseTime(value);
    setDraftHour(parsed.hour);
    setDraftMinute(parsed.minute);
    setLastAction(`已选择草稿 ${value}，尚未写入时刻池`);
  }

  function addDraft(): void {
    if (sortedTimes.includes(draft)) {
      setLastAction(`${draft} 已存在，未重复添加`);
      return;
    }
    setTimes((current) => [...current, draft]);
    setLastAction(`已确认添加 ${draft}`);
  }

  function removeTime(value: string): void {
    setTimes((current) => current.filter((time) => time !== value));
    setLastAction(`已删除 ${value}`);
  }

  function cancelDraft(): void {
    setDraftHour("10");
    setDraftMinute("00");
    setLastAction("已取消选择，草稿恢复为 10:00");
  }

  return {
    times: sortedTimes,
    draft: draft,
    draftHour,
    draftMinute,
    lastAction,
    chooseTime,
    setDraftHour: (value: string) => {
      setDraftHour(value);
      setLastAction(`已滑动选择小时 ${value}`);
    },
    setDraftMinute: (value: string) => {
      setDraftMinute(value);
      setLastAction(`已滑动选择分钟 ${value}`);
    },
    addDraft,
    removeTime,
    cancelDraft,
  };
}

function WheelPanel({ state }: { state: ReturnType<typeof useTimeDraft> }) {
  return (
    <>
      <div className="mb-5 flex items-end justify-center gap-3">
        <div>
          <p className="mb-1 text-center text-caption text-meta">待添加时间</p>
          <p className="font-mono text-page font-semibold tabular-nums text-fg">{state.draft}</p>
        </div>
      </div>
      <AlarmWheel
        hour={state.draftHour}
        minute={state.draftMinute}
        onHourChange={state.setDraftHour}
        onMinuteChange={state.setDraftMinute}
      />
      <div className="mt-5">
        <DraftActions onCancel={state.cancelDraft} onConfirm={state.addDraft} />
      </div>
    </>
  );
}

function VariantA({ state }: { state: ReturnType<typeof useTimeDraft> }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <section className="rounded-lg border border-border-soft bg-bg p-5">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-title font-semibold">经典双滚轮</h3>
            <p className="mt-1 text-caption text-meta">左右两列分别滑动小时和分钟，行为接近手机闹钟。</p>
          </div>
          <span className="rounded-full bg-accent-tint px-2.5 py-1 text-caption text-accent-ink">方案 A</span>
        </div>
        <WheelPanel state={state} />
      </section>
      <TimePool times={state.times} onRemove={state.removeTime} />
    </div>
  );
}

function VariantB({ state }: { state: ReturnType<typeof useTimeDraft> }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <section className="rounded-lg border border-border-soft bg-bg p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-title font-semibold">双滚轮 + 快捷时间</h3>
            <p className="mt-1 text-caption text-meta">常用时间只需点一下设为草稿，再用滚轮微调分钟。</p>
          </div>
          <span className="rounded-full bg-accent-tint px-2.5 py-1 text-caption text-accent-ink">方案 B</span>
        </div>
        <div className="mb-5 flex flex-wrap gap-2">
          {COMMON_TIMES.map((time) => (
            <button
              key={time}
              type="button"
              className={cn(
                "rounded-md border px-3 py-1.5 font-mono text-caption transition-colors",
                state.draft === time ? "border-accent bg-accent-tint text-accent-ink" : "border-border-soft hover:border-accent hover:bg-surface-warm",
              )}
              onClick={() => state.chooseTime(time)}
            >
              {time}
            </button>
          ))}
        </div>
        <WheelPanel state={state} />
      </section>
      <TimePool times={state.times} onRemove={state.removeTime} />
    </div>
  );
}

function VariantC({ state }: { state: ReturnType<typeof useTimeDraft> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <section className="rounded-lg border border-border-soft bg-bg p-5">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-title font-semibold">弹层双滚轮</h3>
            <p className="mt-1 text-caption text-meta">收起时只占一行；点击时间按钮再展开完整滚轮。</p>
          </div>
          <span className="rounded-full bg-accent-tint px-2.5 py-1 text-caption text-accent-ink">方案 C</span>
        </div>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-border-soft bg-surface-warm px-4 py-4 text-left hover:border-accent"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span>
            <span className="block text-caption text-meta">每日时刻</span>
            <span className="mt-1 block font-mono text-title font-semibold tabular-nums text-fg">{state.draft}</span>
          </span>
          <span className="text-label text-accent-ink">{open ? "收起" : "调整时间"}</span>
        </button>
        {open ? (
          <div className="mt-4 rounded-lg border border-border-soft bg-surface-warm p-4">
            <WheelPanel state={state} />
          </div>
        ) : null}
      </section>
      <TimePool times={state.times} onRemove={state.removeTime} />
    </div>
  );
}

export function TimePickerPrototype() {
  const [variant, setVariant] = useState<VariantKey>(readVariant);
  const state = useTimeDraft();
  const setVariantInUrl = useVariantNavigation(variant, setVariant);
  const meta = VARIANTS.find((item) => item.key === variant)!;

  function exitPrototype(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("prototype");
    url.searchParams.delete("variant");
    window.location.assign(url.toString());
  }

  return (
    <div className="min-h-full bg-bg px-6 pb-24 pt-8 lg:px-10">
      <div className="mx-auto max-w-[1080px]">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-warn-tint px-2 py-1 text-caption font-semibold text-warn-deep">PROTOTYPE · throwaway</span>
              <span className="text-caption text-meta">/ 批量发布 / 每日时刻</span>
            </div>
            <h1 className="text-page font-semibold tracking-[-0.015em]">手机闹钟式定时时间选择器</h1>
            <p className="mt-2 max-w-[720px] text-body text-muted">
              左列小时、右列分钟，支持触摸滑动、鼠标滚轮和键盘上下键；选择过程只更新草稿，点击确认后才加入时刻池。
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={exitPrototype}>退出原型</Button>
        </div>

        <div className="mb-5 rounded-lg border border-warn bg-warn-tint px-4 py-3 text-label text-warn-deep">
          原型不调用 daemon，也不修改正式 store。分钟已细化到 `00–59`；正式实现必须同步修改后端时间契约，不能把 `14:37` 静默变成 `14:00`。
        </div>

        <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="rounded-lg border border-border-soft bg-surface-warm p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-label font-semibold text-fg-2">当前方案：{meta.name}</span>
              <span className="text-caption text-meta">可用 ← / → 切换</span>
            </div>
            <p className="text-caption text-muted">{meta.summary}</p>
          </div>
          <StatePanel times={state.times} draft={state.draft} lastAction={state.lastAction} />
        </div>

        {variant === "A" ? <VariantA state={state} /> : null}
        {variant === "B" ? <VariantB state={state} /> : null}
        {variant === "C" ? <VariantC state={state} /> : null}
      </div>
      <PrototypeSwitcher current={variant} onChange={setVariantInUrl} />
    </div>
  );
}
