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
  LoaderCircle,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { PlatformMark } from "../components/ui/platform-mark";
import { cn } from "../lib/utils";
import {
  getSyntheticRun,
  intersectRetrySelection,
  isRetryableItemStatus,
  retryRun,
  retryableItems,
  type BatchRun,
  type BatchRunItem,
  type ItemStatus,
} from "./batchRunState";

type VariantKey = "A" | "B" | "C";
type Scenario = "running" | "partial" | "complete" | "conflict" | "resume";
type CheckMode = "block" | "soft";

const VARIANTS: readonly { key: VariantKey; name: string; summary: string }[] = [
  { key: "A", name: "Dialog 运行面板", summary: "提交后原地变身，最短路径盯结果" },
  { key: "B", name: "状态条 + 详情侧栏", summary: "不打断发布页，按需展开 run" },
  { key: "C", name: "Run ledger", summary: "把批次当成发布页的一等内容" },
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

function scenarioRun(scenario: Scenario): BatchRun {
  if (scenario === "running") return getSyntheticRun("run-099");
  if (scenario === "resume") return getSyntheticRun("run-077");
  const partial = getSyntheticRun("run-101");
  if (scenario === "complete") {
    return {
      ...partial,
      status: "completed",
      items: partial.items.map((item) => ({ ...item, status: "success", reason: undefined })),
    };
  }
  return partial;
}

function usePrototypeState() {
  const [scenario, setScenario] = useState<Scenario>("partial");
  const [run, setRun] = useState<BatchRun>(() => scenarioRun("partial"));
  const [checkMode, setCheckMode] = useState<CheckMode>("block");
  const [duplicate, setDuplicate] = useState(true);
  const [historyWarning, setHistoryWarning] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<string | null>("2");
  const [runCounter, setRunCounter] = useState(102);

  const actionable = useMemo(() => retryableItems(run.items), [run.items]);
  const completed = run.items.filter((item) => item.status === "success").length;
  const hasBlockingDuplicate = duplicate && checkMode === "block";

  function applyScenario(next: Scenario): void {
    setScenario(next);
    setRun(scenarioRun(next));
    setSelectedItem(next === "complete" ? null : "2");
  }

  function openConflictRun(): void {
    const conflictRun = getSyntheticRun("run-099");
    setRun(conflictRun);
    setScenario("running");
    setSelectedItem(conflictRun.items[0]?.id ?? null);
    setToast("已打开 synthetic run-099");
  }

  function retry(itemIds?: readonly string[]): void {
    const newRunId = `run-${runCounter}`;
    try {
      const nextRun = retryRun(run, newRunId, itemIds);
      setRun(nextRun);
      setScenario("running");
      setRunCounter((value) => value + 1);
      setSelectedItem(nextRun.items[0]?.id ?? null);
      setToast(`已创建 synthetic ${newRunId}，parentRunId=${run.runId}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  }

  function submit(): void {
    if (hasBlockingDuplicate) {
      setToast("提交被阻断：先处理同视频 × 同账号重复项");
      return;
    }
    setToast(historyWarning ? "synthetic 提交已受理；发现 1 条历史成功占位" : "synthetic 提交已受理");
    applyScenario("running");
  }

  async function copyRunId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(run.runId);
      setToast(`已复制 ${run.runId}`);
    } catch (error) {
      setToast(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    scenario,
    run,
    items: run.items,
    checkMode,
    duplicate,
    historyWarning,
    toast,
    selectedItem,
    completed,
    actionable,
    hasBlockingDuplicate,
    setCheckMode,
    setDuplicate,
    setHistoryWarning,
    setToast,
    setSelectedItem,
    applyScenario,
    openConflictRun,
    retry,
    submit,
    copyRunId,
  };
}

type PrototypeState = ReturnType<typeof usePrototypeState>;

function StatusPill({ status }: { status: ItemStatus | BatchRun["status"] | Scenario }): ReactElement {
  const meta: Record<string, { label: string; className: string; icon: typeof Check }> = {
    running: { label: "执行中", className: "bg-accent-tint text-accent-ink", icon: LoaderCircle },
    pending: { label: "等待中", className: "bg-surface text-muted", icon: Clock3 },
    success: { label: "成功", className: "bg-success-tint text-success-deep", icon: CheckCircle2 },
    failure: { label: "失败", className: "bg-danger-tint text-danger-deep", icon: XCircle },
    skipped: { label: "已跳过", className: "bg-warn-tint text-warn-deep", icon: ShieldAlert },
    interrupted: { label: "已中断", className: "bg-danger-tint text-danger-deep", icon: RotateCcw },
    invalid: { label: "协议错误", className: "bg-danger-tint text-danger-deep", icon: AlertTriangle },
    partial: { label: "部分成功", className: "bg-warn-tint text-warn-deep", icon: AlertTriangle },
    completed_with_failures: { label: "部分成功", className: "bg-warn-tint text-warn-deep", icon: AlertTriangle },
    completed: { label: "已完成", className: "bg-success-tint text-success-deep", icon: CheckCircle2 },
    complete: { label: "已完成", className: "bg-success-tint text-success-deep", icon: CheckCircle2 },
    conflict: { label: "提交冲突", className: "bg-danger-tint text-danger-deep", icon: XCircle },
    resume: { label: "模拟恢复", className: "bg-accent-tint text-accent-ink", icon: History },
  };
  const current = meta[status] ?? meta.invalid;
  const Icon = current.icon;
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium", current.className)}><Icon className={cn("size-3", status === "running" && "animate-spin")} />{current.label}</span>;
}

function PlatformLabel({ item }: { item: BatchRunItem }): ReactElement {
  return <span className="inline-flex items-center gap-2"><PlatformMark platform={item.platform} /><span>{item.account}</span></span>;
}

function ProgressSummary({ state, compact = false }: { state: PrototypeState; compact?: boolean }): ReactElement {
  const total = state.items.length;
  const progress = total === 0 ? 0 : Math.round((state.completed / total) * 100);
  return <div className={cn("flex items-center gap-3", compact ? "text-caption" : "text-label")}>
    <div className="h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-surface-sunk"><div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress}%` }} /></div>
    <span className="shrink-0 tabular-nums text-muted">{state.completed}/{total} 成功</span>
  </div>;
}

function RunHeader({ state }: { state: PrototypeState }): ReactElement {
  return <div className="min-w-0"><div className="flex items-center gap-2"><Send className="size-4 text-accent" /><h2 className="truncate text-title font-semibold">批量发布 · 春游与夜市</h2><StatusPill status={state.run.status} /></div><div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted"><span className="font-mono">{state.run.runId}</span><span>{state.items.length} 个发布项</span>{state.run.parentRunId && <span>parent: {state.run.parentRunId}</span>}</div></div>;
}

function RunItemsTable({ state, showActions = true }: { state: PrototypeState; showActions?: boolean }): ReactElement {
  return <div className="overflow-hidden rounded-lg border border-border-soft bg-bg"><table className="w-full text-label"><thead className="bg-surface-warm text-caption text-meta"><tr><th className="px-3 py-2 text-left font-medium">视频</th><th className="px-3 py-2 text-left font-medium">平台 / 账号</th><th className="px-3 py-2 text-left font-medium">排期</th><th className="px-3 py-2 text-left font-medium">结果</th>{showActions && <th className="px-3 py-2 text-right font-medium">操作</th>}</tr></thead><tbody>{state.items.map((item) => <tr key={item.id} className={cn("border-t border-border-soft", item.status === "failure" && "bg-danger-tint/45", item.status === "skipped" && "bg-warn-tint/35")}><td className="max-w-[170px] truncate px-3 py-3 font-medium text-fg"><button type="button" className="inline-flex max-w-full items-center gap-2 text-left" onClick={() => state.setSelectedItem(item.id)}><FileVideo className="size-3.5 shrink-0 text-meta" /><span className="truncate">{item.file}</span></button></td><td className="px-3 py-3 text-fg-2"><PlatformLabel item={item} /></td><td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted">{item.scheduled}</td><td className="px-3 py-3"><div className="flex flex-wrap items-center gap-2"><StatusPill status={item.status} />{item.reason && <button type="button" className="text-caption text-danger-deep underline-offset-2 hover:underline" onClick={() => state.setSelectedItem(item.id)}>{item.reason}</button>}</div></td>{showActions && <td className="px-3 py-3 text-right">{isRetryableItemStatus(item.status) && <Button variant="ghost" size="sm" onClick={() => state.retry([item.id])}><RotateCcw className="size-3.5" />重试</Button>}</td>}</tr>)}</tbody></table></div>;
}

function SelectedItemDetails({ state }: { state: PrototypeState }): ReactElement {
  const item = state.items.find((candidate) => candidate.id === state.selectedItem);
  return <div className="rounded-md border border-border-soft bg-bg p-3 text-caption text-muted">{item ? <><p className="font-medium text-fg-2">{item.file}</p><p className="mt-1">{item.account} · {item.status}</p><p className="mt-1">{item.reason ?? "当前没有错误详情"}</p></> : <p>选择错误摘要可查看对应 synthetic item 详情。</p>}</div>;
}

function DuplicateCheck({ state }: { state: PrototypeState }): ReactElement {
  return <section className="border-t border-border-soft pt-4"><div className="mb-2 flex items-center justify-between gap-3"><div><h3 className="text-label font-semibold">提交前检查</h3><p className="text-caption text-muted">比较阻断与软提示，不连接正式 history</p></div><div className="flex rounded-md border border-border-soft p-0.5 text-caption"><button type="button" className={cn("rounded px-2 py-1", state.checkMode === "block" && "bg-accent-tint text-accent-ink")} onClick={() => state.setCheckMode("block")}>阻断</button><button type="button" className={cn("rounded px-2 py-1", state.checkMode === "soft" && "bg-accent-tint text-accent-ink")} onClick={() => state.setCheckMode("soft")}>软提示</button></div></div><div className="flex flex-col gap-2 text-label"><label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={state.duplicate} onChange={(event) => state.setDuplicate(event.target.checked)} /> 同批内存在重复项</label>{state.duplicate && <div className={cn("rounded-md border px-3 py-2 text-caption", state.checkMode === "block" ? "border-danger bg-danger-tint text-danger-deep" : "border-warn bg-warn-tint text-warn-deep")}>{state.checkMode === "block" ? "提交按钮禁用。" : "发现重复项，但仍可 synthetic 提交。"}</div>}<label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={state.historyWarning} onChange={(event) => state.setHistoryWarning(event.target.checked)} /> 模拟发现历史成功记录</label></div></section>;
}

function ScenarioToolbar({ state }: { state: PrototypeState }): ReactElement {
  const labels: Record<Scenario, string> = { running: "执行中", partial: "部分成功", complete: "全部成功", conflict: "409 冲突", resume: "模拟恢复" };
  return <div className="mt-3 flex flex-wrap items-center gap-2">{(Object.keys(labels) as Scenario[]).map((scenario) => <button type="button" key={scenario} onClick={() => state.applyScenario(scenario)} className={cn("rounded-md border px-2.5 py-1 text-caption", state.scenario === scenario ? "border-accent bg-accent-tint text-accent-ink" : "border-border-soft bg-bg text-muted hover:border-accent")}>{labels[scenario]}</button>)}<span className="ml-auto text-caption text-meta">synthetic 数据 · daemon/account/Tauri 零调用</span></div>;
}

function ConflictBanner({ state }: { state: PrototypeState }): ReactElement | null {
  if (state.scenario !== "conflict") return null;
  return <div className="mb-4 flex items-start gap-3 rounded-lg border border-danger bg-danger-tint px-4 py-3 text-label text-danger-deep"><XCircle className="mt-0.5 size-4 shrink-0" /><div><p className="font-semibold">这次提交没有受理</p><p className="mt-0.5 text-caption">服务端返回 existingRunId=run-099。</p></div><Button variant="ghost" size="sm" className="ml-auto" onClick={state.openConflictRun}><ExternalLink className="size-3.5" />查看 run-099</Button></div>;
}

function RestoreNotice({ state }: { state: PrototypeState }): ReactElement | null {
  if (state.scenario !== "resume") return null;
  return <div className="mb-4 rounded-lg border border-warn bg-warn-tint px-4 py-3 text-label text-warn-deep"><p className="font-semibold">已载入 synthetic interrupted 快照</p><p className="mt-0.5 text-caption">这是模拟恢复，不代表正式持久化能力。</p></div>;
}

function ActionBar({ state }: { state: PrototypeState }): ReactElement {
  return <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4"><Button variant="primary" size="sm" disabled={state.hasBlockingDuplicate} onClick={state.submit}><Send className="size-3.5" />synthetic 提交</Button><Button variant="secondary" size="sm" onClick={() => state.retry()} disabled={state.actionable.length === 0}><RotateCcw className="size-3.5" />重试全部可重试项（{state.actionable.length}）</Button><span className="ml-auto text-caption text-muted">pending / running / success 永不进入 retry</span></div>;
}

function VariantA({ state }: { state: PrototypeState }): ReactElement {
  const [open, setOpen] = useState(true);
  return <div className="relative min-h-[680px] overflow-hidden rounded-xl border border-border-soft bg-surface-sunk p-4"><div className="absolute inset-0 bg-black/15" /><div className="relative mx-auto mt-6 max-w-[820px] rounded-xl border border-border-soft bg-bg shadow-lg">{open ? <div className="p-5"><div className="mb-4 flex items-start justify-between"><RunHeader state={state} /><button type="button" className="rounded-md p-1 text-meta hover:bg-surface" onClick={() => setOpen(false)} aria-label="关闭运行面板"><X className="size-4" /></button></div><ProgressSummary state={state} /><div className="my-4"><ConflictBanner state={state} /><RestoreNotice state={state} /></div><RunItemsTable state={state} /><div className="mt-4"><ActionBar state={state} /></div></div> : <button type="button" className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setOpen(true)}><CircleDot className="size-4 text-accent" /><span className="text-label font-medium">{state.run.runId}</span><ProgressSummary state={state} compact /></button>}</div></div>;
}

function VariantB({ state }: { state: PrototypeState }): ReactElement {
  const [details, setDetails] = useState(true);
  return <div className="min-h-[680px] rounded-xl border border-border-soft bg-bg p-4"><div className="mb-4 flex items-center gap-3 rounded-lg border border-accent/35 bg-accent-tint px-4 py-3"><LoaderCircle className="size-4 animate-spin text-accent" /><div className="min-w-0 flex-1"><RunHeader state={state} /><ProgressSummary state={state} compact /></div><Button variant="secondary" size="sm" onClick={() => setDetails((value) => !value)}><PanelRight className="size-3.5" />{details ? "收起详情" : "查看详情"}</Button></div><ConflictBanner state={state} /><RestoreNotice state={state} /><div className={cn("grid gap-4", details ? "lg:grid-cols-[1fr_280px]" : "grid-cols-1")}><RunItemsTable state={state} />{details && <aside className="rounded-lg border border-border-soft bg-surface-warm p-4"><h3 className="text-label font-semibold">Item 详情</h3><div className="mt-3"><SelectedItemDetails state={state} /></div><div className="mt-5 flex flex-col gap-2"><Button variant="secondary" size="sm" onClick={() => state.retry()} disabled={state.actionable.length === 0}><RotateCcw className="size-3.5" />重试全部可重试项</Button><Button variant="ghost" size="sm" onClick={() => void state.copyRunId()}><Copy className="size-3.5" />复制 runId</Button><Button variant="ghost" size="sm" disabled><History className="size-3.5" />最近运行（静态占位）</Button></div></aside>}</div><div className="mt-4"><DuplicateCheck state={state} /><ActionBar state={state} /></div></div>;
}

function VariantC({ state }: { state: PrototypeState }): ReactElement {
  const [selected, setSelected] = useState<string[]>(() => state.actionable.map((item) => item.id));
  const [showChecks, setShowChecks] = useState(true);
  useEffect(() => {
    setSelected((current) => intersectRetrySelection(current, state.items));
  }, [state.items]);
  const retryableIds = state.actionable.map((item) => item.id);
  const allSelected = retryableIds.length > 0 && retryableIds.every((id) => selected.includes(id));
  return <div className="min-h-[680px] rounded-xl border border-border-soft bg-surface-warm p-5"><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-page font-semibold">批量发布</h2><p className="mt-1 text-label text-muted">Run ledger · synthetic</p></div><div className="flex gap-2"><Button variant="ghost" size="sm" disabled><History className="size-3.5" />运行历史（占位）</Button><Button variant="secondary" size="sm" onClick={() => state.applyScenario(state.scenario)}><RefreshCw className="size-3.5" />刷新模拟</Button></div></div><ConflictBanner state={state} /><RestoreNotice state={state} /><div className="mb-3 flex items-center justify-between"><div><h3 className="text-title font-semibold">逐项结果</h3><p className="text-caption text-muted">仅 failure / skipped / interrupted 有选择框。</p></div><Button variant="ghost" size="sm" onClick={() => setShowChecks((value) => !value)}>{showChecks ? "收起提交前检查" : "展开提交前检查"}<ChevronDown className="size-3.5" /></Button></div><div className="overflow-hidden rounded-lg border border-border-soft bg-bg"><table className="w-full text-label"><thead className="bg-surface text-caption text-meta"><tr><th className="w-10 px-3 py-2"><input aria-label="全选可重试项" type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? retryableIds : [])} /></th><th className="px-3 py-2 text-left font-medium">发布项</th><th className="px-3 py-2 text-left font-medium">状态</th><th className="px-3 py-2 text-right font-medium">单项操作</th></tr></thead><tbody>{state.items.map((item) => <tr key={item.id} className="border-t border-border-soft"><td className="px-3 py-3">{isRetryableItemStatus(item.status) && <input aria-label={`选择重试 ${item.file}`} type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />}</td><td className="px-3 py-3"><button type="button" className="font-medium" onClick={() => state.setSelectedItem(item.id)}>{item.file}</button><div className="mt-1 text-caption text-muted"><PlatformLabel item={item} /></div></td><td className="px-3 py-3"><StatusPill status={item.status} />{item.reason && <button type="button" className="ml-2 text-caption text-danger-deep" onClick={() => state.setSelectedItem(item.id)}>{item.reason}</button>}</td><td className="px-3 py-3 text-right">{isRetryableItemStatus(item.status) && <Button variant="ghost" size="sm" onClick={() => state.retry([item.id])}><RotateCcw className="size-3.5" />重试</Button>}</td></tr>)}</tbody></table></div><div className="mt-4"><SelectedItemDetails state={state} /></div>{showChecks && <div className="mt-5"><DuplicateCheck state={state} /></div>}<div className="sticky bottom-0 mt-5 flex flex-wrap items-center gap-3 border-t border-border-soft bg-surface-warm pt-4"><Button variant="secondary" size="sm" disabled={selected.length === 0} onClick={() => state.retry(selected)}><RotateCcw className="size-3.5" />重试已选（{selected.length}）</Button><Button variant="primary" size="sm" disabled={state.hasBlockingDuplicate} onClick={state.submit}><Send className="size-3.5" />synthetic 提交</Button></div></div>;
}

function PrototypeSwitcher({ current, onChange }: { current: VariantKey; onChange: (key: VariantKey) => void }): ReactElement {
  const index = VARIANTS.findIndex((item) => item.key === current);
  const previous = VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length];
  const next = VARIANTS[(index + 1) % VARIANTS.length];
  return <div className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-fg bg-fg px-2 py-1.5 text-white shadow-lg"><button type="button" className="grid size-7 place-items-center rounded-full text-white/75 hover:bg-white/15" onClick={() => onChange(previous.key)} aria-label={`上一个方案：${previous.name}`}><ChevronRight className="size-4 rotate-180" /></button><button type="button" className="min-w-[250px] rounded-full px-3 py-1 text-center hover:bg-white/10" onClick={() => onChange(next.key)}><span className="text-label font-semibold">{current} · {VARIANTS[index].name}</span><span className="ml-2 text-caption text-white/65">{VARIANTS[index].summary}</span></button><button type="button" className="grid size-7 place-items-center rounded-full text-white/75 hover:bg-white/15" onClick={() => onChange(next.key)} aria-label={`下一个方案：${next.name}`}><ChevronRight className="size-4" /></button></div>;
}

export function BatchRunUiPrototype({ onExit }: { onExit: () => void }): ReactElement {
  const [variant, setVariant] = useVariant();
  const state = usePrototypeState();
  const meta = VARIANTS.find((item) => item.key === variant)!;
  useEffect(() => {
    if (!state.toast) return;
    const timer = window.setTimeout(() => state.setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [state.toast]);

  return <div className="min-h-full bg-bg px-6 pb-24 pt-8 lg:px-10"><div className="mx-auto max-w-[1120px]"><div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><div className="mb-2 flex items-center gap-2"><span className="rounded bg-warn-tint px-2 py-1 text-caption font-semibold text-warn-deep">PROTOTYPE · throwaway</span><span className="text-caption text-meta">/ 发布 / 批量 run</span></div><h1 className="text-page font-semibold">批量发布结果工作台</h1><p className="mt-2 max-w-[760px] text-body text-muted">验证 retry、409、终态单调性、错误清理和模拟恢复。所有行为均为 synthetic。</p></div><Button variant="ghost" size="sm" onClick={onExit}>退出原型</Button></div><div className="mb-4 rounded-lg border border-border-soft bg-surface-warm px-4 py-3 text-label text-fg-2"><span className="font-semibold">当前方案：{meta.name}</span><span className="ml-3 text-caption text-muted">{meta.summary}</span></div><div className="mb-5 rounded-lg border border-warn bg-warn-tint px-4 py-3 text-warn-deep"><div className="flex items-center gap-2"><AlertTriangle className="size-4" /><span className="text-label font-semibold">原型控制台</span><span className="text-caption">所有 run、历史、恢复均为模拟。</span></div><ScenarioToolbar state={state} /></div>{variant === "A" && <VariantA state={state} />}{variant === "B" && <VariantB state={state} />}{variant === "C" && <VariantC state={state} />}</div>{state.toast && <div role="status" className="fixed bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-fg px-4 py-3 text-label text-white shadow-lg"><Check className="size-4 text-success" />{state.toast}</div>}<PrototypeSwitcher current={variant} onChange={setVariant} /></div>;
}
