import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Send,
  XCircle,
  X,
  Plus,
} from "lucide-react";
import { useAccountsStore } from "../../stores/accounts";
import { useFilesStore } from "../../stores/files";
import { useBatchPublishStore } from "../../stores/batchPublish";
import { useDaemonStore } from "../../stores/daemon";
import type { Platform } from "../../api/types";
import { OFFICIAL_PLATFORM_NAMES, OFFICIAL_PLATFORM_TYPE } from "../../api/types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Chip } from "../ui/chip";
import { Empty } from "../ui/empty";
import { Input } from "../ui/input";
import { PlatformMark } from "../ui/platform-mark";
import { Switch } from "../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { BatchPreviewDialog } from "./BatchPreviewDialog";
import type { BatchItem } from "../../types/batch";

const PLATFORMS: Platform[] = ["xiaohongshu", "wechat", "douyin", "kuaishou"];

/* ─────────────────────── 纯逻辑 helper（可单测） ─────────────────────── */

/** 折叠态条目摘要。 */
export interface ItemSummary {
  /** 所选账号总数（= Σ |accountIdsByPlatform[p]|）。 */
  totalAccounts: number;
  /** 所选平台数。 */
  platformCount: number;
  /** 例：'3 账号 / 2 平台' 或 '未选账号'。 */
  accountSummary: string;
  /** '立即' / '定时' / '定时 (待选时刻)'。 */
  modeSummary: string;
  /** mode=timer 时 'HH:MM'；否则 null（用于徽标内拼接到 modeSummary 之后）。 */
  timeOfDayLabel: string | null;
  /** mode=timer 时 '+N 天'；否则 null。 */
  startDaysLabel: string | null;
}

/**
 * 计算单视频条目折叠态摘要。纯函数，便于不挂 DOM 单测。
 */
export function summarizeItem(item: BatchItem): ItemSummary {
  const entries = Object.entries(item.accountIdsByPlatform) as [Platform, string[]][];
  const totalAccounts = entries.reduce(
    (acc, [, cookies]) => acc + (cookies ? cookies.length : 0),
    0,
  );
  const platformCount = entries.filter(
    ([, cookies]) => cookies && cookies.length > 0,
  ).length;
  const accountSummary =
    totalAccounts === 0 ? "未选账号" : `${totalAccounts} 账号 / ${platformCount} 平台`;

  if (item.mode === "immediate") {
    return {
      totalAccounts,
      platformCount,
      accountSummary,
      modeSummary: "立即",
      timeOfDayLabel: null,
      startDaysLabel: null,
    };
  }
  return {
    totalAccounts,
    platformCount,
    accountSummary,
    modeSummary: item.timeOfDay ? "定时" : "定时 (待选时刻)",
    timeOfDayLabel: item.timeOfDay ?? null,
    startDaysLabel: item.startDays !== undefined ? `+${item.startDays} 天` : null,
  };
}

/**
 * 顶部 chip 池展示顺序：去重 + HH:MM 字典序排序（'09:00' < '10:00' < '14:30'）。
 */
export function summarizeDailyTimes(dailyTimes: string[]): string[] {
  return Array.from(new Set(dailyTimes)).sort();
}

/* ─────────────────────── 组件 ─────────────────────── */

/**
 * 发布页「批量发布」区段：每视频一条 BatchItem，矩阵展开。
 * - 顶部 dailyTimes chip 池（整批共用时刻表）。
 * - 每视频一行（折叠/展开；单行不联动）。
 * - 「展开全部 / 折叠全部」。
 * - 「批量发布」按钮 → 打开 BatchPreviewDialog。
 */
