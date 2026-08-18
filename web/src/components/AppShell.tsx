import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FilePlus2, Send, Timer, User } from "lucide-react";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { useViewStore, type View } from "../stores/view";
import { isTauri } from "../lib/isTauri";
import { cn } from "../lib/utils";
import { Status } from "./ui/status";
import { ToastHost } from "./ui/toast";
import { AccountsView } from "../views/AccountsView";
import { FileView } from "../views/FileView";
import { PublishView } from "../views/PublishView";
import { ScheduleView } from "../views/ScheduleView";

const NAV_ITEMS: { view: View; label: string; icon: typeof Send }[] = [
  { view: "publish", label: "发布", icon: Send },
  { view: "files", label: "文件", icon: FilePlus2 },
  { view: "accounts", label: "账号", icon: User },
  { view: "schedule", label: "定时", icon: Timer },
];

async function loadDaemonUrl(): Promise<void> {
  if (!isTauri()) return;
  try {
    const url = await invoke<string>("get_daemon_url");
    useDaemonStore.setState({ url });
  } catch {
    // 非 Tauri 环境或命令不可用时使用默认地址
  }
}

function Topbar() {
  const connected = useDaemonStore((s) => s.connected);
  const meta = connected
    ? { dot: "bg-success", text: "text-success-deep", label: "守护进程 已连通" }
    : { dot: "bg-danger", text: "text-danger-deep", label: "守护进程 未连接" };
  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b border-border-soft bg-bg px-4">
      <Status meta={meta} />
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
};

function viewLabel(view: View): string {
  return { publish: "发布", files: "文件", accounts: "账号", schedule: "定时" }[view];
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
  }
}

export function AppShell() {
  useEffect(() => {
    void loadDaemonUrl();
    void useAccountsStore.getState().fetchAccounts();
    void useDaemonStore.getState().checkHealth();
    const { pollIntervalMs } = useDaemonStore.getState();
    const healthTimer = window.setInterval(
      () => void useDaemonStore.getState().checkHealth(),
      pollIntervalMs,
    );
    return () => {
      window.clearInterval(healthTimer);
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
