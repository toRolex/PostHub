import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useBatchesStore } from "./batches";
import { useDaemonStore } from "./daemon";
import { useAccountsStore } from "./accounts";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function makeResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1,
    entries: [
      {
        index: 0,
        file: "/tmp/batch/视频1.mp4",
        title: "标题1",
        content: "正文1",
        tags: ["话题1"],
        cover_landscape: "/tmp/batch/cover1.jpg",
        cover_portrait: null,
        schedule: "2026-08-08 10:00:00",
        warnings: [],
      },
      {
        index: 1,
        file: "/tmp/batch/视频2.mp4",
        title: "标题2",
        content: null,
        tags: [],
        cover_landscape: null,
        cover_portrait: null,
        schedule: null,
        warnings: ["标题为空，已用文件名兜底"],
      },
    ],
    hard_errors: [] as unknown[],
    ...overrides,
  };
}

function seedAccounts(): void {
  const accounts = useAccountsStore();
  accounts.accounts = [
    {
      id: 1,
      platform: "douyin",
      name: "抖音一号",
      profile_dir: "/tmp/p-douyin",
      cdp_port: 9222,
      chrome_path: null,
      status: "active",
      last_login_at: null,
      last_publish_at: null,
      created_at: "",
      updated_at: "",
    },
    {
      id: 2,
      platform: "xiaohongshu",
      name: "小红书",
      profile_dir: "/tmp/p-xhs",
      cdp_port: 9223,
      chrome_path: null,
      status: "active",
      last_login_at: null,
      last_publish_at: null,
      created_at: "",
      updated_at: "",
    },
  ];
}

describe("batches store（manifest 批量导入）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedAccounts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parse 成功 -> POST /batches/import 并保存待确认列表", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeResult()));
    vi.stubGlobal("fetch", fetchMock);

    const daemon = useDaemonStore();
    daemon.url = "http://127.0.0.1:9999";
    const store = useBatchesStore();
    store.folderPath = "/tmp/batch";
    store.selectedAccountId = 1;

    const result = await store.parse();

    expect(result.entries).toHaveLength(2);
    expect(store.hasHardErrors).toBe(false);
    expect(store.pendingEntries).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/batches/import",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.folder_path).toBe("/tmp/batch");
    expect(sent.account_id).toBe(1);
  });

  it("parse 前校验：缺文件夹路径或账号 -> 抛错且不发起请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const store = useBatchesStore();
    await expect(store.parse()).rejects.toThrow(/文件夹/);
    store.folderPath = "/tmp/batch";
    await expect(store.parse()).rejects.toThrow(/账号/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parse 含硬错误 -> 保留结果，hasHardErrors 为 true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResult({
            entries: [],
            hard_errors: [
              { index: 0, message: "第 1 条：缺少必填字段 file" },
            ],
          }),
        ),
      ),
    );
    const store = useBatchesStore();
    store.folderPath = "/tmp/batch";
    store.selectedAccountId = 1;

    await store.parse();

    expect(store.hasHardErrors).toBe(true);
    expect(store.pendingEntries).toHaveLength(0);
  });

  it("patchEntry 逐条覆盖标题/正文/封面/定时", () => {
    const store = useBatchesStore();
    store.result = makeResult() as never;

    store.patchEntry(0, { title: "新标题", schedule: null, cover_landscape: null });

    expect(store.pendingEntries[0].title).toBe("新标题");
    expect(store.pendingEntries[0].schedule).toBeNull();
    expect(store.pendingEntries[1].title).toBe("标题2"); // 其他条目不受影响
  });

  it("confirm -> POST /batches/confirm 逐条携带账号/平台并保存 task_ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ task_ids: [1, 2], tasks: [{ id: 1 }, { id: 2 }] }, true, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    const daemon = useDaemonStore();
    daemon.url = "http://127.0.0.1:9999";
    const store = useBatchesStore();
    store.folderPath = "/tmp/batch";
    store.selectedAccountId = 1;
    store.result = makeResult() as never;

    const taskIds = await store.confirm();

    expect(taskIds).toEqual([1, 2]);
    expect(store.lastTaskIds).toEqual([1, 2]);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.account_id).toBe(1);
    expect(sent.entries).toHaveLength(2);
    expect(sent.entries[0].account_id).toBe(1);
    expect(sent.entries[0].platform).toBe("douyin");
  });

  it("confirm 支持逐条覆盖账号（跨平台）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ task_ids: [1], tasks: [{ id: 1 }] }, true, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = useBatchesStore();
    store.selectedAccountId = 1;
    store.result = makeResult() as never;
    store.setEntryAccount(0, 2); // 覆盖为小红书账号

    await store.confirm();

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.entries[0].account_id).toBe(2);
    expect(sent.entries[0].platform).toBe("xiaohongshu");
    expect(sent.entries[1].account_id).toBe(1); // 其余用批次默认
  });

  it("confirm 服务端 400 -> 抛错且不落库", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "定时发布时间距现在不足 2 小时" }, false, 400)),
    );
    const store = useBatchesStore();
    store.selectedAccountId = 1;
    store.result = makeResult() as never;

    await expect(store.confirm()).rejects.toThrow(/不足 2 小时/);
  });
});
