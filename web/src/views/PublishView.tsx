import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileVideo, RefreshCw, Send, XCircle } from "lucide-react";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { useFilesStore } from "../stores/files";
import { usePublishStore } from "../stores/publish";
import { useRunStore } from "../stores/runs";
import { parseTags } from "../domain/tags";
import { resolveDouyinDeclaration } from "../domain/declarations";
import { normalizeDailyTimes, resolveWechatTimer } from "../domain/time";
import type { RunItemDiagnostic } from "../api/official";
import type { Platform, PlatformFields } from "../api/types";
import { OFFICIAL_TYPE_PLATFORM } from "../api/types";
import { PLATFORM_NAMES, PLATFORMS } from "../api/platformNames";
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
import {
  PlatformDeclarationPicker,
  PlatformDeclarationBadge,
} from "../components/publish/PlatformDeclarationPicker";

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
              aria-label={`发布到${PLATFORM_NAMES[p]}`}
            />
            <PlatformMark platform={p} />
            <span className="text-body font-medium text-fg">
              {PLATFORM_NAMES[p]}
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
  const selectedPlatforms = usePublishStore((s) => s.selectedPlatforms);
  const setForm = usePublishStore((s) => s.setForm);

  // 时刻输入（HH:MM）→ string[]：逗号/空格分隔，非法项不写入。
  function parseDailyTimes(raw: string): string[] {
    const values = raw.split(/[\s,，]+/).filter(Boolean);
    try {
      return normalizeDailyTimes(values);
    } catch {
      return [];
    }
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
              placeholder="HH:MM，空格分隔，如 10:00 14:30 20:05"
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
          {timerEnabled && selectedPlatforms.includes("wechat") && dailyTimes.length > 0 && (
            <div role="status" aria-live="polite" className="rounded-md bg-warn-tint px-3 py-2 text-label text-warn-deep">
              <div className="font-medium">视频号整点降级提示（仅提醒，不阻断提交）</div>
              {dailyTimes.map((value) => {
                try {
                  const resolution = resolveWechatTimer(value);
                  return (
                    <div key={value}>
                      原始 {resolution.originalTime} → 最终 {resolution.finalTime}；{resolution.reason}；{resolution.warning}
                    </div>
                  );
                } catch {
                  return null;
                }
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 内容声明（issue #43）───────────────────────── */

function DeclarationSection() {
  const selected = usePublishStore((s) => s.selectedPlatforms);
  const platformFields = usePublishStore((s) => s.platformFields);
  const setForm = usePublishStore((s) => s.setForm);
  const accounts = useAccountsStore((s) => s.accounts);
  const accountByPlatform = usePublishStore((s) => s.accountByPlatform);

  const supported = selected.filter((p) => p !== "kuaishou") as Array<
    "wechat" | "douyin" | "xiaohongshu"
  >;
  if (supported.length === 0) return null;

  function setPlatformField(p: "wechat" | "douyin" | "xiaohongshu", v: PlatformFields[typeof p]) {
    setForm({
      platformFields: { ...platformFields, [p]: v },
    });
  }

  function getAccountDefault(p: Platform) {
    const accId = accountByPlatform[p];
    return accounts.find((a) => a.id === accId)?.defaultPlatformFields?.[p as "wechat" | "douyin" | "xiaohongshu"];
  }

  return (
    <section className="border-t border-border-soft py-6">
      <SectionHead title="内容声明" hint="按平台分别设置；不选则用账号默认" />
      <div className="flex flex-col gap-3">
        {supported.map((p) => (
          <div key={p} className="rounded-lg border border-border-soft bg-bg p-3">
            <div className="mb-2 flex items-center gap-2">
              <PlatformMark platform={p} />
              <span className="text-label font-medium text-fg-2">
                {PLATFORM_NAMES[p]}
              </span>
              <span className="ml-auto text-caption text-meta">
                账号默认：
                <PlatformDeclarationBadge
                  platform={p}
                  value={getAccountDefault(p)}
                />
              </span>
            </div>
            <PlatformDeclarationPicker
              platform={p}
              value={platformFields[p]}
              onChange={(v) => setPlatformField(p, v)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────── 反馈 / 主行动 ───────────────────────── */

function runItemStatusLabel(status: string): string {
  return {
    pending: "待执行",
    running: "执行中",
    success: "成功",
    failed: "失败",
    skipped: "已跳过",
    interrupted: "已中断",
  }[status] ?? status;
}

export function isRetryableRunItemStatus(status: string): boolean {
  return status === "failed" || status === "skipped" || status === "interrupted";
}

export function retryableRunItemIds(
  items: Array<{ itemId: string; status: string }>,
): string[] {
  return items
    .filter((item) => isRetryableRunItemStatus(item.status))
    .map((item) => item.itemId);
}

export function runItemDiagnostics(
  diagnostics:
    | RunItemDiagnostic[]
    | { warnings: string[]; debugScreenshots: string[] }
    | null
    | undefined,
): string[] {
  if (!diagnostics) return [];
  if (Array.isArray(diagnostics)) {
    return diagnostics.map(
      (diagnostic) => diagnostic.message ?? diagnostic.reason ?? diagnostic.kind,
    );
  }
  return [
    ...diagnostics.warnings.map((warning) => `告警：${warning}`),
    ...diagnostics.debugScreenshots.map((path) => `调试截图：${path}`),
  ];
}

function RunDiagnosticList({ diagnostics }: { diagnostics: RunItemDiagnostic[] }) {
  return (
    <ul aria-label="运行诊断" className="mt-2 flex w-full flex-col gap-1.5">
      {diagnostics.map((diagnostic, index) => (
        <li
          key={`${diagnostic.kind}-${diagnostic.reason ?? "unknown"}-${index}`}
          className={cn(
            "rounded border px-2 py-1.5 text-caption",
            diagnostic.level === "warning"
              ? "border-warning bg-warning-tint text-warning-deep"
              : "border-border-soft bg-bg-2 text-muted",
          )}
        >
          <p className="font-medium">
            {diagnostic.level === "warning" ? "警告" : "信息"}：
            {diagnostic.message ?? diagnostic.reason ?? diagnostic.kind}
          </p>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-meta">
            {diagnostic.account && <span>账号：{diagnostic.account}</span>}
            {diagnostic.entrySelector && (
              <span>入口 selector：{diagnostic.entrySelector}</span>
            )}
            {diagnostic.selector && <span>selector：{diagnostic.selector}</span>}
            {diagnostic.requestedValue && <span>请求值：{diagnostic.requestedValue}</span>}
            {diagnostic.displayValue && <span>展示值：{diagnostic.displayValue}</span>}
          </div>
          {diagnostic.screenshot && (
            <p className="mt-0.5 break-all text-meta">
              调试截图：<code>{diagnostic.screenshot}</code>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 最近 accepted run 详情：展示首次受理时冻结的最终 effective 声明。 */
function RunDetailPanel() {
  const snapshot = useRunStore((s) => s.snapshot);
  const daemonUrl = useDaemonStore((s) => s.url);
  const retryRun = useRunStore((s) => s.retryRun);
  const retrying = useRunStore((s) => s.retrying);
  const retryError = useRunStore((s) => s.error);
  if (!snapshot) return null;
  const retryableItemIds = retryableRunItemIds(snapshot.items);

  return (
    <section className="border-t border-border-soft py-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h3 className="text-title font-semibold tracking-[-0.01em]">最近运行详情</h3>
        <span className="text-label text-muted">展示首次受理时冻结的最终值</span>
        {snapshot.parentRunId && (
          <span className="text-caption text-meta">重试自 {snapshot.parentRunId.slice(0, 8)}</span>
        )}
        {retryableItemIds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            disabled={retrying}
            onClick={() => void retryRun(daemonUrl)}
          >
            <RefreshCw className="size-3.5" />
            {retrying ? "重试中…" : `重试全部可重试项（${retryableItemIds.length}）`}
          </Button>
        )}
      </div>
      {retryError && <p className="mb-2 text-label text-danger-deep" role="alert">{retryError}</p>}
      <div className="flex flex-col gap-2">
        {snapshot.items.map((item, index) => {
          const effective = item.effective;
          const seq = item.seq ?? index + 1;
          const errorSummary = item.errorSummary ?? item.error;
          const errorDetail = item.errorDetail ?? item.error;
          const platform = effective
            ? OFFICIAL_TYPE_PLATFORM[effective.type]
            : undefined;
          const douyin =
            platform === "douyin"
              ? resolveDouyinDeclaration(effective?.platformFields?.douyin, undefined)
              : undefined;
          return (
            <div
              key={item.itemId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border-soft bg-bg px-3 py-2 text-label"
            >
              <span className="font-mono text-caption text-meta">#{seq}</span>
              <span className="font-mono text-caption text-meta">{item.itemId.slice(0, 8)}</span>
              <span className="text-fg-2">{runItemStatusLabel(item.status)}</span>
              {douyin && (
                <span className="rounded-sm bg-accent-tint px-1.5 py-0.5 text-caption text-accent-ink">
                  抖音声明：{douyin.value ? `${douyin.value} · ${douyin.label}` : douyin.label}
                </span>
              )}
              {platform === "wechat" && effective?.timerFinalTime && (
                <span className="rounded-sm bg-warn-tint px-1.5 py-0.5 text-caption text-warn-deep">
                  视频号定时：
                  {effective.timerResolutions?.length ? (
                    effective.timerResolutions.map((resolution) => (
                      <span key={`${resolution.originalTime}-${resolution.finalTime}`} className="ml-1">
                        原始 {resolution.originalTime} → 最终 {resolution.finalTime}；{resolution.reason}；
                        {resolution.warning}
                      </span>
                    ))
                  ) : (
                    <span className="ml-1">
                      原始 {item.submitted?.dailyTimes?.join("、") ?? effective.timerOriginalTime}
                      → 最终 {effective.timerFinalTime}；{effective.timerDowngradeReason}
                      {effective.timerWindowWarning && `；${effective.timerWindowWarning}`}
                    </span>
                  )}
                </span>
              )}
              {errorSummary && <span className="text-danger-deep">{errorSummary}</span>}
              {errorDetail && (
                <details className="basis-full rounded-md bg-danger-tint px-2 py-1 text-caption text-danger-deep">
                  <summary className="cursor-pointer select-none">查看详细错误</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
                    {errorDetail}
                  </pre>
                </details>
              )}
              {item.diagnostics && item.diagnostics.length > 0 && (
                <RunDiagnosticList diagnostics={item.diagnostics} />
              )}
              {isRetryableRunItemStatus(item.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7"
                  disabled={retrying}
                  onClick={() => void retryRun(daemonUrl, [item.itemId])}
                >
                  <RefreshCw className="size-3.5" />
                  重试此项
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FeedbackPanel() {
  const results = usePublishStore((s) => s.results);
  const submitting = usePublishStore((s) => s.submitting);
  const openRun = useRunStore((s) => s.openRun);
  const daemonUrl = useDaemonStore((s) => s.url);
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
                {PLATFORM_NAMES[p]}
                <span className="ml-2 font-normal text-muted">
                  {r.ok ? r.msg : "失败"}
                </span>
              </p>
              {!r.ok && <p className="mt-0.5 break-words text-danger-deep">{r.msg}</p>}
              {r.existingRunId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 px-2"
                  onClick={() => void openRun(daemonUrl, r.existingRunId!)}
                >
                  打开已有 run
                </Button>
              )}
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
  const platformFields = usePublishStore((s) => s.platformFields);
  const validate = usePublishStore((s) => s.validate);

  // 订阅表单字段以驱动校验重算（validate 与 store 校验结果同源）。
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
        platformFields,
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
      platformFields,
    ],
  );

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <ViewHead title="发布" hint="一个视频，发布到所选平台" />
      <AssetSection errors={errors} />
      <TargetSection />
      <ContentSection />
      <TimerSection errors={errors} />
      <DeclarationSection />
      <RunDetailPanel />
      <PublishActions errors={errors} />
      <BatchPublishSection />
    </div>
  );
}
