import { useRef } from "react";
import { FolderOpen } from "lucide-react";
import { useAccountsStore } from "../../stores/accounts";
import { useBatchesStore } from "../../stores/batches";
import { useToastStore } from "../../stores/toast";
import { useViewStore } from "../../stores/view";
import { PLATFORM_NAMES } from "../../api/platformNames";
import { isTauri } from "../../lib/isTauri";
import { pickFolderPath } from "../../lib/picker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-4 flex items-baseline gap-3">
      <h3 className="text-title font-semibold tracking-[-0.01em]">{title}</h3>
      <span className="text-label text-muted">{hint}</span>
    </div>
  );
}

/** 批量导入：manifest 文件夹 → 待确认列表 → 放行（走 create_task 同一通道）。 */
export function BatchImportSection({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const accounts = useAccountsStore((s) => s.accounts);
  const folderPath = useBatchesStore((s) => s.folderPath);
  const selectedAccountId = useBatchesStore((s) => s.selectedAccountId);
  const result = useBatchesStore((s) => s.result);
  const parsing = useBatchesStore((s) => s.parsing);
  const confirming = useBatchesStore((s) => s.confirming);
  const accountOverrides = useBatchesStore((s) => s.accountOverrides);
  const setFolderPath = useBatchesStore((s) => s.setFolderPath);
  const setSelectedAccountId = useBatchesStore((s) => s.setSelectedAccountId);
  const parse = useBatchesStore((s) => s.parse);
  const patchEntry = useBatchesStore((s) => s.patchEntry);
  const setEntryAccount = useBatchesStore((s) => s.setEntryAccount);
  const confirm = useBatchesStore((s) => s.confirm);
  const reset = useBatchesStore((s) => s.reset);
  const pendingEntries = result?.entries ?? [];
  const hasHardErrors = (result?.hard_errors.length ?? 0) > 0;
  const setView = useViewStore((s) => s.setView);
  const browserInputRef = useRef<HTMLInputElement>(null);

  async function handlePickFolder(): Promise<void> {
    try {
      const path = await pickFolderPath();
      if (path) setFolderPath(path);
    } catch {
      browserInputRef.current?.click();
    }
  }

  async function handleParse(): Promise<void> {
    try {
      await parse();
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    }
  }

  async function handleConfirm(): Promise<void> {
    try {
      const ids = await confirm();
      useToastStore.getState().show(
        `已放行 ${ids.length} 个任务`,
        "ok",
      );
      reset();
      onOpenChange(false);
      setView("tasks");
    } catch (e) {
      useToastStore.getState().show(
        e instanceof Error ? e.message : String(e),
        "err",
      );
    }
  }

  if (!open) return null;

  return (
    <section className="border-t border-border-soft py-6">
      <SectionHead title="待确认导入" hint="manifest 批量导入 · 逐条核对后放行" />

      {/* 选择面板 */}
      {!result && (
        <div className="flex flex-col gap-4 rounded-lg border border-border-soft bg-bg p-4">
          <div className="flex items-end gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="batch-folder">批次文件夹（含 manifest.json）</Label>
              <div className="flex gap-2">
                <Input
                  id="batch-folder"
                  value={folderPath}
                  readOnly
                  placeholder={isTauri() ? "选择含 manifest.json 的文件夹" : "选择一个文件夹"}
                />
                <Button variant="secondary" onClick={() => void handlePickFolder()}>
                  <FolderOpen className="size-4" />
                  选择
                </Button>
              </div>
            </div>
            <div className="flex w-[200px] flex-col gap-1.5">
              <Label htmlFor="batch-account">目标账号</Label>
              <Select
                value={selectedAccountId ? String(selectedAccountId) : ""}
                onValueChange={(v) => setSelectedAccountId(Number(v))}
              >
                <SelectTrigger id="batch-account">
                  <SelectValue placeholder="选择账号" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {PLATFORM_NAMES[a.platform]} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!folderPath || selectedAccountId == null || parsing}
              onClick={() => void handleParse()}
            >
              {parsing ? "解析中…" : "解析"}
            </Button>
          </div>
        </div>
      )}

      {/* 整批拒绝 */}
      {result && hasHardErrors && (
        <div className="rounded-lg border border-danger bg-danger-tint p-4">
          <p className="text-body font-semibold text-danger-deep">批次无法导入</p>
          <ul className="mt-2 flex flex-col gap-1 text-label text-danger-deep">
            {(result.hard_errors ?? []).map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" onClick={() => reset()}>
              关闭
            </Button>
          </div>
        </div>
      )}

      {/* 待确认列表 */}
      {result && !hasHardErrors && (
        <>
          <div className="overflow-hidden rounded-lg border border-border-soft">
            {pendingEntries.map((entry) => {
              const overrideId = accountOverrides[entry.index];
              const accountId = overrideId ?? selectedAccountId;
              const warn = entry.warnings.length > 0;
              return (
                <div
                  key={entry.index}
                  className="flex items-center gap-3 border-b border-border-soft bg-bg p-3 px-4 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <Input
                      value={entry.title}
                      aria-label={`第 ${entry.index + 1} 条标题`}
                      className="h-8 font-medium"
                      onChange={(e) => patchEntry(entry.index, { title: e.target.value })}
                    />
                    <p className="mt-1 truncate text-caption text-meta">
                      {entry.file}
                      {entry.schedule ? ` · 定时 ${entry.schedule}` : " · 立即"}
                    </p>
                    {warn && (
                      <p className="mt-0.5 text-caption font-medium text-warn-deep">
                        {entry.warnings.join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="flex w-[150px] items-center gap-2">
                    <Label className="text-caption font-normal text-meta">账号</Label>
                    <Select
                      value={accountId ? String(accountId) : ""}
                      onValueChange={(v) => setEntryAccount(entry.index, Number(v))}
                    >
                      <SelectTrigger className="h-8 text-label" aria-label="账号">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((a) => (
                          <SelectItem key={a.id} value={String(a.id)}>
                            {PLATFORM_NAMES[a.platform]} · {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" disabled={confirming} onClick={() => reset()}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={confirming}
              onClick={() => void handleConfirm()}
            >
              {confirming ? "放行中…" : `放行全部（${pendingEntries.length}）`}
            </Button>
          </div>
        </>
      )}

      {/* 浏览器开发环境文件夹选择兜底 */}
      <input
        ref={browserInputRef}
        type="file"
        className="sr-only"
        // eslint-disable-next-line react/no-unknown-property
        {...({ webkitdirectory: "" } as object)}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && "webkitRelativePath" in file && file.webkitRelativePath) {
            setFolderPath(`/mock/${file.webkitRelativePath.split("/")[0]}`);
          }
        }}
      />
    </section>
  );
}
