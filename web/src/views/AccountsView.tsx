import { useEffect, useState } from "react";
import { Plus, UserPlus } from "lucide-react";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { useToastStore } from "../stores/toast";
import { PLATFORM_NAMES } from "../api/platformNames";
import type { Account, Platform } from "../api/types";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import { Empty } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PlatformMark } from "../components/ui/platform-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { ACCOUNT_STATUS_META, Status } from "../components/ui/status";
import { CookieManager } from "../components/CookieManager";

const PLATFORMS: Platform[] = ["douyin", "xiaohongshu", "wechat"];

function AddAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createAccount = useAccountsStore((s) => s.createAccount);
  const [platform, setPlatform] = useState<Platform>("douyin");
  const [name, setName] = useState("");
  const [warning, setWarning] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setPlatform("douyin");
      setName("");
      setWarning("");
    }
  }, [open]);

  async function handleSubmit(): Promise<void> {
    setCreating(true);
    try {
      const account = await createAccount({
        platform,
        name: name.trim() || undefined,
      });
      if (account.launch_warning) {
        setWarning(account.launch_warning);
      } else {
        useToastStore.getState().show(
          "账号已添加，Chrome 已拉起等待扫码登录",
          "info",
        );
        onOpenChange(false);
      }
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>添加账号</DialogTitle>
        <DialogDescription className="text-label text-muted">
          添加后守护进程将拉起该平台独立 Chrome，请在新窗口完成扫码登录。
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-platform">平台</Label>
            <Select
              value={platform}
              onValueChange={(v) => setPlatform(v as Platform)}
            >
              <SelectTrigger id="account-platform" aria-label="平台">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PLATFORM_NAMES[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-name">名称</Label>
            <Input
              id="account-name"
              value={name}
              placeholder="例如：主号 / 备用号（可选）"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {warning && (
            <p className="rounded-md bg-warn-tint px-3 py-2 text-label text-warn-deep">
              {warning}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={creating} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" disabled={creating} onClick={() => void handleSubmit()}>
            {creating ? "添加中…" : "添加并拉起 Chrome"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAccountDialog({
  account,
  onClose,
}: {
  account: Account | null;
  onClose: () => void;
}) {
  const removeAccount = useAccountsStore((s) => s.removeAccount);
  const [removing, setRemoving] = useState(false);

  async function handleDelete(): Promise<void> {
    if (!account) return;
    setRemoving(true);
    try {
      await removeAccount(account.id);
      useToastStore.getState().show("账号已删除", "ok");
      onClose();
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Dialog open={account !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>删除账号</DialogTitle>
        <DialogDescription className="text-label text-muted">
          将删除「{account?.name}」({account ? PLATFORM_NAMES[account.platform] : ""})
          及其关联任务记录。此操作不可撤销。
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" disabled={removing} onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" disabled={removing} onClick={() => void handleDelete()}>
            {removing ? "删除中…" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AccountsView() {
  const accounts = useAccountsStore((s) => s.accounts);
  const loading = useAccountsStore((s) => s.loading);
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts);
  const relogin = useAccountsStore((s) => s.relogin);
  const setStatus = useAccountsStore((s) => s.setStatus);
  const connected = useDaemonStore((s) => s.connected);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);

  useEffect(() => {
    if (connected) void fetchAccounts();
  }, [connected, fetchAccounts]);

  async function handleRelogin(a: Account): Promise<void> {
    try {
      const r = await relogin(a.id);
      useToastStore.getState().show(
        r.launch_warning ?? "已拉起该账号 Chrome，请完成扫码登录",
        "info",
      );
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    }
  }

  async function handleRestore(a: Account): Promise<void> {
    try {
      await setStatus(a.id, "active");
      useToastStore.getState().show("账号已恢复可用", "ok");
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    }
  }

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <div className="mb-6 flex items-baseline gap-3">
        <h2 className="text-page font-semibold tracking-[-0.015em]">账号</h2>
        <span className="text-label text-muted">多平台账号与调试端口</span>
        <div className="ml-auto">
          <Button
            variant="primary"
            disabled={!connected}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-4" />
            添加账号
          </Button>
        </div>
      </div>

      {loading && accounts.length === 0 ? (
        <Skeleton rows={4} />
      ) : accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft">
          <Empty
            icon={<UserPlus className="size-[34px] text-meta" strokeWidth={1.5} />}
            title="还没有账号"
            description="添加平台账号后，PostHub 会拉起独立 Chrome 供扫码登录，登录态自动持久化"
          />
          <div className="flex justify-center pb-6">
            <Button
              variant="primary"
              disabled={!connected}
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="size-4" />
              添加第一个账号
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-soft bg-bg">
          <table className="w-full border-collapse text-label">
            <thead>
              <tr className="border-b border-border bg-surface-warm">
                <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                  平台
                </th>
                <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                  名称
                </th>
                <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                  调试端口
                </th>
                <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                  状态
                </th>
                <th className="px-4 py-2.5 text-right text-caption font-medium text-meta">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-border-soft last:border-b-0 hover:bg-surface-warm">
                  <td className="px-4 py-3">
                    <PlatformMark platform={a.platform} />
                  </td>
                  <td className="px-4 py-3 font-medium text-fg">{a.name}</td>
                  <td className="px-4 py-3 font-mono text-caption tabular-nums text-muted">
                    {a.cdp_port}
                  </td>
                  <td className="px-4 py-3">
                    <Status meta={ACCOUNT_STATUS_META[a.status]} />
                  </td>
                  <td className={cn("px-4 py-3 text-right")}>
                    {a.status === "needs_relogin" ? (
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" size="sm" onClick={() => void handleRelogin(a)}>
                          重新扫码
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void handleRestore(a)}>
                          恢复可用
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:bg-danger-tint"
                        onClick={() => setDeleteTarget(a)}
                      >
                        删除
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddAccountDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <DeleteAccountDialog
        account={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />

      <CookieManager />
    </div>
  );
}
