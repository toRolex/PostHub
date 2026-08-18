import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileVideo, RefreshCw, Send, XCircle } from "lucide-react";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { useFilesStore } from "../stores/files";
import { usePublishStore, parseTags } from "../stores/publish";
import type { Platform } from "../api/types";
import { OFFICIAL_PLATFORM_NAMES, OFFICIAL_PLATFORM_TYPE } from "../api/types";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Empty } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { PlatformMark } from "../components/ui/platform-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { BatchPublishSection } from "../components/publish/BatchPublishSection";

const PLATFORMS: Platform[] = ["xiaohongshu", "wechat", "douyin", "kuaishou"];

function ViewHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-6 flex items-baseline gap-3">
      <h2 className="text-page font-semibold tracking-[-0.015em]">{title}</h2>
      <span className="text-label text-muted">{hint}</span>
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-4 flex items-baseline gap-3">
      <h3 className="text-title font-semibold tracking-[-0.01em]">{title}</h3>
      <span className="text-label text-muted">{hint}</span>
    </div>
  );
}

/* ───────────────────────── 素材（从文件页素材库选）───────────────────────── */

function AssetSection({ errors }: { errors: string[] }) {
  const files = useFilesStore((s) => s.files);
  const loading = useFilesStore((s) => s.loading);
  const fetchFiles = useFilesStore((s) => s.fetchFiles);
  const selectedFile = usePublishStore((s) => s.selectedFile);
  const setForm = usePublishStore((s) => s.setForm);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  // 素材库只呈现视频（官方发布 /postVideo 以视频为准）。
  const videos = useMemo(() => {
    const VIDEO_EXT = ["mp4", "mov", "webm", "m4v", "mkv"];
    return files.filter((f) =>
      VIDEO_EXT.includes(f.filename?.split(".").pop()?.toLowerCase() ?? ""),
    );
  }, [files]);

  return (
    <section className="border-t border-border-soft py-6 first:border-t-0 first:pt-0">
      <div className="mb-4 flex items-center gap-3">
        <h3 className="text-title font-semibold tracking-[-0.01em]">视频素材</h3>
        <span className="text-label text-muted">从「文件」素材库选取</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void fetchFiles()}
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </div>

      {videos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft">
          <Empty
            icon={<FileVideo className="size-[34px] text-meta" strokeWidth={1.5} />}
            title="素材库还没有视频"
            description="先到「文件」页上传视频素材，发布时直接选取"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {videos.map((f) => {
            const checked = selectedFile === f.file_path;
            return (
              <label
                key={f.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border border-border-soft bg-bg px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-warm",
                  checked && "border-accent bg-accent-tint",
                )}
              >
                <Checkbox
                  checked={checked}
                  onChange={() => setForm({ selectedFile: checked ? null : f.file_path })}
                  aria-label={`选择素材 ${f.filename}`}
                />
                <span className="min-w-0 truncate text-body font-medium text-fg">
                  {f.filename}
                </span>
                <span className="ml-auto text-caption text-meta">{f.filesize} MB</span>
              </label>
            );
          })}
        </div>
      )}

      {errors.includes("请选择视频素材") && !selectedFile && (
        <p className="mt-2 text-label text-danger-deep">请选择视频素材</p>
      )}
    </section>
  );
}

/* ───────────────────────── 发布到 ───────────────────────── */

/* ───────────────────────── 账号选择（按名称模糊搜索）───────────────────────── */

interface AccountOption {
  id: number;
  name: string;
}

