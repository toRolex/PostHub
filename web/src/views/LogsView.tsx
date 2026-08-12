import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, ScrollText } from "lucide-react";
import { useLogsStore, type LogFilters } from "../stores/logs";
import { useDaemonStore } from "../stores/daemon";
import type { LogLevel } from "../api/types";
import { isTauri } from "../lib/isTauri";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";

const LEVEL_META: Record<LogLevel, string> = {
  debug: "text-muted",
  info: "text-fg-2",
  warn: "text-warn-deep",
  error: "text-danger-deep",
};

const LEVEL_OPTIONS: { value: LogLevel | ""; label: string }[] = [
  { value: "", label: "全部级别" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

function DaemonSettings() {
  const connected = useDaemonStore((s) => s.connected);
  const url = useDaemonStore((s) => s.url);
  const [autostart, setAutostart] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    invoke<boolean>("get_autostart")
      .then(setAutostart)
      .catch(() => undefined);
  }, []);

  async function toggle(on: boolean): Promise<void> {
    if (!isTauri()) return;
    setAutostartLoading(true);
    try {
      await invoke("set_autostart", { enabled: on });
      setAutostart(on);
    } catch {
      setAutostart(!on);
    } finally {
      setAutostartLoading(false);
    }
  }

  return (
    <section className="mt-8 rounded-lg border border-border-soft bg-bg p-4">
      <h3 className="text-title font-semibold tracking-[-0.01em]">守护进程</h3>
      <div className="mt-3 flex items-center gap-3">
        <Switch
          checked={autostart}
          disabled={!isTauri() || autostartLoading}
          onCheckedChange={(on) => void toggle(on)}
        />
        <div>
          <p className="text-body font-medium text-fg">开机自启</p>
          <p className="text-caption text-meta">
            随系统启动常驻（托盘 / 菜单栏）。仅桌面应用环境可用。
          </p>
        </div>
      </div>
      <p className="mt-3 text-caption text-meta">
        健康接口{" "}
        <code className="font-mono tabular-nums">{url}/health</code>
        {connected ? "" : " · 未连接"}
      </p>
    </section>
  );
}

export function LogsView() {
  const logs = useLogsStore((s) => s.logs);
  const loading = useLogsStore((s) => s.loading);
  const filters = useLogsStore((s) => s.filters);
  const fetchLogs = useLogsStore((s) => s.fetchLogs);
  const setFilters = useLogsStore((s) => s.setFilters);
  const [taskIdInput, setTaskIdInput] = useState(
    filters.task_id ? String(filters.task_id) : "",
  );

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  function applyTaskId(): void {
    const value = taskIdInput.trim();
    setFilters({ task_id: value ? Number(value) : "" });
  }

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-page font-semibold tracking-[-0.015em]">日志</h2>
        <span className="text-label text-muted">守护进程运行日志</span>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={filters.level}
            onValueChange={(v) =>
              setFilters({ level: v as LogFilters["level"] })
            }
          >
            <SelectTrigger className="h-8 w-[120px] text-label" aria-label="日志级别">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map((o) => (
                <SelectItem key={o.value || "all"} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-8 w-[120px] text-label"
            placeholder="任务 ID"
            inputMode="numeric"
            value={taskIdInput}
            onChange={(e) => setTaskIdInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyTaskId();
            }}
            onBlur={applyTaskId}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void fetchLogs()}
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </div>

      {loading && logs.length === 0 ? (
        <Skeleton rows={5} />
      ) : logs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft">
          <Empty
            icon={<ScrollText className="size-[34px] text-meta" strokeWidth={1.5} />}
            title="暂无日志"
            description="守护进程运行后这里会显示健康检查、调度与发布记录"
          />
        </div>
      ) : (
        <div className="min-h-[320px] rounded-lg border border-border-soft bg-surface-sunk p-4 font-mono text-caption leading-[1.7] text-fg-2">
          {logs.map((l) => (
            <div key={l.id} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-meta">
                {l.created_at.slice(11, 19)}
              </span>
              <span className={cn("shrink-0", LEVEL_META[l.level])}>
                [{l.source}]
              </span>
              <span className="min-w-0 break-words">{l.message}</span>
            </div>
          ))}
        </div>
      )}

      <DaemonSettings />
    </div>
  );
}