export function BatchPublishSection() {
  const files = useFilesStore((s) => s.files);
  const fetchFiles = useFilesStore((s) => s.fetchFiles);
  const accounts = useAccountsStore((s) => s.accounts);
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts);
  const connected = useDaemonStore((s) => s.connected);

  const items = useBatchPublishStore((s) => s.items);
  const dailyTimes = useBatchPublishStore((s) => s.dailyTimes);
  const submitting = useBatchPublishStore((s) => s.submitting);
  const itemResults = useBatchPublishStore((s) => s.itemResults);
  const previewOpen = useBatchPublishStore((s) => s.previewOpen);
  const openPreview = useBatchPublishStore((s) => s.openPreview);
  const closePreview = useBatchPublishStore((s) => s.closePreview);
  const addDailyTime = useBatchPublishStore((s) => s.addDailyTime);
  const removeDailyTime = useBatchPublishStore((s) => s.removeDailyTime);
  const submit = useBatchPublishStore((s) => s.submit);
  const reset = useBatchPublishStore((s) => s.reset);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    if (accounts.length === 0) void fetchAccounts();
  }, [accounts.length, fetchAccounts]);

  const videos = useMemo(() => {
    const VIDEO_EXT = ["mp4", "mov", "webm", "m4v", "mkv"];
    return files.filter((f) =>
      VIDEO_EXT.includes(f.filename?.split(".").pop()?.toLowerCase() ?? ""),
    );
  }, [files]);

  // 当前勾选但未入 items 的素材 → 「加入批量」入口
  const itemsByPath = useMemo(() => new Set(items.map((i) => i.filePath)), [items]);
  const availableToAdd = videos.filter((v) => !itemsByPath.has(v.file_path));

  // 整批错误聚合 + 每 item 错误
  const allErrors = useBatchPublishStore.getState().validate();
  const errorsByFilePath = useMemo(() => {
    const map = new Map<string, string[]>();
    const dailyTimesSet = new Set(dailyTimes);
    items.forEach((item) => {
      const local: string[] = [];
      if (!item.title.trim()) local.push("标题不能为空");
      const hasAccount = (Object.values(item.accountIdsByPlatform) as string[][]).some(
        (a) => a && a.length > 0,
      );
      if (!hasAccount) local.push("至少选一个账号");
      if (item.mode === "timer") {
        if (!item.timeOfDay || !dailyTimesSet.has(item.timeOfDay)) {
          local.push("定时未选时刻");
        }
        if (item.startDays === undefined || item.startDays < 0) {
          local.push("起始日非法");
        }
      }
      if (local.length > 0) map.set(item.filePath, local);
    });
    return map;
  }, [items, dailyTimes]);

  // 每行折叠/展开状态（key = filePath）
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
  const expandedAll =
    items.length > 0 && items.every((i) => expandedMap[i.filePath]);
  const collapsedAll =
    items.length > 0 && items.every((i) => !expandedMap[i.filePath]);
  function toggleRow(filePath: string): void {
    setExpandedMap((m) => ({ ...m, [filePath]: !m[filePath] }));
  }
  function expandAll(): void {
    const next: Record<string, boolean> = {};
    items.forEach((i) => {
      next[i.filePath] = true;
    });
    setExpandedMap(next);
  }
  function collapseAll(): void {
    const next: Record<string, boolean> = {};
    items.forEach((i) => {
      next[i.filePath] = false;
    });
    setExpandedMap(next);
  }

  async function handleConfirmPreview(): Promise<void> {
    closePreview();
    try {
      await submit();
    } catch {
      // 错误已通过 itemResults 反馈；不动 UI。
    }
  }

  const sortedDailyTimes = useMemo(() => summarizeDailyTimes(dailyTimes), [dailyTimes]);
  const { removeItem, updateItem, setItemMode, setItemTimeOfDay } =
    useBatchPublishStore.getState();

  return (
    <section className="border-t border-border-soft py-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h3 className="text-title font-semibold tracking-[-0.01em]">批量发布</h3>
        <span className="text-label text-muted">每视频独立配置 · 矩阵批量 / /postVideoBatch</span>
      </div>

      {/* 顶部 dailyTimes chip 池 */}
      <div className="mb-4 rounded-lg border border-border-soft bg-bg px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-label font-medium text-fg-2">每日时刻（整批共用）</span>
          <span className="text-caption text-meta">
            顶部 chip = 定时模式可选时刻池（HH:MM；提交时按整点取整映射回 0–23）
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {sortedDailyTimes.map((hm) => (
            <Chip
              key={hm}
              active
              onClick={() => removeDailyTime(hm)}
              aria-label={`删除时刻 ${hm}`}
            >
              {hm}
              <X className="size-3 text-meta" aria-hidden="true" />
            </Chip>
          ))}
          <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-label text-meta transition-colors hover:border-border-strong hover:text-fg-2">
            <Plus className="size-3" />
            <span>时刻</span>
            <input
              type="time"
              className="w-[110px] border-none bg-transparent text-label text-fg focus:outline-none"
              onChange={(e) => {
                const v = e.target.value;
                if (v) {
                  addDailyTime(v);
                  e.target.value = "";
                }
              }}
              aria-label="新增时刻"
            />
          </label>
        </div>
      </div>

      {/* 视频加入批量入口 */}
      {availableToAdd.length > 0 && (
        <div className="mb-4 rounded-lg border border-border-soft bg-bg px-4 py-3">
          <p className="mb-2 text-label font-medium text-fg-2">添加视频到批量</p>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto pr-1">
            {availableToAdd.map((f) => (
              <button
                key={f.id}
                type="button"
                className="flex items-center gap-2 rounded-md border border-border-soft px-3 py-1.5 text-label transition-colors hover:bg-surface-warm"
                onClick={() =>
                  useBatchPublishStore.getState().addItem({
                    filePath: f.file_path,
                    title: f.filename ?? "",
                    caption: "",
                    tags: "",
                    accountIdsByPlatform: {},
                    mode: "immediate",
                  })
                }
              >
                <Plus className="size-3 text-meta" />
                <span className="min-w-0 truncate font-medium text-fg">{f.filename}</span>
                <span className="ml-auto text-caption text-meta">{f.filesize} MB</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 展开/折叠全部 */}
      {items.length > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={expandAll}
            disabled={expandedAll}
            aria-label="展开全部"
          >
            <ChevronDown className="size-3" />
            展开全部
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={collapseAll}
            disabled={collapsedAll}
            aria-label="折叠全部"
          >
            <ChevronRight className="size-3" />
            折叠全部
          </Button>
        </div>
      )}

      {/* 视频条目列表（抽屉矩阵） */}
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft">
          <Empty
            title="还没有批量条目"
            description="在上方「添加视频到批量」挑视频加入；每个视频独立配置标题/账号/模式"
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const isExpanded = !!expandedMap[item.filePath];
            const summary = summarizeItem(item);
            const localErrors = errorsByFilePath.get(item.filePath) ?? [];
            return (
              <li
                key={item.filePath}
                className={cn(
                  "rounded-lg border border-border-soft bg-bg",
                  localErrors.length > 0 && "border-danger",
                )}
              >
                {/* 折叠态：摘要徽标 */}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
                  onClick={() => toggleRow(item.filePath)}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "折叠" : "展开"} ${item.filePath}`}
                >
                  {isExpanded ? (
                    <ChevronDown className="size-4 shrink-0 text-meta" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-meta" />
                  )}
                  <span className="min-w-0 truncate font-medium text-fg">
                    {item.filePath}
                  </span>
                  <span className="ml-2 inline-flex items-center gap-1.5 text-caption text-meta">
                    <span
                      className={cn(
                        "rounded-sm px-1.5 py-0.5",
                        summary.totalAccounts > 0
                          ? "bg-accent-tint text-accent-ink"
                          : "bg-danger-tint text-danger-deep",
                      )}
                    >
                      {summary.accountSummary}
                    </span>
                    <span
                      className={cn(
                        "rounded-sm px-1.5 py-0.5",
                        item.mode === "immediate" || summary.timeOfDayLabel
                          ? "bg-surface-warm text-fg-2"
                          : "bg-danger-tint text-danger-deep",
                      )}
                    >
                      {summary.modeSummary}
                      {summary.timeOfDayLabel ? ` · ${summary.timeOfDayLabel}` : ""}
                    </span>
                    {summary.startDaysLabel && (
                      <span className="rounded-sm bg-surface-warm px-1.5 py-0.5 text-fg-2">
                        起始 {summary.startDaysLabel}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="ml-auto rounded-md p-1 text-meta transition-colors hover:bg-surface hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeItem(item.filePath);
                    }}
                    aria-label={`从批量移除 ${item.filePath}`}
                  >
                    <X className="size-4" />
                  </button>
                </button>

                {/* 展开态：编辑字段 */}
                {isExpanded && (
                  <div className="flex flex-col gap-3 border-t border-border-soft px-4 py-3">
                    {/* 标题 / 描述 / 标签 */}
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-caption text-meta">标题</label>
                        <Input
                          value={item.title}
                          maxLength={60}
                          placeholder="视频标题"
                          onChange={(e) => updateItem(item.filePath, { title: e.target.value })}
                          aria-label={`${item.filePath} 标题`}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-caption text-meta">标签（空格或逗号分隔）</label>
                        <Input
                          value={item.tags}
                          placeholder="如 #批量 发布"
                          onChange={(e) => updateItem(item.filePath, { tags: e.target.value })}
                          aria-label={`${item.filePath} 标签`}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-caption text-meta">描述（合入标题下发）</label>
                      <Textarea
                        value={item.caption}
                        placeholder="正文 / 描述（折叠进 title 一起发到官方）"
                        onChange={(e) => updateItem(item.filePath, { caption: e.target.value })}
                        aria-label={`${item.filePath} 描述`}
                      />
                    </div>

                    {/* 账号勾选（按平台） */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-caption text-meta">账号（按平台）</span>
                      <div className="flex flex-col gap-1.5">
                        {PLATFORMS.map((p) => {
                          const list = accounts.filter((a) => a.platform === p);
                          if (list.length === 0) return null;
                          return (
                            <div
                              key={p}
                              className="rounded-md border border-border-soft bg-bg px-3 py-2"
                            >
                              <div className="mb-1.5 flex items-center gap-2">
                                <PlatformMark platform={p} />
                                <span className="text-caption text-meta">
                                  {OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[p]]}
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {list.map((a) => {
                                  const cur = item.accountIdsByPlatform[p] ?? [];
                                  const checked = cur.includes(a.cookieFile);
                                  const usable = a.status === 1;
                                  return (
                                    <label
                                      key={a.id}
                                      className={cn(
                                        "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border-soft px-2.5 py-1.5 text-label transition-colors hover:bg-surface-warm",
                                        checked && "border-accent bg-accent-tint",
                                        !usable && "opacity-55",
                                      )}
                                    >
                                      <Checkbox
                                        checked={checked}
                                        disabled={!usable}
                                        onChange={() => {
                                          const next = checked
                                            ? cur.filter((c) => c !== a.cookieFile)
                                            : [...cur, a.cookieFile];
                                          updateItem(item.filePath, {
                                            accountIdsByPlatform: {
                                              ...item.accountIdsByPlatform,
                                              [p]: next,
                                            },
                                          });
                                        }}
                                        aria-label={`${item.filePath} 勾选 ${a.name}`}
                                      />
                                      {a.name}
                                      {p === "wechat" && (
                                        <div
                                          data-slot={`platform-limit-hint-wechat-${a.cookieFile}`}
                                          aria-hidden="true"
                                        />
                                      )}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* 模式：立即 / 定时 switch */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-caption text-meta">发布模式</span>
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={item.mode === "timer"}
                          onCheckedChange={(checked) =>
                            setItemMode(item.filePath, checked ? "timer" : "immediate")
                          }
                          aria-label={`${item.filePath} 定时模式`}
                        />
                        <span className="text-label text-fg-2">
                          {item.mode === "timer" ? "定时发布" : "立即发布"}
                        </span>
                      </div>
                      {item.mode === "timer" && (
                        <div className="flex flex-wrap items-center gap-3 pt-1">
                          <div className="flex items-center gap-2">
                            <span className="text-caption text-meta">时刻</span>
                            <Select
                              value={item.timeOfDay ?? ""}
                              onValueChange={(v) => setItemTimeOfDay(item.filePath, v)}
                            >
                              <SelectTrigger className="h-8 w-[120px]">
                                <SelectValue placeholder="从顶部池里挑" />
                              </SelectTrigger>
                              <SelectContent>
                                {sortedDailyTimes.length === 0 ? (
                                  <SelectItem value="__empty__" disabled>
                                    先在顶部加时刻
                                  </SelectItem>
                                ) : (
                                  sortedDailyTimes.map((hm) => (
                                    <SelectItem key={hm} value={hm}>
                                      {hm}
                                    </SelectItem>
                                  ))
                                )}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-caption text-meta">起始日（0 = 明天起）</span>
                            <Input
                              type="number"
                              min={0}
                              className="h-8 w-[80px]"
                              value={item.startDays ?? 0}
                              onChange={(e) => {
                                const n = Number(e.target.value);
                                updateItem(item.filePath, {
                                  startDays: Number.isInteger(n) && n >= 0 ? n : 0,
                                });
                              }}
                              aria-label={`${item.filePath} 起始日`}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 行内错误 */}
                    {localErrors.length > 0 && (
                      <ul className="flex flex-col gap-1 rounded-md border border-danger bg-danger-tint px-3 py-2 text-caption text-danger-deep">
                        {localErrors.map((e) => (
                          <li key={e}>· {e}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 提交按钮 + 全局错误 */}
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={!connected || submitting || items.length === 0 || allErrors.length > 0}
          onClick={openPreview}
        >
          <Send className="size-4" />
          {submitting ? "提交中…" : `批量发布（${items.length} 视频）`}
        </Button>
        {!connected && (
          <span className="text-caption text-meta">守护进程未连接，无法发布</span>
        )}
        <Button variant="ghost" size="sm" onClick={reset}>
          重置
        </Button>
      </div>

      {/* 整体反馈（按 item 维度） */}
      {itemResults && itemResults.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {itemResults.map((r) => (
            <div
              key={r.itemKey}
              className={cn(
                "flex items-start gap-2 rounded-lg border px-4 py-2.5 text-label",
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
                  <span className="tabular-nums">{r.fileName}</span>
                  <span className="ml-2 text-caption text-muted">
                    {OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[r.platform]]} · {r.itemKey.split("|")[1]}
                  </span>
                </p>
                {!r.ok && <p className="mt-0.5 break-words">{r.msg}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 预览 Dialog */}
      <BatchPreviewDialog
        open={previewOpen}
        items={items}
        results={itemResults}
        onConfirm={() => void handleConfirmPreview()}
        onCancel={closePreview}
      />
    </section>
  );
}