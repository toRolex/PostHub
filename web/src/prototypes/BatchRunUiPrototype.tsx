/*
 * PROTOTYPE · throwaway · issue #77
 *
 * THESIS: 运行结果是批量发布流程的主舞台，而不是请求结束后的 toast；本原型拒绝把逐项状态藏进二元结果提示。
 * OWN-WORLD: 沿用 PostHub 的 Quiet Control Room：冷白底、Action Blue 单 accent、紧凑表格、语义色只服务状态。
 * STORY: 用户提交后能看见 run 在跑、知道哪些项成功/失败，并能恢复、重试或处理重复风险。
 * FIRST VIEWPORT: 页面第一屏直接展示 run 标题、进度与逐项结果；底部原型栏切换三种信息架构。
 * FORM: UI prototype；A=Dialog 运行面板，B=顶部状态条+详情侧栏，C=发布页内 run ledger。
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  FileVideo,
  History,
  Info,
  LoaderCircle,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { PlatformMark } from "../components/ui/platform-mark";

type VariantKey = "A" | "B" | "C";
type RunMode = "running" | "partial" | "complete" | "conflict" | "resume";
type CheckMode = "block" | "soft";

type ItemStatus = "pending" | "running" | "success" | "failure" | "skipped" | "interrupted";

type RunItem = {
  id: string;
  file: string;
  platform: "douyin" | "xiaohongshu" | "wechat";
  account: string;
  status: ItemStatus;
  reason?: string;
  scheduled?: string;
};

const VARIANTS: readonly { key: VariantKey; name: string; summary: string }[] = [
  { key: "A", name: "Dialog 运行面板", summary: "提交后原地变身，最短路径盯结果" },
  { key: "B", name: "状态条 + 详情侧栏", summary: "不打断发布页，按需展开 run" },
  { key: "C", name: "Run ledger", summary: "把批次当成发布页的一等内容" },
];

const BASE_ITEMS: RunItem[] = [
  { id: "1", file: "春游.mp4", platform: "douyin", account: "抖音 · 主号", status: "success", scheduled: "今天 14:00" },
  { id: "2", file: "春游.mp4", platform: "xiaohongshu", account: "小红书 · 工作室", status: "failure", reason: "CDP 连接中断", scheduled: "今天 14:00" },
  { id: "3", file: "夜市.mp4", platform: "wechat", account: "视频号 · 运营号", status: "skipped", reason: "超出平台定时窗口", scheduled: "明天 10:30" },
  { id: "4", file: "夜市.mp4", platform: "douyin", account: "抖音 · 主号", status: "success", scheduled: "明天 10:30" },
  { id: "5", file: "雨后.mp4", platform: "xiaohongshu", account: "小红书 · 工作室", status: "running", scheduled: "明天 18:00" },
  { id: "6", file: "雨后.mp4", platform: "wechat", account: "视频号 · 运营号", status: "pending", scheduled: "明天 18:00" },
];

function readVariant(): VariantKey {
  const value = new URLSearchParams(window.location.search).get("variant");
  return VARIANTS.some((item) => item.key === value) ? (value as VariantKey) : "A";
}

function useVariant(): [VariantKey, (next: VariantKey) => void] {
  const [variant, setVariant] = useState<VariantKey>(readVariant);
  function change(next: VariantKey): void {
    const url = new URL(window.location.href);
    url.searchParams.set("prototype", "batch-run");
    url.searchParams.set("variant", next);
    window.history.replaceState({}, "", url);
    setVariant(next);
  }
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const current = VARIANTS.findIndex((item) => item.key === variant);
      const offset = event.key === "ArrowRight" ? 1 : -1;
      change(VARIANTS[(current + offset + VARIANTS.length) % VARIANTS.length].key);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [variant]);
  return [variant, change];
}

function usePrototypeState() {
  const [mode, setMode] = useState<RunMode>("partial");
  const [items, setItems] = useState<RunItem[]>(BASE_ITEMS);
  const [expanded, setExpanded] = useState<string | null>("2");
  const [checkMode, setCheckMode] = useState<CheckMode>("block");
  const [duplicate, setDuplicate] = useState(true);
  const [historyWarning, setHistoryWarning] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const runId = mode === "resume" ? "run-077" : mode === "conflict" ? "run-099" : "run-101";
  const completed = items.filter((item) => item.status === "success").length;
  const actionable = items.filter((item) => item.status !== "success");
  const hasBlockingDuplicate = duplicate && checkMode === "block";

  function applyMode(next: RunMode): void {
    setMode(next);
    if (next === "running") {
      setItems(BASE_ITEMS.map((item, index) => ({ ...item, status: index < 2 ? "success" : index === 2 ? "running" : "pending", reason: undefined })));
    } else if (next === "complete") {
      setItems(BASE_ITEMS.map((item) => ({ ...item, status: "success", reason: undefined })));
    } else if (next === "resume") {
      setItems(BASE_ITEMS.map((item, index) => ({ ...item, status: index === 0 ? "success" : "interrupted", reason: index === 0 ? undefined : "守护进程重启时未完成" })));
    } else {
      setItems(BASE_ITEMS);
    }
    setExpanded("2");
  }

  function retry(itemIds?: string[]): void {
    const selected = new Set(itemIds ?? actionable.map((item) => item.id));
    setItems((current) => current.map((item) => selected.has(item.id) ? { ...item, status: "running", reason: undefined } : item));
    setMode("running");
    setToast(`已创建新 run，只重试 ${selected.size} 个非成功项`);
  }

  function submit(): void {
    if (hasBlockingDuplicate) {
      setToast("提交被阻断：先处理同视频 × 同账号重复项");
      return;
    }
    if (mode === "conflict") {
      setToast("已有 run-099 进行中，本次未受理");
      return;
    }
    setToast(historyWarning ? "已受理；同时发现 1 条历史成功记录，请核对" : "已受理，run-101 开始执行");
    applyMode("running");
  }

  return {
    mode,
    items,
    expanded,
    checkMode,
    duplicate,
    historyWarning,
    toast,
    runId,
    completed,
    actionable,
    hasBlockingDuplicate,
    setExpanded,
    setCheckMode,
    setDuplicate,
    setHistoryWarning,
    setToast,
    applyMode,
    retry,
    submit,
  };
}

type PrototypeState = ReturnType<typeof usePrototypeState>;

function StatusPill({ status }: { status: ItemStatus | RunMode }): ReactElement {
  const meta: Record<string, { label: string; className: string; icon: typeof Check }> = {
    running: { label: "执行中", className: "bg-accent-tint text-accent-ink", icon: LoaderCircle },
    pending: { label: "等待中", className: "bg-surface text-muted", icon: Clock3 },
    success: { label: "成功", className: "bg-success-tint text-success-deep", icon: CheckCircle2 },
    failure: { label: "失败", className: "bg-danger-tint text-danger-deep", icon: XCircle },
    skipped: { label: "已跳过", className: "bg-warn-tint text-warn-deep", icon: ShieldAlert },
    interrupted: { label: "已中断", className: "bg-danger-tint text-danger-deep", icon: RotateCcw },
    partial: { label: "部分成功", className: "bg-warn-tint text-warn-deep", icon: AlertTriangle },
    complete: { label: "已完成", className: "bg-success-tint text-success-deep", icon: CheckCircle2 },
    conflict: { label: "提交冲突", className: "bg-danger-tint text-danger-deep", icon: XCircle },
    resume: { label: "已恢复", className: "bg-accent-tint text-accent-ink", icon: History },
  };
  const current = meta[status] ?? meta.pending;
  const Icon = current.icon;
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium", current.className)}><Icon className={cn("size-3", status === "running" && "animate-spin")} />{current.label}</span>;
}

function PlatformLabel({ item }: { item: RunItem }): ReactElement {
  return <span className="inline-flex items-center gap-2"><PlatformMark platform={item.platform} /><span>{item.account}</span></span>;
}

function ProgressSummary({ state, compact = false }: { state: PrototypeState; compact?: boolean }): ReactElement {
  const total = state.items.length;
  const progress = Math.round((state.completed / total) * 100);
  return <div className={cn("flex items-center gap-3", compact ? "text-caption" : "text-label")}>
    <div className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-surface-sunk"><div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress}%` }} /></div>
    <span className="shrink-0 tabular-nums text-muted">{state.completed}/{total} 成功</span>
  </div>;
}

function RunHeader({ state, onOpenHistory }: { state: PrototypeState; onOpenHistory?: () => void }): ReactElement {
  return <div className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <div className="flex items-center gap-2"><Send className="size-4 text-accent" /><h2 className="truncate text-title font-semibold">批量发布 · 春游与夜市</h2><StatusPill status={state.mode} /></div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted"><span className="font-mono">{state.runId}</span><span>6 个发布项</span><span>刚刚更新</span>{state.mode === "resume" && <span className="text-danger-deep">来自页面恢复</span>}</div>
    </div>
    {onOpenHistory && <Button variant="ghost" size="sm" onClick={onOpenHistory}><History className="size-3.5" />最近运行</Button>}
  </div>;
}

function RunItemsTable({ state, showActions = true }: { state: PrototypeState; showActions?: boolean }): ReactElement {
  return <div className="overflow-hidden rounded-lg border border-border-soft bg-bg">
    <table className="w-full text-label">
      <thead className="bg-surface-warm text-caption text-meta"><tr><th className="px-3 py-2 text-left font-medium">视频</th><th className="px-3 py-2 text-left font-medium">平台 / 账号</th><th className="px-3 py-2 text-left font-medium">排期</th><th className="px-3 py-2 text-left font-medium">结果</th>{showActions && <th className="px-3 py-2 text-right font-medium">操作</th>}</tr></thead>
      <tbody>{state.items.map((item) => <tr key={item.id} className={cn("border-t border-border-soft", item.status === "failure" && "bg-danger-tint/45", item.status === "skipped" && "bg-warn-tint/35")}>
        <td className="max-w-[170px] truncate px-3 py-3 font-medium text-fg"><span className="inline-flex max-w-full items-center gap-2"><FileVideo className="size-3.5 shrink-0 text-meta" /><span className="truncate">{item.file}</span></span></td>
        <td className="px-3 py-3 text-fg-2"><PlatformLabel item={item} /></td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted">{item.scheduled}</td>
        <td className="px-3 py-3"><div className="flex flex-wrap items-center gap-2"><StatusPill status={item.status} />{item.reason && <span className="text-caption text-danger-deep">{item.reason}</span>}</div></td>
        {showActions && <td className="px-3 py-3 text-right">{item.status !== "success" && <Button variant="ghost" size="sm" onClick={() => state.retry([item.id])}><RotateCcw className="size-3.5" />重试</Button>}</td>}
      </tr>)}</tbody>
    </table>
  </div>;
}

function DuplicateCheck({ state }: { state: PrototypeState }): ReactElement {
  return <section className="border-t border-border-soft pt-4">
    <div className="mb-2 flex items-center justify-between gap-3"><div><h3 className="text-label font-semibold">提交前检查</h3><p className="text-caption text-muted">用这组开关比较 Q2 / Q7 的交互强度</p></div><div className="flex rounded-md border border-border-soft p-0.5 text-caption"><button type="button" className={cn("rounded px-2 py-1", state.checkMode === "block" && "bg-accent-tint text-accent-ink")} onClick={() => state.setCheckMode("block")}>阻断</button><button type="button" className={cn("rounded px-2 py-1", state.checkMode === "soft" && "bg-accent-tint text-accent-ink")} onClick={() => state.setCheckMode("soft")}>软提示</button></div></div>
    <div className="flex flex-col gap-2 text-label">
      <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={state.duplicate} onChange={(event) => state.setDuplicate(event.target.checked)} /> 同批内存在「春游.mp4 × 抖音·主号」重复项</label>
      {state.duplicate && <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-caption", state.checkMode === "block" ? "border-danger bg-danger-tint text-danger-deep" : "border-warn bg-warn-tint text-warn-deep")}><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>{state.checkMode === "block" ? "提交按钮禁用：同一视频 × 同一账号重复发布没有安全语义。" : "发现重复项，但仍可点「继续提交」。"}</span></div>}
      <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={state.historyWarning} onChange={(event) => state.setHistoryWarning(event.target.checked)} /> 跨提交发现历史成功记录</label>
      {state.historyWarning && <div className="flex items-start gap-2 rounded-md border border-warn bg-warn-tint px-3 py-2 text-caption text-warn-deep"><History className="mt-0.5 size-3.5 shrink-0" /><span>软警示：春游.mp4 × 抖音·主号 × 今天 14:00 已有成功记录；展示明细，但不阻断。</span></div>}
    </div>
  </section>;
}

function ActionBar({ state }: { state: PrototypeState }): ReactElement {
  return <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4"><Button variant="primary" size="sm" disabled={state.hasBlockingDuplicate} onClick={state.submit}><Send className="size-3.5" />{state.hasBlockingDuplicate ? "处理重复项后提交" : "提交批量发布"}</Button>{state.actionable.length > 0 && <Button variant="secondary" size="sm" onClick={() => state.retry()}><RotateCcw className="size-3.5" />重试全部失败项（{state.actionable.length}）</Button>}<span className="ml-auto text-caption text-muted">提交后可关闭页面，凭 runId 恢复</span></div>;
}

function ScenarioToolbar({ state }: { state: PrototypeState }): ReactElement {
  return <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-surface-warm p-3"><span className="mr-1 text-caption font-semibold text-fg-2">原型情境</span>{(["running", "partial", "complete", "conflict", "resume"] as RunMode[]).map((mode) => <button type="button" key={mode} onClick={() => state.applyMode(mode)} className={cn("rounded-md border px-2.5 py-1 text-caption", state.mode === mode ? "border-accent bg-accent-tint text-accent-ink" : "border-border-soft bg-bg text-muted hover:border-accent")}>{mode === "running" ? "执行中" : mode === "partial" ? "部分成功" : mode === "complete" ? "全部成功" : mode === "conflict" ? "409 冲突" : "刷新恢复"}</button>)}<span className="ml-auto text-caption text-meta">仅用于观察，不连接 daemon</span></div>;
}

function ConflictBanner({ state, onView }: { state: PrototypeState; onView: () => void }): ReactElement | null {
  if (state.mode !== "conflict") return null;
  return <div className="mb-4 flex items-start gap-3 rounded-lg border border-danger bg-danger-tint px-4 py-3 text-label text-danger-deep"><XCircle className="mt-0.5 size-4 shrink-0" /><div className="min-w-0"><p className="font-semibold">这次提交没有受理</p><p className="mt-0.5 text-caption">已有 run-099 正在执行。单飞行策略不会排队，也不会覆盖现有 run。</p></div><Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={onView}><ExternalLink className="size-3.5" />查看 run-099</Button></div>;
}

function RestoreNotice({ state }: { state: PrototypeState }): ReactElement | null {
  if (state.mode !== "resume") return null;
  return <div className="mb-4 flex items-start gap-3 rounded-lg border border-warn bg-warn-tint px-4 py-3 text-label text-warn-deep"><History className="mt-0.5 size-4 shrink-0" /><div><p className="font-semibold">已从最近运行恢复</p><p className="mt-0.5 text-caption">run-077 在守护进程重启时被标记为 interrupted，不自动续跑；可逐项重试。</p></div></div>;
}

function VariantA({ state }: { state: PrototypeState }): ReactElement {
  const [open, setOpen] = useState(true);
  return <div className="relative min-h-[680px] overflow-hidden rounded-xl border border-border-soft bg-surface-sunk p-4"><div className="absolute inset-0 bg-black/15" /><div className="relative mx-auto mt-6 max-w-[820px] rounded-xl border border-border-soft bg-bg shadow-[0_18px_50px_oklch(0.16_0.01_300/0.18)]">
    {open ? <div className="p-5"><div className="mb-4 flex items-start justify-between"><RunHeader state={state} /><button type="button" className="rounded-md p-1 text-meta hover:bg-surface" onClick={() => setOpen(false)} aria-label="关闭运行面板"><X className="size-4" /></button></div><ProgressSummary state={state} /><div className="my-4"><ConflictBanner state={state} onView={() => state.applyMode("conflict")} /><RestoreNotice state={state} /></div><RunItemsTable state={state} /><div className="mt-4 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 text-caption text-muted"><Info className="size-3.5" />关闭此面板不影响后台执行</div><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => state.retry()} disabled={state.actionable.length === 0}><RotateCcw className="size-3.5" />重试全部失败项</Button><Button variant="primary" size="sm" onClick={() => setOpen(false)}>继续编辑批次</Button></div></div></div> : <button type="button" className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setOpen(true)}><CircleDot className="size-4 text-accent" /><span className="text-label font-medium">run-101 正在执行</span><ProgressSummary state={state} compact /></button>}
  </div></div>;
}

function VariantB({ state }: { state: PrototypeState }): ReactElement {
  const [details, setDetails] = useState(true);
  return <div className="relative min-h-[680px] rounded-xl border border-border-soft bg-bg p-4"><div className="mb-4 flex items-center gap-3 rounded-lg border border-accent/35 bg-accent-tint px-4 py-3"><div className="grid size-8 place-items-center rounded-md bg-bg text-accent"><LoaderCircle className="size-4 animate-spin" /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="text-label font-semibold">批量发布正在执行</span><StatusPill status={state.mode} /></div><div className="mt-1 flex items-center gap-3"><ProgressSummary state={state} compact /><span className="whitespace-nowrap text-caption text-muted">run-101 · 关闭页面也会继续</span></div></div><Button variant="secondary" size="sm" onClick={() => setDetails((value) => !value)}><PanelRight className="size-3.5" />{details ? "收起详情" : "查看详情"}</Button></div><div className={cn("grid gap-4", details ? "lg:grid-cols-[1fr_280px]" : "grid-cols-1")}><div><div className="mb-3 flex items-center justify-between"><h2 className="text-title font-semibold">发布批次</h2><Button variant="ghost" size="sm"><History className="size-3.5" />最近运行</Button></div><RunItemsTable state={state} /></div>{details && <aside className="rounded-lg border border-border-soft bg-surface-warm p-4"><RunHeader state={state} /><div className="mt-5 space-y-4"><div><p className="text-caption text-muted">执行时间</p><p className="mt-1 text-label">00:01:24 · 已完成 {state.completed} 项</p></div><div><p className="text-caption text-muted">失败处理</p><p className="mt-1 text-label">仅重试 failure / skipped / interrupted</p></div><div className="rounded-md border border-border-soft bg-bg p-3 text-caption text-muted"><Copy className="mb-2 size-3.5 text-accent" />runId 可用于刷新恢复；不会自动重发成功项。</div></div><div className="mt-6 flex flex-col gap-2"><Button variant="secondary" size="sm" onClick={() => state.retry()} disabled={state.actionable.length === 0}><RotateCcw className="size-3.5" />重试全部失败项</Button><Button variant="ghost" size="sm" onClick={() => state.setToast("已复制 runId：" + state.runId)}><Copy className="size-3.5" />复制 runId</Button></div></aside>}</div><DuplicateCheck state={state} /><ActionBar state={state} /></div>;
}

function VariantC({ state }: { state: PrototypeState }): ReactElement {
  const [selected, setSelected] = useState<string[]>(state.actionable.map((item) => item.id));
  const [showChecks, setShowChecks] = useState(true);
  const selectedCount = selected.length;
  return <div className="min-h-[680px] rounded-xl border border-border-soft bg-surface-warm p-5"><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-page font-semibold tracking-[-0.015em]">批量发布</h2><p className="mt-1 text-label text-muted">把一次提交当成可回看的 run，而不是一次性请求。</p></div><div className="flex items-center gap-2"><Button variant="ghost" size="sm"><History className="size-3.5" />运行历史</Button><Button variant="secondary" size="sm"><RefreshCw className="size-3.5" />刷新</Button></div></div><div className="mb-5 grid gap-3 sm:grid-cols-3"><div className="border-b border-border-soft pb-3"><p className="text-caption text-muted">当前 run</p><p className="mt-1 font-mono text-label">{state.runId}</p></div><div className="border-b border-border-soft pb-3"><p className="text-caption text-muted">状态</p><div className="mt-1"><StatusPill status={state.mode} /></div></div><div className="border-b border-border-soft pb-3"><p className="text-caption text-muted">进度</p><div className="mt-1"><ProgressSummary state={state} compact /></div></div></div><div className="mb-3 flex items-center justify-between"><div><h3 className="text-title font-semibold">逐项结果</h3><p className="text-caption text-muted">失败项可勾选后批量重试；success 永远不会进入新 run。</p></div><Button variant="ghost" size="sm" onClick={() => setShowChecks((value) => !value)}>{showChecks ? "收起提交前检查" : "展开提交前检查"}<ChevronDown className={cn("size-3.5 transition-transform", !showChecks && "-rotate-90")} /></Button></div><div className="overflow-hidden rounded-lg border border-border-soft bg-bg"><table className="w-full text-label"><thead className="bg-surface text-caption text-meta"><tr><th className="w-10 px-3 py-2"><input aria-label="全选可重试项" type="checkbox" checked={selectedCount > 0 && selectedCount === state.actionable.length} onChange={(event) => setSelected(event.target.checked ? state.actionable.map((item) => item.id) : [])} /></th><th className="px-3 py-2 text-left font-medium">发布项</th><th className="px-3 py-2 text-left font-medium">状态</th><th className="px-3 py-2 text-right font-medium">单项操作</th></tr></thead><tbody>{state.items.map((item) => <tr key={item.id} className="border-t border-border-soft"><td className="px-3 py-3">{item.status !== "success" && <input aria-label={`选择重试 ${item.file}`} type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />}</td><td className="px-3 py-3"><div className="font-medium">{item.file}</div><div className="mt-1 text-caption text-muted"><PlatformLabel item={item} /> · {item.scheduled}</div></td><td className="px-3 py-3"><StatusPill status={item.status} />{item.reason && <div className="mt-1 text-caption text-danger-deep">{item.reason}</div>}</td><td className="px-3 py-3 text-right">{item.status !== "success" && <Button variant="ghost" size="sm" onClick={() => state.retry([item.id])}><RotateCcw className="size-3.5" />重试</Button>}</td></tr>)}</tbody></table></div>{showChecks && <div className="mt-5"><DuplicateCheck state={state} /></div>}<div className="sticky bottom-0 mt-5 flex flex-wrap items-center gap-3 border-t border-border-soft bg-surface-warm pt-4"><Button variant="secondary" size="sm" disabled={selectedCount === 0} onClick={() => state.retry(selected)}><RotateCcw className="size-3.5" />重试已选（{selectedCount}）</Button><Button variant="primary" size="sm" disabled={state.hasBlockingDuplicate} onClick={state.submit}><Send className="size-3.5" />提交新批次</Button><span className="ml-auto text-caption text-muted">新 run 只复制非 success 项的原始 payload</span></div></div>;
}

function PrototypeSwitcher({ current, onChange }: { current: VariantKey; onChange: (key: VariantKey) => void }): ReactElement {
  const index = VARIANTS.findIndex((item) => item.key === current);
  const previous = VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length];
  const next = VARIANTS[(index + 1) % VARIANTS.length];
  return <div className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-fg bg-fg px-2 py-1.5 text-white shadow-lg"><button type="button" className="grid size-7 place-items-center rounded-full text-white/75 hover:bg-white/15" onClick={() => onChange(previous.key)} aria-label={`上一个方案：${previous.name}`}><ChevronRight className="size-4 rotate-180" /></button><button type="button" className="min-w-[250px] rounded-full px-3 py-1 text-center hover:bg-white/10" onClick={() => onChange(next.key)}><span className="text-label font-semibold">{current} · {VARIANTS[index].name}</span><span className="ml-2 text-caption text-white/65">{VARIANTS[index].summary}</span></button><button type="button" className="grid size-7 place-items-center rounded-full text-white/75 hover:bg-white/15" onClick={() => onChange(next.key)} aria-label={`下一个方案：${next.name}`}><ChevronRight className="size-4" /></button></div>;
}

function StateControls({ state }: { state: PrototypeState }): ReactElement {
  return <div className="mb-5 rounded-lg border border-warn bg-warn-tint px-4 py-3 text-warn-deep"><div className="flex flex-wrap items-center gap-2"><AlertTriangle className="size-4" /><span className="text-label font-semibold">原型控制台</span><span className="text-caption">点击情境观察 Q1–Q7；所有数据为 synthetic。</span></div><ScenarioToolbar state={state} /></div>;
}

export function BatchRunUiPrototype(): ReactElement {
  const [variant, setVariant] = useVariant();
  const state = usePrototypeState();
  const meta = VARIANTS.find((item) => item.key === variant)!;
  const subtitle = useMemo(() => `当前方案：${meta.name} · ${meta.summary}`, [meta]);
  useEffect(() => { if (!state.toast) return; const timer = window.setTimeout(() => state.setToast(null), 3000); return () => window.clearTimeout(timer); }, [state.toast, state.setToast]);

  return <div className="min-h-full bg-bg px-6 pb-24 pt-8 lg:px-10"><div className="mx-auto max-w-[1120px]"><div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><div className="mb-2 flex items-center gap-2"><span className="rounded bg-warn-tint px-2 py-1 text-caption font-semibold text-warn-deep">PROTOTYPE · throwaway</span><span className="text-caption text-meta">/ 发布 / 批量 run</span></div><h1 className="text-page font-semibold tracking-[-0.015em]">批量发布结果工作台</h1><p className="mt-2 max-w-[760px] text-body text-muted">用三个结构不同的方案观察：提交后结果放在哪里、失败项怎样重试、页面刷新如何回来，以及查重与 409 应该多强地打断用户。</p></div><Button variant="ghost" size="sm" onClick={() => window.history.back()}>退出原型</Button></div><div className="mb-4 rounded-lg border border-border-soft bg-surface-warm px-4 py-3 text-label text-fg-2"><span className="font-semibold">{subtitle}</span><span className="ml-3 text-caption text-muted">可用 ← / → 切换方案</span></div><StateControls state={state} />{state.mode === "conflict" && <ConflictBanner state={state} onView={() => state.applyMode("running")} />}{state.mode === "resume" && <RestoreNotice state={state} />}{variant === "A" && <VariantA state={state} />}{variant === "B" && <VariantB state={state} />}{variant === "C" && <VariantC state={state} />}</div>{state.toast && <div role="status" className="fixed bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-fg px-4 py-3 text-label text-white shadow-lg"><Check className="size-4 text-success" />{state.toast}</div>}<PrototypeSwitcher current={variant} onChange={setVariant} /></div>;
}
