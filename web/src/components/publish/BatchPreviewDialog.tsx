/**
 * BatchPreviewDialog（issue #39 抽屉矩阵 UI 的提交预览 Dialog）。
 *
 * 受控哑组件：props 由父组件（BatchPublishSection）传入；不读 store。
 * - 列项：视频名 / 目标平台与账号 / 模式 / 时刻 / 起始日。
 * - 「取消」调 onCancel；「确认发布」调 onConfirm（即 store.submit）。
 * - 视频号条目旁挂 PlatformLimitHint（issue #40），由 selectWechatScheduledCount
 *   派生该账号本批次累计定时任务数；仅展示不拦截提交。
 *
 * 边界规则（issue #39）：不挂 store；只通过 props 渲染。
 */

import { CheckCircle2, XCircle } from "lucide-react";
import { OFFICIAL_PLATFORM_NAMES, OFFICIAL_PLATFORM_TYPE } from "../../api/types";
import type { Platform } from "../../api/types";
import type { BatchItem, BatchItemResult } from "../../types/batch";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { PlatformMark } from "../ui/platform-mark";
import { PlatformLimitHint } from "./PlatformLimitHint";
import { cn } from "../../lib/utils";
import { selectWechatScheduledCount } from "../../stores/batchPublish";

/** 预览 Dialog 一行可渲染的对象（从 BatchItem × 账号展开）。 */
export interface PreviewRow {
  /** 稳定 key：filePath + "|" + cookieFile。 */
  itemKey: string;
  fileName: string;
  platform: Platform;
  /** 该平台下被勾选的账号 cookie 文件名。 */
  accountCookie: string;
  mode: BatchItem["mode"];
  timeOfDay?: string;
  startDays?: number;
}

/**
 * 把 BatchItem[] 展开为预览行（每账号一行）。
 * 纯函数，便于不挂 DOM 直接单测。
 */
export function buildPreviewRows(items: BatchItem[]): PreviewRow[] {
  const rows: PreviewRow[] = [];
  for (const item of items) {
    for (const [platform, accounts] of Object.entries(item.accountIdsByPlatform) as [
      Platform,
      string[],
    ][]) {
      if (!accounts) continue;
      for (const cookie of accounts) {
        rows.push({
          itemKey: `${item.filePath}|${cookie}`,
          fileName: item.filePath,
          platform,
          accountCookie: cookie,
          mode: item.mode,
          timeOfDay: item.timeOfDay,
          startDays: item.startDays,
        });
      }
    }
  }
  return rows;
}

interface BatchPreviewDialogProps {
  open: boolean;
  items: BatchItem[];
  /** 提交反馈（用于在 Dialog 内展示）；可缺省。 */
  results?: BatchItemResult[] | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 提交前预览 Dialog。列项与 store 中要发布的 postVideo 项数（=每视频×每账号）一致。
 */
export function BatchPreviewDialog({
  open,
  items,
  results,
  onConfirm,
  onCancel,
}: BatchPreviewDialogProps) {
  const rows = buildPreviewRows(items);
  const resultsByKey = new Map<string, BatchItemResult>();
  if (results) for (const r of results) resultsByKey.set(r.itemKey, r);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="w-[min(560px,94vw)]">
        <DialogTitle>确认批量发布</DialogTitle>
        <DialogDescription>
          本次将提交 <strong>{rows.length}</strong> 个发布项（每视频 × 每账号）。
          请核对后再确认。
        </DialogDescription>

        <div className="mt-4 max-h-[60vh] overflow-y-auto rounded-md border border-border-soft">
          <table className="w-full text-label">
            <thead className="sticky top-0 bg-surface-warm text-meta">
              <tr>
                <th className="px-3 py-2 text-left font-medium">视频</th>
                <th className="px-3 py-2 text-left font-medium">平台 / 账号</th>
                <th className="px-3 py-2 text-left font-medium">模式</th>
                <th className="px-3 py-2 text-left font-medium">时刻</th>
                <th className="px-3 py-2 text-left font-medium">起始日</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const result = resultsByKey.get(r.itemKey);
                return (
                  <tr key={r.itemKey} className="border-t border-border-soft">
                    <td className="max-w-[160px] truncate px-3 py-2 font-medium text-fg">
                      {r.fileName}
                    </td>
                    <td className="px-3 py-2 text-fg-2">
                      <div className="flex items-center gap-2">
                        <PlatformMark platform={r.platform} />
                        <span className="text-caption text-meta">
                          {OFFICIAL_PLATFORM_NAMES[OFFICIAL_PLATFORM_TYPE[r.platform]]} · {r.accountCookie}
                        </span>
                        {r.platform === "wechat" && (
                          <PlatformLimitHint
                            count={selectWechatScheduledCount(items, r.accountCookie)}
                          />
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-fg-2">
                      {r.mode === "immediate" ? "立即" : "定时"}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-fg-2">
                      {r.mode === "timer" ? r.timeOfDay : "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-fg-2">
                      {r.mode === "timer" && r.startDays !== undefined
                        ? `+${r.startDays} 天`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {result ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-caption",
                            result.ok
                              ? "bg-success-tint text-success-deep"
                              : "bg-danger-tint text-danger-deep",
                          )}
                        >
                          {result.ok ? (
                            <CheckCircle2 className="size-3" />
                          ) : (
                            <XCircle className="size-3" />
                          )}
                          {result.ok ? "成功" : "失败"}
                        </span>
                      ) : (
                        <span className="text-caption text-meta">待提交</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            确认发布
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}