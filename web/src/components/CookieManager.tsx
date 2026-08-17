/**
 * Cookie 导入/导出（ticket 06）——官方后端 seam 的专用区段。
 *
 * 独立于「账号管理」的扫码登录逻辑：本区段操作的是官方 user_info 表中的
 * cookie 账号（直连 sau_backend），而非 PostHub 每账号=本机 Chrome 的账号模型。
 * 因此不嵌入并行 agent（t05）在 AccountsView 中改写的部分，避免整文件覆盖冲突。
 *
 * 列表来自 `GET /getAccounts`（user_info 全行，不校验）。每行支持：
 *   - 导入：选 .json cookie 文件 → `POST /uploadCookie`（写入该账号 filePath）
 *   - 校验：`GET /getValidAccounts`（逐行 check_cookie，失效行 status 置 0）
 *   - 导出：`GET /downloadCookie?filePath=...`（下载附件备份/迁移）
 */
import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";
import { useCookiesStore } from "../stores/cookies";
import { useDaemonStore } from "../stores/daemon";
import { useToastStore } from "../stores/toast";
import { OFFICIAL_PLATFORM_NAMES } from "../api/platformNames";
import type { CookiedAccount, OfficialCookieStatus } from "../api/types";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import { Status, type StatusMeta } from "./ui/status";
import { cn } from "../lib/utils";

/** 官方 user_info.status：1 有效 / 0 失效（cookie 维度）的展示元信息。 */
const COOKIE_STATUS_META: Record<OfficialCookieStatus, StatusMeta> = {
  1: { dot: "bg-success", text: "text-success-deep", label: "有效" },
  0: { dot: "bg-danger", text: "text-danger-deep", label: "失效" },
};

function ImportCookieButton({ accountId }: { accountId: number }) {
  const importCookie = useCookiesStore((s) => s.importCookie);
  const importingId = useCookiesStore((s) => s.importingId);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = importingId === accountId;

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.name.endsWith(".json")) {
      useToastStore.getState().show("Cookie 文件必须是 .json", "err");
      return;
    }
    try {
      await importCookie(file, accountId);
      useToastStore.getState().show("Cookie 导入成功", "ok");
    } catch (err) {
      useToastStore.getState().show(
        err instanceof Error ? err.message : String(err),
        "err",
      );
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => void handleFile(e)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        <Upload className="size-3.5" />
        {uploading ? "导入中…" : "导入"}
      </Button>
    </>
  );
}

export function CookieManager() {
  const accounts = useCookiesStore((s) => s.accounts);
  const loading = useCookiesStore((s) => s.loading);
  const validating = useCookiesStore((s) => s.validating);
  const error = useCookiesStore((s) => s.error);
  const connected = useDaemonStore((s) => s.connected);
  const fetchAccounts = useCookiesStore((s) => s.fetchAccounts);
  const validateAll = useCookiesStore((s) => s.validateAll);
  const exportCookie = useCookiesStore((s) => s.exportCookie);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (connected) void fetchAccounts();
  }, [connected, fetchAccounts]);

  async function handleValidate(): Promise<void> {
    try {
      await validateAll();
      useToastStore.getState().show("Cookie 校验完成，失效账号已标记", "ok");
    } catch (err) {
      useToastStore.getState().show(
        err instanceof Error ? err.message : String(err),
        "err",
      );
    }
  }

  async function handleExport(a: CookiedAccount): Promise<void> {
    try {
      await exportCookie(a.filePath, `${a.userName}-${a.id}.json`);
      useToastStore.getState().show("Cookie 已导出", "ok");
    } catch (err) {
      useToastStore.getState().show(
        err instanceof Error ? err.message : String(err),
        "err",
      );
    }
  }

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center gap-3">
        <h3 className="text-label font-semibold text-fg">
          Cookie 导入 / 导出（官方后端）
        </h3>
        <span className="text-caption text-muted">
          备份 / 迁移登录态，直连官方 user_info
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!connected || validating}
            onClick={() => void handleValidate()}
          >
            <RefreshCw className={cn("size-3.5", validating && "animate-spin")} />
            {validating ? "校验中…" : "校验全部"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "收起" : "展开"}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="overflow-hidden rounded-lg border border-border-soft bg-bg">
          {loading && accounts.length === 0 ? (
            <Skeleton rows={3} />
          ) : accounts.length === 0 ? (
            <Empty
              title="还没有 Cookie 账号"
              description="先通过「添加账号」扫码登录产生 cookie，或用「导入」为已有账号恢复登录态"
            />
          ) : (
            <table className="w-full border-collapse text-label">
              <thead>
                <tr className="border-b border-border bg-surface-warm">
                  <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                    平台
                  </th>
                  <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                    账号
                  </th>
                  <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">
                    Cookie 文件
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
                  <tr
                    key={a.id}
                    className="border-b border-border-soft last:border-b-0 hover:bg-surface-warm"
                  >
                    <td className="px-4 py-3">
                      {OFFICIAL_PLATFORM_NAMES[a.type] ?? `平台 ${a.type}`}
                    </td>
                    <td className="px-4 py-3 font-medium text-fg">{a.userName}</td>
                    <td className="px-4 py-3 font-mono text-caption text-muted">
                      {a.filePath}
                    </td>
                    <td className="px-4 py-3">
                      <Status meta={COOKIE_STATUS_META[a.status] ?? COOKIE_STATUS_META[0]} />
                    </td>
                    <td className={cn("px-4 py-3 text-right")}>
                      <div className="flex justify-end gap-2">
                        <ImportCookieButton accountId={a.id} />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleExport(a)}
                        >
                          <Download className="size-3.5" />
                          导出
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {error && (
            <p className="border-t border-border-soft px-4 py-2 text-caption text-danger-deep">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}