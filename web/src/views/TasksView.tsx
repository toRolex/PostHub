import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTasksStore, type TaskFilters } from "../stores/tasks";
import { useDaemonStore } from "../stores/daemon";
import { useToastStore } from "../stores/toast";
import { useViewStore } from "../stores/view";
import type { JobStatus, PlatformJob, TaskItem, TaskStatus } from "../api/types";
import {
  decideNotification,
  notifyLocal,
  requestNotifyPermission,
} from "../lib/notify";
import { formatRelative } from "../lib/format";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Chip } from "../components/ui/chip";
import { Empty } from "../components/ui/empty";
import { PlatformMark } from "../components/ui/platform-mark";
import { Skeleton } from "../components/ui/skeleton";
import { JOB_STATUS_META, Status, TASK_STATUS_META } from "../components/ui/status";
import { ClipboardList } from "lucide-react";

const FILTER_KEYS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待发布" },
  { key: "publishing", label: "发布中" },
  { key: "success", label: "成功" },
  { key: "failed", label: "失败" },
  { key: "manual", label: "需人工" },
  { key: "needs_relogin", label: "需重登" },
  { key: "missed", label: "错过" },
];

const RETRYABLE = new Set<JobStatus>(["failed", "manual", "needs_relogin"]);

function taskKey(t: TaskStatus): string {
  return t;
}

function jobMessage(j: PlatformJob): string {
  if (j.last_error) return j.last_error;
  switch (j.status) {
    case "pending":
      return "排队等待 · 同平台串行";
    case "publishing":
      return "进行中";
    case "success":
      return "发布成功";
    default:
      return "—";
  }
}

/* ───────────────────────── 筛选 chips ───────────────────────── */

function FilterChips() {
  const tasks = useTasksStore((s) => s.tasks);
  const filters = useTasksStore((s) => s.filters);
  const fetchTasks = useTasksStore((s) => s.fetchTasks);

  function countFor(key: string): number {
    if (key === "all") return tasks.length;
    return tasks.filter(({ task }) => taskKey(task.status) === key).length;
  }

  function apply(key: string): void {
    const partial: TaskFilters =
      key === "all" ? { status: "" } : { status: key as TaskStatus };
    void fetchTasks({ ...filters, ...partial });
  }

  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {FILTER_KEYS.map(({ key, label }) => {
        const active = key === "all" ? !filters.status : filters.status === key;
        return (
          <Chip key={key} active={active} count={countFor(key)} onClick={() => apply(key)}>
            {label}
          </Chip>
        );
      })}
    </div>
  );
}

/* ───────────────────────── 任务行 / 明细 ───────────────────────── */

