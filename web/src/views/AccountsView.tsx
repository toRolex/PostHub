import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  PencilLine,
  Plus,
  ScanLine,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useAccountsStore } from "../stores/accounts";
import { useDaemonStore } from "../stores/daemon";
import { useToastStore } from "../stores/toast";
import { PLATFORM_NAMES } from "../api/platformNames";
import { openLoginSse, type LoginSseHandle } from "../api/official";
import { OFFICIAL_PLATFORM_TYPE } from "../api/types";
import type { OfficialAccount, Platform } from "../api/types";
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
import { CookieManager } from "../components/CookieManager";

const PLATFORMS: Platform[] = ["douyin", "xiaohongshu", "wechat", "kuaishou"];

function ErrorHint({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="rounded-md bg-danger-tint px-3 py-2 text-label text-danger-deep">
      {message}
    </p>
  );
}

function ScanLoginDialog({
  open,
  onOpenChange,
  onLoginSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoginSuccess: () => void;
}) {
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts);
  const baseUrl = useDaemonStore((s) => s.url);
  const [platform, setPlatform] = useState<Platform>("douyin");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"form" | "scanning" | "success" | "failed">("form");
  const [qrSrc, setQrSrc] = useState("");
  const [error, setError] = useState("");
  const handleRef = useRef<LoginSseHandle | null>(null);

  useEffect(() => {
    if (open) {
      setPlatform("douyin");
      setName("");
      setError("");
      setQrSrc("");
      setPhase("form");
    } else {
      handleRef.current?.abort();
      handleRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function startScan(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请填写账号名（用于区分不同账号）");
      return;
    }
    setPhase("scanning");
    setError("");
    setQrSrc("");
    try {
      const handle = await openLoginSse({
        url: baseUrl,
        type: OFFICIAL_PLATFORM_TYPE[platform],
        accountName: trimmed,
      });
      handleRef.current = handle;
      const qr = await handle.readQr;
      setQrSrc(qr.src);
      const ok = await handle.readResult;
      if (ok) {
        setPhase("success");
        await fetchAccounts();
        onLoginSuccess();
        // 成功停留片刻展示反馈，随后自动关闭。
        window.setTimeout(() => onOpenChange(false), 900);
      } else {
        setPhase("failed");
        setError("登录失败或超时，请重试");
      }
    } catch (e) {
      setPhase("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const running = phase === "scanning";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="w-[min(480px,92vw)]">
        <DialogTitle>扫码登录账号</DialogTitle>
        <DialogDescription className="text-label text-muted">
          通过官方后端 /login 拉起扫码会话，登录成功后登录态自动写入 cookie 文件。
        </DialogDescription>

        {phase === "form" && (
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="scan-platform">平台</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger id="scan-platform" aria-label="平台">
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
              <Label htmlFor="scan-name">账号名</Label>
              <Input
                id="scan-name"
                value={name}
                placeholder="例如：主号 / 备用号（用于区分账号）"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <ErrorHint message={error} />
          </div>
        )}

        {(phase === "scanning" || phase === "success") && (
          <div className="mt-4 flex flex-col items-center gap-3">
            {qrSrc ? (
              <img
                src={qrSrc}
                alt="扫码登录二维码"
                className="h-56 w-56 rounded-md border border-border object-contain bg-bg"
              />
            ) : (
              <div className="grid h-56 w-56 place-items-center rounded-md border border-border bg-surface">
                <Loader2 className="size-6 animate-spin text-meta" />
              </div>
            )}
            <p className="text-label text-muted">
              {phase === "success"
                ? "登录成功，正在刷新账号列表…"
                : "请用「目标平台 App」扫码完成登录，本窗口会自动更新…"}
            </p>
            {error && <ErrorHint message={error} />}
          </div>
        )}

        {phase === "failed" && (
          <div className="mt-4 flex flex-col gap-2">
            <ErrorHint message={error} />
            <p className="text-label text-muted">
              未能完成扫码登录。可再次发起登录。
            </p>
          </div>
        )}

        <DialogFooter>
          {phase === "form" && (
            <>
              <Button variant="ghost" disabled={running} onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button variant="primary" disabled={running} onClick={() => void startScan()}>
                <ScanLine className="size-4" />
                发起扫码登录
              </Button>
            </>
          )}
          {phase === "scanning" && (
            <Button variant="ghost" onClick={() => handleRef.current?.abort()}>
              取消登录
            </Button>
          )}
          {(phase === "success" || phase === "failed") && (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAccountDialog({
  account,
  onClose,
}: {
  account: OfficialAccount | null;
  onClose: () => void;
}) {
  const removeAccount = useAccountsStore((s) => s.removeAccount);
  const [removing, setRemoving] = useState(false);

  async function handleDelete(): Promise<void> {
    if (!account) return;
    setRemoving(true);
    try {
      await removeAccount(account.id);
      useToastStore.getState().show(`已删除「${account.name}」及关联 cookie`, "ok");
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
          及其关联的 cookie 文件。此操作不可撤销。
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

/** 编辑账号名：调用官方 /updateUserinfo（seam 契约之一）持久化 userName，成功后刷新列表。 */
function EditAccountDialog({
  account,
  onClose,
}: {
  account: OfficialAccount | null;
  onClose: () => void;
}) {
  const updateAccount = useAccountsStore((s) => s.updateAccount);
  const refetchValidAccounts = useAccountsStore((s) => s.refetchValidAccounts);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 每次打开时同步为当前账号名。
  useEffect(() => {
    if (account) {
      setName(account.name);
      setError("");
    }
  }, [account]);

  async function handleSave(): Promise<void> {
    if (!account) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("账号名不能为空");
      return;
    }
    setSaving(true);
    try {
      await updateAccount({
        id: account.id,
        type: account.typeNum,
        userName: trimmed,
      });
      useToastStore.getState().show("账号已更新", "ok");
      await refetchValidAccounts();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={account !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(420px,92vw)]">
        <DialogTitle>编辑账号</DialogTitle>
        <DialogDescription className="text-label text-muted">
          「{account?.name}」({account ? PLATFORM_NAMES[account.platform] : ""})
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="edit-account-name">账号名</Label>
          <Input
            id="edit-account-name"
            value={name}
            placeholder="用于区分不同账号"
            onChange={(e) => setName(e.target.value)}
          />
          {error && <p className="text-label text-danger-deep">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AccountsView() {
  const accounts = useAccountsStore((s) => s.accounts);
  const loading = useAccountsStore((s) => s.loading);
  const error = useAccountsStore((s) => s.error);
  const fetchingValid = useAccountsStore((s) => s.fetchingValid);
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts);
  const connected = useDaemonStore((s) => s.connected);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OfficialAccount | null>(null);
  const [editTarget, setEditTarget] = useState<OfficialAccount | null>(null);

  useEffect(() => {
    if (connected) void fetchAccounts();
  }, [connected, fetchAccounts]);

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <div className="mb-6 flex items-baseline gap-3">
        <h2 className="text-page font-semibold tracking-[-0.015em]">账号</h2>
        <span className="text-label text-muted">扫码登录 · 多平台账号管理</span>
        <div className="ml-auto">
          <Button
            variant="primary"
            disabled={!connected}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-4" />
            扫码登录
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
            description="通过官方后端扫码登录抖音 / 小红书 / 视频号 / 快手，登录态自动持久化到 cookie 文件"
          />
          <div className="flex justify-center pb-6">
            <Button
              variant="primary"
              disabled={!connected}
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="size-4" />
              扫码登录第一个账号
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
                  账号名
                </th>
                <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                  Cookie 有效性
                </th>
                <th className="px-4 py-2.5 text-right text-caption font-medium text-meta">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr
                  key={a.id}
                  className="border-b border-border-soft last:border-b-0 hover:bg-surface-warm"
                >
                  <td className="px-4 py-3">
                    <PlatformMark platform={a.platform} />
                  </td>
                  <td className="px-4 py-3 font-medium text-fg">{a.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-label font-medium",
                        a.cookieValid ? "text-success-deep" : "text-warn-deep",
                      )}
                    >
                      <span
                        className={cn(
                          "size-[7px] shrink-0 rounded-full",
                          a.cookieValid ? "bg-success" : "bg-warn",
                        )}
                      />
                      {a.cookieValid ? "Cookie 有效" : "Cookie 已失效"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-fg-2 hover:bg-surface"
                      onClick={() => setEditTarget(a)}
                    >
                      <PencilLine className="size-4" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:bg-danger-tint"
                      onClick={() => setDeleteTarget(a)}
                    >
                      <Trash2 className="size-4" />
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-end gap-2 border-t border-border-soft px-4 py-2 text-caption text-meta">
            {fetchingValid ? "正在校验 Cookie…" : `共 ${accounts.length} 个账号 · Cookie 有效性由官方 getValidAccounts 校验`}
          </div>
        </div>
      )}

      {error && !loading && (
        <p className="mt-4 rounded-md bg-danger-tint px-3 py-2 text-label text-danger-deep">
          加载失败：{error}
        </p>
      )}

      <ScanLoginDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onLoginSuccess={() => {
          useToastStore.getState().show("登录成功，账号已持久化", "ok");
        }}
      />
      <DeleteAccountDialog
        account={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
      <EditAccountDialog
        account={editTarget}
        onClose={() => setEditTarget(null)}
      />

      <CookieManager />
    </div>
  );
}
