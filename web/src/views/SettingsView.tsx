import { useEffect, useState } from "react";
import { FolderOpen, Save } from "lucide-react";
import { useSettingsStore } from "../stores/settings";
import { useToastStore } from "../stores/toast";
import { pickChromePath } from "../lib/picker";
import { isTauri } from "../lib/isTauri";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

/**
 * 设置页 —— 配置本地 Chrome 路径。
 *
 * 该路径持久化到 app_data/settings.json，桌面壳下次启动 daemon 时注入
 * `POSTHUB_LOCAL_CHROME_PATH`；daemon 的 `LOCAL_CHROME_PATH` 据此使用本地 Chrome。
 * 留空则回落使用自带 Chromium。
 */
export function SettingsView() {
  const chromePath = useSettingsStore((s) => s.chromePath);
  const load = useSettingsStore((s) => s.load);
  const save = useSettingsStore((s) => s.save);
  const saving = useSettingsStore((s) => s.loading);
  const [path, setPath] = useState("");

  // 进入页面时同步当前已保存的配置。
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPath(chromePath);
  }, [chromePath]);

  async function handleBrowse(): Promise<void> {
    if (!isTauri()) {
      useToastStore.getState().show("仅桌面应用支持选择文件", "warn");
      return;
    }
    try {
      const selected = await pickChromePath();
      if (selected) setPath(selected);
    } catch {
      useToastStore.getState().show("选择文件失败", "err");
    }
  }

  async function handleSave(): Promise<void> {
    try {
      await save(path);
      useToastStore.getState().show(
        path.trim()
          ? "设置已保存，重启应用后对 daemon 生效"
          : "已清除本地 Chrome 路径，将使用自带 Chromium",
        "ok",
      );
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
        <h2 className="text-page font-semibold tracking-[-0.015em]">设置</h2>
        <span className="text-label text-muted">本地 Chrome 路径 · 登录与上传浏览器策略</span>
      </div>

      <div className="max-w-[560px] space-y-6">
        <section className="rounded-lg border border-border-soft bg-bg">
          <div className="border-b border-border-soft px-4 py-3">
            <h3 className="text-label font-medium text-fg">本地 Chrome</h3>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="chrome-path">Chrome 可执行文件路径</Label>
              <div className="flex gap-2">
                <Input
                  id="chrome-path"
                  value={path}
                  placeholder="例如：C:\Program Files\Google\Chrome\Application\chrome.exe"
                  onChange={(e) => setPath(e.target.value)}
                />
                <Button
                  variant="secondary"
                  type="button"
                  disabled={!isTauri()}
                  onClick={() => void handleBrowse()}
                >
                  <FolderOpen className="size-4" />
                  浏览
                </Button>
              </div>
              <p className="text-caption text-meta">
                部分平台（抖音 / 视频号）使用自带 Chromium 可能存在兼容性问题，可配置本地 Chrome 规避。留空则使用内置 Chromium。
              </p>
            </div>
            <div className="flex justify-end">
              <Button
                variant="primary"
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                <Save className="size-4" />
                {saving ? "保存中…" : "保存设置"}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
