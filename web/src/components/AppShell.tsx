import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FilePlus2, Send, Settings, Timer, User } from "lucide-react";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { useRunStore } from "../stores/runs";
import type { RunStatus, RunSummary } from "../api/official";
import { useViewStore, type View } from "../stores/view";
import { isTauri } from "../lib/isTauri";
import { cn } from "../lib/utils";
import { Status } from "./ui/status";
import { ToastHost } from "./ui/toast";
import { AccountsView } from "../views/AccountsView";
import { FileView } from "../views/FileView";
import { PublishView } from "../views/PublishView";
import { ScheduleView } from "../views/ScheduleView";
import { SettingsView } from "../views/SettingsView";

const NAV_ITEMS: { view: View; label: string; icon: typeof Send }[] = [
  { view: "publish", label: "发布", icon: Send },
  { view: "files", label: "文件", icon: FilePlus2 },
  { view: "accounts", label: "账号", icon: User },
  { view: "schedule", label: "定时", icon: Timer },
  { view: "settings", label: "设置", icon: Settings },
];

async function loadDaemonUrl(): Promise<string> {
  const current = useDaemonStore.getState().url;
  if (!isTauri()) return current;
  try {
    const url = await invoke<string>("get_daemon_url");
    useDaemonStore.setState({ url });
    return url;
  } catch {
    // 非 Tauri 环境或命令不可用时使用默认地址
    return current;
  }
}

export const RUN_POLL_INITIAL_MS = 2_000;
export const RUN_POLL_MAX_MS = 10_000;

export function shouldRefreshRun(status: RunStatus | null): boolean {
  return status !== "completed" && status !== "completed_with_failures";
}

export function nextRunPollDelay(previousMs: number, changed: boolean): number {
  return changed
    ? RUN_POLL_INITIAL_MS
    : Math.min(RUN_POLL_MAX_MS, Math.max(RUN_POLL_INITIAL_MS, previousMs * 2));
}

export function runProgressLabel(
  summary: RunSummary | null,
  acceptedItemCount: number | null,
): string | null {
  if (summary) return `完成 ${summary.completedCount}/${summary.itemCount}`;
  if (acceptedItemCount !== null) return `完成 0/${acceptedItemCount}`;
  return null;
}

export function runStatusMeta(status: RunStatus | null) {
  if (status === "pending") {
    return { dot: "bg-meta", text: "text-fg-2", label: "最近运行 待执行" };
  }
  if (status === "running") {
    return {
      dot: "bg-accent",
      text: "text-accent-ink",
      label: "最近运行 执行中",
      pulse: true,
    };
  }
  if (status === "completed_with_failures") {
    return { dot: "bg-warn", text: "text-warn-deep", label: "最近运行 部分成功" };
  }
  if (status === "completed") {
    return { dot: "bg-success", text: "text-success-deep", label: "最近运行 已完成" };
  }
  return null;
}

function Topbar() {
  const connected = useDaemonStore((s) => s.connected);
  const runStatus = useRunStore((s) => s.status);
  const runId = useRunStore((s) => s.runId);
  const runSummary = useRunStore((s) => s.summary);
  const acceptedItemCount = useRunStore((s) => s.itemCount);
  const daemonMeta = connected
    ? { dot: "bg-success", text: "text-success-deep", label: "守护进程 已连通" }
    : { dot: "bg-danger", text: "text-danger-deep", label: "守护进程 未连接" };
  const runMeta = runStatusMeta(runStatus);
  const progress = runProgressLabel(runSummary, acceptedItemCount);
  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b border-border-soft bg-bg px-4">
      <Status meta={daemonMeta} />
      {runMeta && (
        <Status
          meta={{
            ...runMeta,
            label: progress ? `${runMeta.label} · ${progress}` : runMeta.label,
          }}
        />
      )}
      {runId && <span className="ml-auto font-mono text-caption text-meta">run {runId.slice(0, 8)}</span>}
    </header>
  );
}

