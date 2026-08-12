import { useMemo, useState } from "react";
import { FolderOpen, ListPlus, Video } from "lucide-react";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { usePlatformStore } from "../stores/platform";
import { usePublishStore } from "../stores/publish";
import { useToastStore } from "../stores/toast";
import { useViewStore } from "../stores/view";
import type { Platform, PlatformConstraint } from "../api/types";
import { validatePublishForm } from "../lib/publishValidation";
import { pickImagePath, pickVideoPath } from "../lib/picker";
import { isTauri } from "../lib/isTauri";
import { cn } from "../lib/utils";
import { BatchImportSection } from "../components/publish/BatchImportSection";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Empty } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { PlatformMark } from "../components/ui/platform-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";

const PLATFORMS: Platform[] = ["douyin", "xiaohongshu", "wechat"];

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

function formatSpan(seconds: number): string {
  const h = seconds / 3600;
  if (h < 24) return `${h} 小时`;
  const d = h / 24;
  if (d < 30) return `${d} 天`;
  return `${Math.round(d / 30)} 个月`;
}

function constraintSummary(c: PlatformConstraint): string {
  const min = formatSpan(c.schedule_min_seconds);
  const max = formatSpan(c.schedule_max_seconds);
  const cover = c.cover_required
    ? "封面强制"
    : c.auto_cover_first_frame
      ? "缺封面取首帧"
      : "";
  return `定时窗口 ${min}~${max}${cover ? ` · ${cover}` : ""}`;
}

/* ───────────────────────── 素材 ───────────────────────── */