/** 平台账号下拉：下拉内可按账号名模糊搜索并过滤选项。 */
function AccountSelect({
  options,
  value,
  onValueChange,
}: {
  options: AccountOption[];
  value: number;
  onValueChange: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <Select
      value={String(value)}
      onValueChange={(v) => onValueChange(Number(v))}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setQuery("");
      }}
    >
      <SelectTrigger className="h-7 w-[150px] text-label" aria-label="选择账号">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {open && (
          <div className="border-b border-border-soft px-1 pb-1">
            <Input
              value={query}
              placeholder="搜索账号名…"
              className="h-7 text-label"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              autoFocus
            />
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-label text-meta">无匹配账号</div>
        ) : (
          filtered.map((a) => (
            <SelectItem key={a.id} value={String(a.id)}>
              {a.name}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

function TargetSection() {
  const accounts = useAccountsStore((s) => s.accounts);
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts);
  const selected = usePublishStore((s) => s.selectedPlatforms);
  const accountByPlatform = usePublishStore((s) => s.accountByPlatform);
  const setForm = usePublishStore((s) => s.setForm);
  const setPlatforms = usePublishStore((s) => s.setPlatforms);

  useEffect(() => {
    if (accounts.length === 0) void fetchAccounts();
  }, [accounts.length, fetchAccounts]);

  if (accounts.length === 0) {
    return (
      <section className="border-t border-border-soft py-6">
        <SectionHead title="发布到" hint="勾选平台账号，可多平台" />
        <div className="rounded-lg border border-dashed border-border-soft">
          <Empty
            title="还没有账号"
            description="先到「账号」区添加平台账号（需拉起 Chrome 扫码登录）"
          />
        </div>
      </section>
    );
  }

  function togglePlatform(p: Platform): void {
    const next = selected.includes(p)
      ? selected.filter((x) => x !== p)
      : [...selected, p];
    setPlatforms(next, accounts);
  }

  return (
    <section className="border-t border-border-soft py-6">
      <SectionHead title="发布到" hint="勾选平台账号，可多平台" />
      {PLATFORMS.map((p) => {
        const list = accounts.filter((a) => a.platform === p);
        if (list.length === 0) return null;
        const checked = selected.includes(p);
        const usable = list.some((a) => a.status === 1);
        return (
          <div
            key={p}
            className={cn(
              "mb-2 flex items-center gap-3 rounded-lg border border-border-soft bg-bg p-3 px-4 transition-colors duration-150 ease-out",
              "hover:bg-surface-warm",
              checked && "border-accent bg-accent-tint",
              !usable && "opacity-55",
            )}
          >
            <Checkbox
              checked={checked}
              disabled={!usable}
              onChange={() => togglePlatform(p)}
              aria-label={`发布到${OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[p]]}`}
            />
            <PlatformMark platform={p} />
            <span className="text-body font-medium text-fg">
              {OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[p]]}
            </span>
            <span className="ml-auto text-caption text-meta">
              {list.length > 1 ? `${list.length} 个账号` : list[0].name}
            </span>
            {checked && list.length > 1 && (
              <AccountSelect
                options={list.map((a) => ({ id: a.id, name: a.name }))}
                value={accountByPlatform[p] ?? list[0].id}
                onValueChange={(id) =>
                  setForm({
                    accountByPlatform: { ...accountByPlatform, [p]: id },
                  })
                }
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

/* ───────────────────────── 内容（标题 / 描述 / 标签）───────────────────────── */

function ContentSection() {
  const title = usePublishStore((s) => s.title);
  const caption = usePublishStore((s) => s.caption);
  const tags = usePublishStore((s) => s.tags);
  const setForm = usePublishStore((s) => s.setForm);
  const tagCount = parseTags(tags).length;

  return (
    <section className="border-t border-border-soft py-6">
      <SectionHead title="内容" hint="标题 / 描述 / 标签" />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="publish-title" className="text-label font-medium text-fg-2">
            标题
          </label>
          <Input
            id="publish-title"
            value={title}
            maxLength={60}
            placeholder="视频标题"
            onChange={(e) => setForm({ title: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="publish-caption" className="text-label font-medium text-fg-2">
            描述
          </label>
          <Textarea
            id="publish-caption"
            value={caption}
            placeholder="正文/描述（可选），留空则仅用标题"
            onChange={(e) => setForm({ caption: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="publish-tags" className="text-label font-medium text-fg-2">
            标签
          </label>
          <Input
            id="publish-tags"
            value={tags}
            placeholder="用空格或逗号分隔，如 春天 旅行 #美食"
            onChange={(e) => setForm({ tags: e.target.value })}
          />
          <span className="text-caption text-meta">已识别 {tagCount} 个标签</span>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── 定时发布（enableTimer）───────────────────────── */

function TimerSection({ errors }: { errors: string[] }) {
  const timerEnabled = usePublishStore((s) => s.timerEnabled);
  const videosPerDay = usePublishStore((s) => s.videosPerDay);
  const dailyTimes = usePublishStore((s) => s.dailyTimes);
  const startDays = usePublishStore((s) => s.startDays);
  const setForm = usePublishStore((s) => s.setForm);

  // 时刻输入（整数小时）→ number[]：逗号/空格分隔，丢弃非 0-23 与重复项。
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

  return (
    <section className="border-t border-border-soft py-6">
      <div className="mb-4 flex items-center gap-3">
        <Switch
          id="publish-timer-enabled"
          checked={timerEnabled}
          onCheckedChange={(v) => setForm({ timerEnabled: v })}
        />
        <h3 className="text-title font-semibold tracking-[-0.01em]">定时发布</h3>
        <span className="text-label text-muted">
          启用后按官方 enableTimer 三字段随发布提交
        </span>
      </div>
      {timerEnabled && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="publish-timer-perday" className="text-label font-medium text-fg-2">
              每日条数（videosPerDay）
            </label>
            <Input
              id="publish-timer-perday"
              type="number"
              min={1}
              value={videosPerDay}
              onChange={(e) => setForm({ videosPerDay: Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="publish-timer-times" className="text-label font-medium text-fg-2">
              每日时刻（dailyTimes）
            </label>
            <Input
              id="publish-timer-times"
              value={dailyTimes.join(" ")}
              placeholder="整点小时，空格分隔，如 10 14 20"
              onChange={(e) => setForm({ dailyTimes: parseDailyTimes(e.target.value) })}
            />
            <span className="text-caption text-meta">当前 {dailyTimes.length} 个时刻</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="publish-timer-days" className="text-label font-medium text-fg-2">
              起始天（startDays）
            </label>
            <Input
              id="publish-timer-days"
              type="number"
              min={0}
              value={startDays}
              onChange={(e) => setForm({ startDays: Number(e.target.value) })}
            />
            <span className="text-caption text-meta">0 = 明天起</span>
          </div>
          {errors.filter((e) => e.includes("条数") || e.includes("时刻") || e.includes("起始")).map((e) => (
            <p key={e} className="text-label text-danger-deep">{e}</p>
          ))}
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 反馈 / 主行动 ───────────────────────── */

function FeedbackPanel() {
  const results = usePublishStore((s) => s.results);
  const submitting = usePublishStore((s) => s.submitting);
  const keys = Object.keys(results) as Platform[];
  if (keys.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-2">
      {keys.map((p) => {
        const r = results[p]!;
        return (
          <div
            key={p}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-4 py-3 text-label",
              r.ok
                ? "border-success bg-success-tint text-success-deep"
                : "border-danger bg-danger-tint text-danger-deep",
            )}
          >
            {r.ok ? (
              <CheckCircle2 className="size-4 shrink-0 translate-y-0.5" />
            ) : (
              <XCircle className="size-4 shrink-0 translate-y-0.5" />
            )}
            <div className="min-w-0">
              <p className="font-semibold">
                {OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[p]]}
                <span className="ml-2 font-normal text-muted">
                  {r.ok ? "发布任务已提交" : "失败"}
                </span>
              </p>
              {!r.ok && <p className="mt-0.5 break-words text-danger-deep">{r.msg}</p>}
            </div>
          </div>
        );
      })}
      {submitting && <p className="text-caption text-meta">正在提交剩余平台…</p>}
    </div>
  );
}

function PublishActions({ errors }: { errors: string[] }) {
  const submitting = usePublishStore((s) => s.submitting);
  const connected = useDaemonStore((s) => s.connected);
  const submit = usePublishStore((s) => s.submit);
  const reset = usePublishStore((s) => s.reset);

  async function handlePublish(): Promise<void> {
    try {
      await submit();
    } catch {
      // 前端校验错误已由 errors 列表展示；不再重复弹错。
    }
  }

  return (
    <>
      <div className="sticky bottom-0 z-4 mt-4 flex items-center gap-5 bg-[linear-gradient(to_top,var(--color-bg)_72%,transparent)] pb-4 pt-4">
        <Button
          variant="primary"
          size="lg"
          disabled={!connected || submitting || errors.length > 0}
          onClick={() => void handlePublish()}
        >
          <Send className="size-4" />
          {submitting ? "提交中…" : "发布"}
        </Button>
        {!connected && (
          <span className="text-caption text-meta">守护进程未连接，无法发布</span>
        )}
        {errors.length > 0 && (
          <ul className="flex flex-col gap-1 text-label text-danger-deep">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <Button variant="ghost" size="sm" onClick={reset}>
          重置
        </Button>
      </div>
      <FeedbackPanel />
    </>
  );
}

/* ───────────────────────── 发布视图 ───────────────────────── */

export function PublishView() {
  const title = usePublishStore((s) => s.title);
  const caption = usePublishStore((s) => s.caption);
  const tags = usePublishStore((s) => s.tags);
  const selectedPlatforms = usePublishStore((s) => s.selectedPlatforms);
  const accountByPlatform = usePublishStore((s) => s.accountByPlatform);
  const selectedFile = usePublishStore((s) => s.selectedFile);
  const timerEnabled = usePublishStore((s) => s.timerEnabled);
  const videosPerDay = usePublishStore((s) => s.videosPerDay);
  const dailyTimes = usePublishStore((s) => s.dailyTimes);
  const startDays = usePublishStore((s) => s.startDays);
  const validate = usePublishStore((s) => s.validate);

  // 订阅表单字段以驱动校验重算（validate 与 store 校验共享同一规则）。
  const errors = useMemo<string[]>(
    () =>
      validate({
        title,
        caption,
        tags,
        selectedPlatforms,
        accountByPlatform,
        selectedFile,
        timerEnabled,
        videosPerDay,
        dailyTimes,
        startDays,
      }),
    [
      validate,
      title,
      caption,
      tags,
      selectedPlatforms,
      accountByPlatform,
      selectedFile,
      timerEnabled,
      videosPerDay,
      dailyTimes,
      startDays,
    ],
  );

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <ViewHead title="发布" hint="一个视频，发布到所选平台" />
      <AssetSection errors={errors} />
      <TargetSection />
      <ContentSection />
      <TimerSection errors={errors} />
      <PublishActions errors={errors} />
      <BatchPublishSection />
    </div>
  );
}