function JobDetail({
  item,
  onRetry,
}: {
  item: TaskItem;
  onRetry: (jobId: number) => void;
}) {
  const cancelTask = useTasksStore((s) => s.cancelTask);
  const actionLoading = useTasksStore((s) => s.actionLoading);
  const canCancel = item.jobs.some((j) => j.status === "pending");

  async function handleCancel(): Promise<void> {
    try {
      await cancelTask(item.task.id);
      useToastStore.getState().show("任务已取消", "ok");
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    }
  }

  return (
    <div className="border-b border-border-soft bg-bg px-4 pb-4 pl-[52px]">
      <table className="w-full border-collapse text-label">
        <thead>
          <tr>
            <th className="w-[110px] pb-2 text-left text-caption font-medium text-meta">
              平台
            </th>
            <th className="w-[88px] pb-2 text-left text-caption font-medium text-meta">
              状态
            </th>
            <th className="pb-2 text-left text-caption font-medium text-meta">
              信息
            </th>
            <th className="w-[88px] pb-2 text-left text-caption font-medium text-meta">
              时间
            </th>
            <th className="w-[64px] pb-2 text-right text-caption font-medium text-meta">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {item.jobs.map((j) => (
            <tr key={j.id}>
              <td className="border-b border-border-soft py-2">
                <PlatformMark platform={j.platform} />
              </td>
              <td className="border-b border-border-soft py-2">
                <Status meta={JOB_STATUS_META[j.status]} />
              </td>
              <td
                className={cn(
                  "border-b border-border-soft py-2 text-caption",
                  j.last_error ? "text-danger-deep" : "text-muted",
                )}
              >
                {jobMessage(j)}
              </td>
              <td className="border-b border-border-soft py-2 text-caption tabular-nums text-meta">
                {formatRelative(j.finished_at ?? j.started_at ?? j.created_at)}
              </td>
              <td className="border-b border-border-soft py-2 text-right">
                {RETRYABLE.has(j.status) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={actionLoading}
                    onClick={() => onRetry(j.id)}
                  >
                    重试
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canCancel && (
        <div className="mt-3 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={actionLoading}
            onClick={() => void handleCancel()}
          >
            取消任务
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskRow({
  item,
  expanded,
  onToggle,
  onRetry,
}: {
  item: TaskItem;
  expanded: boolean;
  onToggle: () => void;
  onRetry: (jobId: number) => void;
}) {
  const { task } = item;
  const isAlert = task.status === "manual" || task.status === "needs_relogin";
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        className={cn(
          "grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 border-b border-border-soft px-4 py-3 transition-colors duration-150 ease-out",
          isAlert
            ? "bg-warn-tint"
            : "hover:bg-surface-warm",
          expanded && "bg-surface",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isAlert && (
              <span className="rounded-sm bg-warn px-1.5 py-0.5 text-caption font-medium leading-4 text-white">
                需处理
              </span>
            )}
            <span className="truncate text-body font-semibold text-fg">
              {task.title}
            </span>
          </div>
          <div className="mt-1 flex gap-3">
            {item.jobs.map((j) => (
              <PlatformMark key={j.id} platform={j.platform} />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Status meta={TASK_STATUS_META[task.status]} />
          <span className="text-caption tabular-nums text-meta">
            {formatRelative(task.created_at)}
          </span>
        </div>
      </div>
      {expanded && <JobDetail item={item} onRetry={onRetry} />}
    </>
  );
}

/* ───────────────────────── 任务视图 ───────────────────────── */

export function TasksView() {
  const tasks = useTasksStore((s) => s.tasks);
  const loading = useTasksStore((s) => s.loading);
  const fetchTasks = useTasksStore((s) => s.fetchTasks);
  const retryJob = useTasksStore((s) => s.retryJob);
  const setView = useViewStore((s) => s.setView);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const prevStatusRef = useRef<Map<number, TaskStatus>>(new Map());
  const pollIntervalMs = useDaemonStore((s) => s.pollIntervalMs);

  useEffect(() => {
    void requestNotifyPermission();
    void fetchTasks();
    const timer = window.setInterval(() => void pollTasks(), pollIntervalMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollIntervalMs]);

  async function pollTasks(): Promise<void> {
    const prev = new Map(prevStatusRef.current);
    await fetchTasks();
    for (const { task } of useTasksStore.getState().tasks) {
      const decision = decideNotification(
        prev.get(task.id) ?? null,
        task.status,
        task.title,
      );
      if (decision.shouldNotify) notifyLocal(decision);
    }
    prevStatusRef.current = new Map(
      useTasksStore.getState().tasks.map(({ task }) => [task.id, task.status]),
    );
  }

  async function handleRetry(jobId: number): Promise<void> {
    try {
      await retryJob(jobId);
      useToastStore.getState().show("已重新排队", "ok");
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    }
  }

  const total = tasks.length;

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <div className="mb-6 flex items-baseline gap-3">
        <h2 className="text-page font-semibold tracking-[-0.015em]">任务</h2>
        <span className="text-label text-muted">
          {total > 0 ? `共 ${total} 个任务` : "发布后到这里看状态"}
        </span>
      </div>
      <FilterChips />
      {loading && tasks.length === 0 ? (
        <Skeleton rows={4} />
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft">
          <Empty
            icon={<ClipboardList className="size-[34px] text-meta" strokeWidth={1.5} />}
            title="还没有任务"
            description="到「发布」区选素材、勾账号，发布后这里会列出每个平台的结果"
          />
          <div className="flex justify-center pb-6">
            <Button variant="secondary" onClick={() => setView("publish")}>
              去发布
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border-soft bg-bg">
          {tasks.map((item) => (
            <TaskRow
              key={item.task.id}
              item={item}
              expanded={expandedId === item.task.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === item.task.id ? null : item.task.id))
              }
              onRetry={(jobId) => void handleRetry(jobId)}
            />
          ))}
          <div className="flex justify-end px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => void fetchTasks()}
            >
              <RefreshCw className="size-4" />
              刷新
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