function NavButton({
  view,
  active,
  onClick,
}: {
  view: View;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = NAV_ICONS[view];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left text-label font-medium transition-colors duration-150 ease-out",
        active
          ? "bg-accent-tint text-accent-ink"
          : "text-fg-2 hover:bg-surface hover:text-fg",
      )}
    >
      <Icon className="size-4 opacity-85" />
      {viewLabel(view)}
    </button>
  );
}

const NAV_ICONS: Record<View, typeof Send> = {
  publish: Send,
  files: FilePlus2,
  accounts: User,
  schedule: Timer,
  settings: Settings,
};

function viewLabel(view: View): string {
  return { publish: "发布", files: "文件", accounts: "账号", schedule: "定时", settings: "设置" }[view];
}

function Sidebar() {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  return (
    <aside className="flex min-h-0 flex-col gap-2 border-r border-border-soft bg-surface-warm px-3 py-4">
      <div className="mb-2 flex items-center gap-2 border-b border-border-soft px-2 pb-4">
        <span className="grid size-[26px] place-items-center rounded-[7px] bg-accent text-white">
          <Send className="size-[15px]" />
        </span>
        <span className="text-emph font-semibold tracking-[-0.01em]">PostHub</span>
      </div>
      <nav className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.view}
            view={item.view}
            active={view === item.view}
            onClick={() => setView(item.view)}
          />
        ))}
      </nav>
    </aside>
  );
}

function ShellView() {
  const view = useViewStore((s) => s.view);
  switch (view) {
    case "publish":
      return <PublishView />;
    case "files":
      return <FileView />;
    case "accounts":
      return <AccountsView />;
    case "schedule":
      return <ScheduleView />;
    case "settings":
      return <SettingsView />;
  }
}

export function AppShell() {
  useEffect(() => {
    let disposed = false;
    let runPollTimer: number | undefined;
    let runPollDelay = RUN_POLL_INITIAL_MS;

    const runFingerprint = (): string => {
      const state = useRunStore.getState();
      return JSON.stringify({
        runId: state.runId,
        status: state.status,
        snapshot: state.snapshot
          ? {
              updatedAt: state.snapshot.updatedAt,
              summary: state.snapshot.summary,
              items: state.snapshot.items.map((item) => ({
                seq: item.seq,
                status: item.status,
                errorSummary: item.errorSummary ?? item.error,
              })),
            }
          : null,
      });
    };

    const scheduleRunPoll = (delay: number): void => {
      if (disposed) return;
      runPollTimer = window.setTimeout(async () => {
        if (disposed || !shouldRefreshRun(useRunStore.getState().status)) return;
        const before = runFingerprint();
        // refresh 在网络异常时保留原快照；因此比较前后快照即可决定退避，
        // 网络错误不会停止后续重试，也不会清空用户已经看到的状态。
        await useRunStore.getState().refresh(useDaemonStore.getState().url);
        if (disposed || !shouldRefreshRun(useRunStore.getState().status)) return;
        const changed = before !== runFingerprint();
        runPollDelay = nextRunPollDelay(runPollDelay, changed);
        scheduleRunPoll(runPollDelay);
      }, delay);
    };

    void (async () => {
      const url = await loadDaemonUrl();
      if (disposed) return;
      void useAccountsStore.getState().fetchAccounts();
      void useDaemonStore.getState().probeDaemon();
      void useRunStore.getState().restoreLatestRun(url);
      scheduleRunPoll(RUN_POLL_INITIAL_MS);
    })();
    const { pollIntervalMs } = useDaemonStore.getState();
    const healthTimer = window.setInterval(
      () => void useDaemonStore.getState().probeDaemon(),
      pollIntervalMs,
    );
    return () => {
      disposed = true;
      window.clearInterval(healthTimer);
      if (runPollTimer !== undefined) window.clearTimeout(runPollTimer);
    };
  }, []);

  return (
    <div className="grid h-screen grid-rows-[auto_1fr] overflow-hidden bg-bg text-fg">
      <Topbar />
      <div className="grid min-h-0 grid-cols-[216px_1fr]">
        <Sidebar />
        <main className="min-h-0 overflow-y-auto">
          <ShellView />
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