function AssetSection({ onImport }: { onImport: () => void }) {
  const videoPath = usePublishStore((s) => s.videoPath);
  const setForm = usePublishStore((s) => s.setForm);

  async function handlePickVideo(): Promise<void> {
    try {
      const path = await pickVideoPath();
      if (path) setForm({ videoPath: path });
    } catch {
      // 浏览器环境由原生 input 兜底（下方 BrowserVideoPicker）
    }
  }

  const name = videoPath.split(/[\\/]/).pop() ?? videoPath;

  return (
    <section className="border-t border-border-soft py-6 first:border-t-0 first:pt-0">
      <SectionHead title="素材" hint="本地视频 · 或 manifest 批量导入" />
      {videoPath ? (
        <div className="flex items-center gap-4 rounded-lg border border-border-soft bg-bg p-4">
          <div className="grid h-[58px] w-24 shrink-0 place-items-center overflow-hidden rounded-sm bg-surface-sunk text-meta">
            <Video className="size-[22px]" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-body font-semibold">{name}</p>
            <p className="mt-0.5 text-caption text-meta">
              {videoPath.startsWith("/mock/") ? "浏览器预览 · 模拟素材" : "本地视频文件"}
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setForm({ videoPath: "" })}>
              移除
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {isTauri() ? (
            <Button variant="secondary" onClick={() => void handlePickVideo()}>
              <FolderOpen className="size-4" />
              本地文件
            </Button>
          ) : (
            // 浏览器开发环境兜底：原生 input（Tauri 下由 plugin-dialog 提供真实路径）
            <label className="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-md px-3.5 text-label font-medium text-fg-2 transition-colors duration-150 ease-out hover:bg-surface hover:text-fg">
              <FolderOpen className="size-4" />
              本地文件
              <input
                type="file"
                accept="video/*"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setForm({ videoPath: `/mock/${file.name}` });
                }}
              />
            </label>
          )}
          <Button variant="ghost" onClick={onImport}>
            <ListPlus className="size-4" />
            批量导入
          </Button>
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 发布到 ───────────────────────── */

function TargetSection() {
  const accounts = useAccountsStore((s) => s.accounts);
  const constraints = usePlatformStore((s) => s.constraints);
  const selected = usePublishStore((s) => s.selectedPlatforms);
  const accountByPlatform = usePublishStore((s) => s.accountByPlatform);
  const setForm = usePublishStore((s) => s.setForm);
  const setPlatforms = usePublishStore((s) => s.setPlatforms);

  if (accounts.length === 0) {
    return (
      <section className="border-t border-border-soft py-6">
        <SectionHead title="发布到" hint="勾选账号，行内显示平台约束" />
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
      <SectionHead title="发布到" hint="勾选账号，行内显示平台约束" />
      {PLATFORMS.map((p) => {
        const list = accounts.filter((a) => a.platform === p);
        if (list.length === 0) return null;
        const checked = selected.includes(p);
        const first = list[0];
        const usable = first.status === "active";
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
              aria-label={`发布到${first.platform === "douyin" ? "抖音" : first.platform === "xiaohongshu" ? "小红书" : "视频号"} ${first.name}`}
            />
            <PlatformMark platform={p} />
            <span className="text-body font-medium text-fg">{first.name}</span>
            <span className="ml-auto text-caption text-meta">
              {constraints[p]
                ? constraintSummary(constraints[p])
                : `账号 ${first.name}`}
            </span>
            {checked && list.length > 1 && (
              <Select
                value={String(accountByPlatform[p] ?? first.id)}
                onValueChange={(v) =>
                  setForm({
                    accountByPlatform: { ...accountByPlatform, [p]: Number(v) },
                  })
                }
              >
                <SelectTrigger className="h-7 w-[140px] text-label" aria-label="选择账号">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {list.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}
    </section>
  );
}

/* ───────────────────────── 内容与排期 ───────────────────────── */

function ContentSection({ errors }: { errors: string[] }) {
  const title = usePublishStore((s) => s.title);
  const caption = usePublishStore((s) => s.caption);
  const coverMode = usePublishStore((s) => s.coverMode);
  const schedulePolicy = usePublishStore((s) => s.schedulePolicy);
  const publishAt = usePublishStore((s) => s.publishAt);
  const publishMode = usePublishStore((s) => s.publishMode);
  const silent = usePublishStore((s) => s.silent);
  const setForm = usePublishStore((s) => s.setForm);
  const setPublishAt = usePublishStore((s) => s.setPublishAt);

  const datetimeValue = publishAt ? publishAt.replace(" ", "T").slice(0, 16) : "";
  const minDatetime = new Date(Date.now() + 3600_000).toISOString().slice(0, 16);

  async function handlePickCover(): Promise<void> {
    try {
      const path = await pickImagePath();
      if (path) setForm({ coverHorizontal: path });
    } catch {
      // 浏览器环境跳过真实封面选择
    }
  }

  return (
    <section className="border-t border-border-soft py-6">
      <SectionHead title="内容与排期" hint="平台差异在此收敛" />
      <div className="grid grid-cols-2 gap-4">
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
          <label htmlFor="publish-cover-mode" className="text-label font-medium text-fg-2">
            封面
          </label>
          <div className="flex h-9 items-center gap-3 text-body text-fg-2">
            <label className="flex items-center gap-1.5 text-label">
              <Checkbox
                checked={coverMode === "auto"}
                onChange={() => setForm({ coverMode: "auto", coverHorizontal: "" })}
              />
              自动
            </label>
            <label className="flex items-center gap-1.5 text-label">
              <Checkbox
                checked={coverMode === "file"}
                onChange={() => setForm({ coverMode: "file" })}
              />
              自定义
            </label>
            {coverMode === "file" && (
              <Button variant="secondary" size="sm" onClick={() => void handlePickCover()}>
                选择封面
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor="publish-caption" className="text-label font-medium text-fg-2">
          正文
        </label>
        <Textarea
          id="publish-caption"
          value={caption}
          placeholder="写点正文，留空则仅标题发布"
          onChange={(e) => setForm({ caption: e.target.value })}
        />
      </div>

      {/* 排期 */}
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3 text-label text-fg-2">
          <Switch
            checked={schedulePolicy === "immediate"}
            onCheckedChange={(on) =>
              setForm({
                schedulePolicy: on ? "immediate" : "scheduled",
                ...(on ? { publishAt: null } : {}),
              })
            }
          />
          <span>{schedulePolicy === "immediate" ? "立即发布" : "定时发布"}</span>
        </div>
        {schedulePolicy === "scheduled" && (
          <>
            <div className="flex items-center gap-2 text-label text-fg-2">
              <Input
                type="datetime-local"
                className="w-[220px]"
                value={datetimeValue}
                min={minDatetime}
                onChange={(e) => {
                  const v = e.target.value;
                  setPublishAt(v ? new Date(v) : null);
                }}
              />
            </div>
            <div className="flex items-center gap-2 text-label text-fg-2">
              <span className="text-caption text-meta">定时方式</span>
              <Select
                value={publishMode}
                onValueChange={(v) =>
                  setForm({ publishMode: v as "platform_time" | "local_time" })
                }
              >
                <SelectTrigger className="h-7 w-[140px] text-label" aria-label="定时方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="platform_time">平台原生定时</SelectItem>
                  <SelectItem value="local_time">工具到点兜底</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        <div className="flex items-center gap-3 text-label text-fg-2">
          <Switch
            checked={silent}
            onCheckedChange={(on) => setForm({ silent: on })}
          />
          <span>静默发布</span>
        </div>
      </div>

      {errors.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 text-label text-danger-deep">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ───────────────────────── 主行动 ───────────────────────── */

function PublishActions() {
  const submitting = usePublishStore((s) => s.submitting);
  const connected = useDaemonStore((s) => s.connected);
  const schedulePolicy = usePublishStore((s) => s.schedulePolicy);
  const createTask = usePublishStore((s) => s.createTask);
  const reset = usePublishStore((s) => s.reset);
  const setView = useViewStore((s) => s.setView);

  const immediate = schedulePolicy === "immediate";

  async function handlePublish(): Promise<void> {
    try {
      const result = await createTask();
      useToastStore.getState().show(
        `任务 #${result.task.id} 已创建，共 ${result.jobs.length} 个平台子任务`,
        "ok",
      );
      reset();
      setView("tasks");
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    }
  }

  return (
    <div className="sticky bottom-0 z-4 mt-4 flex items-center gap-5 bg-[linear-gradient(to_top,var(--color-bg)_72%,transparent)] pb-4 pt-4">
      <Button
        variant="primary"
        size="lg"
        disabled={!connected || submitting}
        onClick={() => void handlePublish()}
      >
        {submitting ? "提交中…" : immediate ? "立即发布" : "定时发布"}
      </Button>
      {!connected && (
        <span className="text-caption text-meta">守护进程未连接，无法发布</span>
      )}
    </div>
  );
}

/* ───────────────────────── 发布视图 ───────────────────────── */

export function PublishView() {
  const [batchOpen, setBatchOpen] = useState(false);
  const title = usePublishStore((s) => s.title);
  const videoPath = usePublishStore((s) => s.videoPath);
  const caption = usePublishStore((s) => s.caption);
  const coverMode = usePublishStore((s) => s.coverMode);
  const coverHorizontal = usePublishStore((s) => s.coverHorizontal);
  const coverVertical = usePublishStore((s) => s.coverVertical);
  const selectedPlatforms = usePublishStore((s) => s.selectedPlatforms);
  const accountByPlatform = usePublishStore((s) => s.accountByPlatform);
  const schedulePolicy = usePublishStore((s) => s.schedulePolicy);
  const publishAt = usePublishStore((s) => s.publishAt);
  const constraints = usePlatformStore((s) => s.constraints);

  const errors = useMemo<string[]>(
    () =>
      validatePublishForm(
        {
          title,
          videoPath,
          caption,
          coverMode,
          coverHorizontal,
          coverVertical,
          selectedPlatforms,
          accountByPlatform,
          schedulePolicy,
          publishAt,
        },
        constraints,
      ),
    [title, videoPath, caption, coverMode, coverHorizontal, coverVertical, selectedPlatforms, accountByPlatform, schedulePolicy, publishAt, constraints],
  );

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <ViewHead title="发布" hint="一个视频，一键或定时发到多个平台" />
      <AssetSection onImport={() => setBatchOpen(true)} />
      <BatchImportSection open={batchOpen} onOpenChange={setBatchOpen} />
      <TargetSection />
      <ContentSection errors={errors} />
      <PublishActions />
    </div>
  );
}
