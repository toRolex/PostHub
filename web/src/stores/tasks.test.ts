import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useTasksStore, type TaskDetail } from "./tasks";
import { useDaemonStore } from "./daemon";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function makeDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task: {
      id: 1,
      title: "春日踏青",
      media_type: "video",
      video_path: "/tmp/v.mp4",
      image_paths: null,
      caption: null,
      tags: null,
      cover_horizontal: null,
      cover_vertical: null,
      schedule_policy: "immediate",
      publish_mode: "platform_time",
      publish_at: null,
      silent: 0,
      status: "manual",
      created_at: "2026-08-08 00:00:00",
      updated_at: "2026-08-08 00:00:00",
    },
    jobs: [
      {
        id: 1,
        task_id: 1,
        account_id: 1,
        platform: "douyin",
        status: "manual",
        schedule_policy: null,
        publish_mode: null,
        publish_at: null,
        retry_at: null,
        title: null,
        caption: null,
        tags: null,
        cover_horizontal: null,
        cover_vertical: null,
        platform_fields: null,
        post_id: null,
        post_url: null,
        attempt_count: 1,
        last_error: "验证码",
        last_error_type: "risk_control",
        locked_at: null,
        locked_by: null,
        created_at: "2026-08-08 00:00:00",
        started_at: "2026-08-08 00:00:00",
        finished_at: "2026-08-08 00:00:00",
        updated_at: "2026-08-08 00:00:00",
      },
    ],
    ...overrides,
  };
}

describe("tasks store（任务状态可查 + 手动重试）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchTasks 成功 -> 填充列表并清空 error", async () => {
    const detail = makeDetail();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ tasks: [detail] }));
    vi.stubGlobal("fetch", fetchMock);

    const daemon = useDaemonStore();
    daemon.url = "http://127.0.0.1:9999";
    const store = useTasksStore();
    await store.fetchTasks();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9999/tasks");
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0].task.status).toBe("manual");
    expect(store.tasks[0].jobs[0].last_error_type).toBe("risk_control");
  });

  it("retryJob 调用 POST 并刷新任务列表", async () => {
    const detail = makeDetail();
    const updated = makeDetail();
    updated.jobs[0].status = "pending";
    updated.task.status = "pending";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // retry POST
      .mockResolvedValueOnce(jsonResponse({ tasks: [updated] })); // 刷新
    vi.stubGlobal("fetch", fetchMock);

    const store = useTasksStore();
    store.tasks = [detail];
    await store.retryJob(1, 1);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8756/tasks/1/jobs/1/retry",
      expect.objectContaining({ method: "POST" }),
    );
    expect(store.tasks[0].jobs[0].status).toBe("pending");
  });

  it("retryJob 失败 -> 抛出错误且列表不变", async () => {
    const detail = makeDetail();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "只有终态可重试" }, false, 400)),
    );

    const store = useTasksStore();
    store.tasks = [detail];
    await expect(store.retryJob(1, 1)).rejects.toThrow("只有终态可重试");
    expect(store.tasks[0].jobs[0].status).toBe("manual");
  });
});
