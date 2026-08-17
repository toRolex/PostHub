import { useEffect, useRef, useState } from "react";
import { FilePlus2, FileText, RefreshCw, UploadCloud } from "lucide-react";
import { useDaemonStore } from "../stores/daemon";
import { useFilesStore } from "../stores/files";
import { useToastStore } from "../stores/toast";
import { officialApi } from "../api/official";
import { formatRelative, parseOfficialUtcTime } from "../lib/format";
import type { OfficialFileRecord } from "../api/types";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";

const VIDEO_EXT = ["mp4", "mov", "webm", "m4v", "mkv"];

function isVideo(f: OfficialFileRecord): boolean {
  const ext = f.filename?.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXT.includes(ext);
}
const isImage = (f: OfficialFileRecord): boolean =>
  /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.filename ?? "");

function prettySize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(2)} MB`;
}

function UploadCard() {
  const uploading = useFilesStore((s) => s.uploading);
  const upload = useFilesStore((s) => s.upload);
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const customName = name.trim() ? name.trim() : undefined;
      await upload(file, customName);
      useToastStore.getState().show(
        customName ? `「${customName}」已上传到素材库` : "素材已上传到素材库",
        "ok",
      );
      setName("");
    } catch (err) {
      useToastStore.getState().show(
        err instanceof Error ? err.message : String(err),
        "err",
      );
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="rounded-lg border border-border-soft bg-bg p-5">
      <h3 className="mb-3 flex items-center gap-2 text-title font-semibold tracking-[-0.01em]">
        <UploadCloud className="size-4 text-meta" />
        上传素材
      </h3>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="video/*,image/*"
            className="hidden"
            onChange={(e) => void handleFileChange(e)}
          />
          <Button
            variant="primary"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <FilePlus2 className="size-4" />
            {uploading ? "上传中…" : "选择视频 / 图片"}
          </Button>
          <input
            value={name}
            placeholder="自定义名称（可选）"
            disabled={uploading}
            onChange={(e) => setName(e.target.value)}
            className="h-9 flex-1 rounded-md border border-border bg-bg px-3 text-body text-fg transition-colors duration-150 ease-out placeholder:text-meta focus:border-accent focus:outline-none disabled:opacity-50"
          />
        </div>
        <p className="text-caption text-meta">
          上传后文件进入官方素材库（磁盘 videoFile/ + file_records 记录），供发布任务选取。
        </p>
      </div>
    </section>
  );
}

function FileRowControls({ file }: { file: OfficialFileRecord }) {
  const removeFile = useFilesStore((s) => s.removeFile);
  const deleting = useFilesStore((s) => s.deletingId === file.id);
  const url = useDaemonStore((s) => s.url);

  async function handleDelete(): Promise<void> {
    try {
      await removeFile(file.id);
      useToastStore.getState().show(`「${file.filename}」已删除`, "ok");
    } catch (err) {
      useToastStore.getState().show(
        err instanceof Error ? err.message : String(err),
        "err",
      );
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <a
        className="rounded-md px-2 py-1 text-caption font-medium text-fg-2 hover:bg-surface hover:text-fg"
        href={officialApi.fileUrl(url, file.file_path)}
        target="_blank"
        rel="noreferrer"
      >
        预览
      </a>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger hover:bg-danger-tint"
        disabled={deleting}
        onClick={() => void handleDelete()}
      >
        {deleting ? "删除中…" : "删除"}
      </Button>
    </div>
  );
}

function FileList() {
  const files = useFilesStore((s) => s.files);
  const loading = useFilesStore((s) => s.loading);

  if (loading && files.length === 0) return <Skeleton rows={5} />;

  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-soft">
        <Empty
          icon={<FileText className="size-[34px] text-meta" strokeWidth={1.5} />}
          title="素材库是空的"
          description="先上传视频或图片素材，发布时可直接选取"
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-bg">
      <table className="w-full border-collapse text-label">
        <thead>
          <tr className="border-b border-border bg-surface-warm">
            <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">类型</th>
            <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">名称</th>
            <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">大小</th>
            <th className="px-4 py-2.5 text-left text-caption font-medium text-meta">上传时间</th>
            <th className="px-4 py-2.5 text-right text-caption font-medium text-meta">操作</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr
              key={f.id}
              className="border-b border-border-soft last:border-b-0 hover:bg-surface-warm"
            >
              <td className="px-4 py-3">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-caption font-semibold",
                    isVideo(f)
                      ? "bg-accent-tint text-accent-ink"
                      : "bg-surface-sunk text-meta",
                  )}
                >
                  {isVideo(f) ? "视频" : isImage(f) ? "图片" : "文件"}
                </span>
              </td>
              <td className="max-w-[300px] truncate px-4 py-3 font-medium text-fg" title={f.filename}>
                {f.filename}
              </td>
              <td className="px-4 py-3 tabular-nums text-muted">{prettySize(f.filesize)}</td>
              <td className="px-4 py-3 text-muted">{formatRelative(parseOfficialUtcTime(f.upload_time))}</td>
              <td className="px-4 py-3">
                <FileRowControls file={f} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FileView() {
  const fetchFiles = useFilesStore((s) => s.fetchFiles);
  const syncLoading = useFilesStore((s) => s.loading);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  return (
    <div className="mx-auto max-w-[960px] animate-fade-in px-8 pb-12 pt-8">
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-page font-semibold tracking-[-0.015em]">文件</h2>
        <span className="text-label text-muted">官方素材库 · 上传 / 预览 / 删除</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={syncLoading}
            onClick={() => void fetchFiles()}
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </div>

      <UploadCard />

      <div className="mt-6">
        <FileList />
      </div>
    </div>
  );
}