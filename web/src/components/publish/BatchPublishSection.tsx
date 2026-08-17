import { useEffect, useMemo } from "react";
import { CheckCircle2, Layers, Send, XCircle } from "lucide-react";
import { useAccountsStore } from "../../stores/accounts";
import { useFilesStore } from "../../stores/files";
import { useBatchPublishStore } from "../../stores/batchPublish";
import { useDaemonStore } from "../../stores/daemon";
import type { Platform } from "../../api/types";
import { OFFICIAL_PLATFORM_NAMES, OFFICIAL_PLATFORM_TYPE } from "../../api/types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty } from "../ui/empty";
import { Input } from "../ui/input";
import { PlatformMark } from "../ui/platform-mark";

const PLATFORMS: Platform[] = ["xiaohongshu", "wechat", "douyin", "kuaishou"];

/**
 * 发布页「批量发布」区段：多文件 × 多账号 → 官方 /postVideoBatch（契约级提交）。
 * 独立组件承载全部「批量」专属状态与 UI，不改动单视频发布共享表单。
 */
export function BatchPublishSection() {
  const files = useFilesStore((s) => s.files);
  const fetchFiles = useFilesStore((s) => s.fetchFiles);
  const accounts = useAccountsStore((s) => s.accounts);
  const fetchAccounts = useAccountsStore((s) => s.fetchAccounts);
  const connected = useDaemonStore((s) => s.connected);

  const title = useBatchPublishStore((s) => s.title);
  const tags = useBatchPublishStore((s) => s.tags);
  const selectedFiles = useBatchPublishStore((s) => s.selectedFiles);
  const accountIdsByPlatform = useBatchPublishStore((s) => s.accountIdsByPlatform);
  const submitting = useBatchPublishStore((s) => s.submitting);
  const batchResult = useBatchPublishStore((s) => s.batchResult);
  const setForm = useBatchPublishStore((s) => s.setForm);
  const setSelectedFiles = useBatchPublishStore((s) => s.setSelectedFiles);
  const setPlatformAccountIds = useBatchPublishStore((s) => s.setPlatformAccountIds);
  const validate = useBatchPublishStore((s) => s.validate);
  const submit = useBatchPublishStore((s) => s.submit);
  const reset = useBatchPublishStore((s) => s.reset);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    if (accounts.length === 0) void fetchAccounts();
  }, [accounts.length, fetchAccounts]);

  const videos = useMemo(() => {
    const VIDEO_EXT = ["mp4", "mov", "webm", "m4v", "mkv"];
    return files.filter((f) =>
      VIDEO_EXT.includes(f.filename?.split(".").pop()?.toLowerCase() ?? ""),
    );
  }, [files]);

  const errors = validate();
  const checkedPlatforms = PLATFORMS.filter(
    (p) => (accountIdsByPlatform[p]?.length ?? 0) > 0,
  );

  function toggleFile(filePath: string): void {
    setSelectedFiles(
      selectedFiles.includes(filePath)
        ? selectedFiles.filter((f) => f !== filePath)
        : [...selectedFiles, filePath],
    );
  }

  function toggleAccount(p: Platform, id: number): void {
    const cur = accountIdsByPlatform[p] ?? [];
    setPlatformAccountIds(
      p,
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }

  async function handleSubmit(): Promise<void> {
    try {
      await submit();
    } catch {
      // 前端校验错误已由 errors 展示；请求级错误已由 batchResult 反馈面板展示。
    }
  }

  return (
    <section className="border-t border-border-soft py-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h3 className="text-title font-semibold tracking-[-0.01em]">批量发布</h3>
        <span className="text-label text-muted">多个视频与账号一次提交 · /postVideoBatch</span>
      </div>

      <div className="mb-4 flex items-center gap-2 rounded-lg border border-border-soft bg-bg px-3 py-2">
        <Layers className="size-4 text-meta" />
        <span className="text-caption text-meta">
          每选一个平台生成一个发布项：全部所选视频 × 该平台所选账号（笛卡尔提交）
        </span>
      </div>

      {/* 多选素材 */}
      <div className="mb-4">
        <p className="mb-2 text-label font-medium text-fg-2">选择视频素材（可多选）</p>
        {videos.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-soft">
            <Empty
              title="素材库还没有视频"
              description="先到「文件」页上传视频素材，批量发布时多选"
            />
          </div>
        ) : (
          <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
            {videos.map((f) => {
              const checked = selectedFiles.includes(f.file_path);
              return (
                <label
                  key={f.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border border-border-soft bg-bg px-4 py-2.5 transition-colors duration-150 ease-out hover:bg-surface-warm",
                    checked && "border-accent bg-accent-tint",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onChange={() => toggleFile(f.file_path)}
                    aria-label={`选择素材 ${f.filename}`}
                  />
                  <span className="min-w-0 truncate text-body font-medium text-fg">
                    {f.filename}
                  </span>
                  <span className="ml-auto text-caption text-meta">{f.filesize} MB</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* 多选账号（按平台 + 账号） */}
      <div className="mb-4">
        <p className="mb-2 text-label font-medium text-fg-2">选择账号（可多选，跨平台）</p>
        {accounts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-soft">
            <Empty title="还没有账号" description="先到「账号」区添加平台账号" />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {PLATFORMS.map((p) => {
              const list = accounts.filter((a) => a.platform === p);
              if (list.length === 0) return null;
              return (
                <div
                  key={p}
                  className={cn(
                    "rounded-lg border border-border-soft bg-bg px-4 py-2.5",
                    (accountIdsByPlatform[p]?.length ?? 0) > 0 && "border-accent bg-accent-tint",
                  )}
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <PlatformMark platform={p} />
                    <span className="text-label font-medium text-fg-2">
                      {OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[p]]}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((a) => {
                      const checked = (accountIdsByPlatform[p] ?? []).includes(a.id);
                      const usable = a.status === 1;
                      return (
                        <label
                          key={a.id}
                          className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-md border border-border-soft px-2.5 py-1.5 text-label transition-colors duration-150 ease-out hover:bg-surface-warm",
                            checked && "border-accent bg-accent-tint",
                            !usable && "opacity-55",
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={!usable}
                            onChange={() => toggleAccount(p, a.id)}
                            aria-label={`选择账号 ${a.name}`}
                          />
                          {a.name}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 标题 / 标签 */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="batch-title" className="text-label font-medium text-fg-2">
            标题
          </label>
          <Input
            id="batch-title"
            value={title}
            maxLength={60}
            placeholder="批量发布的视频标题（应用到全部所选）"
            onChange={(e) => setForm({ title: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="batch-tags" className="text-label font-medium text-fg-2">
            标签
          </label>
          <Input
            id="batch-tags"
            value={tags}
            placeholder="用空格或逗号分隔，如 批量 上线 #发布"
            onChange={(e) => setForm({ tags: e.target.value })}
          />
        </div>
      </div>

      {/* 行动 */}
      <div className="flex items-center gap-5">
        <Button
          variant="primary"
          disabled={!connected || submitting || errors.length > 0}
          onClick={() => void handleSubmit()}
        >
          <Send className="size-4" />
          {submitting ? "提交中…" : `批量发布（${checkedPlatforms.length} 平台）`}
        </Button>
        {!connected && (
          <span className="text-caption text-meta">守护进程未连接，无法发布</span>
        )}
        {errors.length > 0 && (
          <ul className="flex flex-col gap-1 text-label text-danger-deep">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <Button variant="ghost" size="sm" onClick={reset}>
          重置
        </Button>
      </div>

      {/* 批量结果反馈：总体 + 各平台子项 */}
      {batchResult && (
        <div className="mt-4 flex flex-col gap-2">
          <div
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-3 text-label",
              batchResult.okCount === batchResult.total
                ? "border-success bg-success-tint text-success-deep"
                : "border-danger bg-danger-tint text-danger-deep",
            )}
          >
            {batchResult.okCount === batchResult.total ? (
              <CheckCircle2 className="size-4 shrink-0" />
            ) : (
              <XCircle className="size-4 shrink-0" />
            )}
            <span className="font-semibold">
              批量结果：{batchResult.okCount}/{batchResult.total} 平台提交成功
            </span>
          </div>
          {(Object.keys(batchResult.items) as Platform[]).map((p) => {
            const it = batchResult.items[p]!;
            return (
              <div
                key={p}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-4 py-2.5 text-label",
                  it.ok
                    ? "border-success bg-success-tint text-success-deep"
                    : "border-danger bg-danger-tint text-danger-deep",
                )}
              >
                {it.ok ? (
                  <CheckCircle2 className="size-4 shrink-0 translate-y-0.5" />
                ) : (
                  <XCircle className="size-4 shrink-0 translate-y-0.5" />
                )}
                <div className="min-w-0">
                  <p className="font-semibold">
                    {OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[p]]}
                    <span className="ml-2 font-normal text-muted">
                      {it.ok ? "已提交" : "失败"}
                    </span>
                  </p>
                  {!it.ok && <p className="mt-0.5 break-words text-danger-deep">{it.msg}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
