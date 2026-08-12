import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialInterventionsState, useInterventionsStore } from "./interventions";
import { useDaemonStore } from "./daemon";
import type { Intervention } from "../api/types";

// mock 通知函数：poll 检测到新事件时调用（避免测试触发真实弹窗）
vi.mock("../lib/interventionNotify", () => ({
  isTauri: () => false,
  notifyIntervention: vi.fn().mockResolvedValue(undefined),
}));

import { notifyIntervention } from "../lib/interventionNotify";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function makeIntervention(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: 1,
    kind: "manual",
    job_id: 1,
    task_id: 1,
    account_id: 1,
    platform: "douyin",
    message: "验证码",
    error_type: "risk_control",
    created_at: "2026-08-08 00:00:00",
    acknowledged_at: null,
    ...overrides,
  };
}

describe("interventions store（人工介入事件轮询）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useInterventionsStore.setState(initialInterventionsState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("fetchInterventions 成功 -> 填充 pending 列表", async () => {
    const iv = makeIntervention();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ interventions: [iv] })),
    );

    await useInterventionsStore.getState().fetchInterventions();

    const s = useInterventionsStore.getState();
    expect(s.interventions).toHaveLength(1);
    expect(s.interventions[0].kind).toBe("manual");
    expect(s.error).toBe("");
  });

  it("poll 检测到新事件 -> 触发 notify 并 ack 出列", async () => {
    const iv = makeIntervention();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ interventions: [iv] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // ack POST
    vi.stubGlobal("fetch", fetchMock);

    await useInterventionsStore.getState().poll();

    expect(notifyIntervention).toHaveBeenCalledTimes(1);
    expect(notifyIntervention).toHaveBeenCalledWith(iv);
    // ack 后从 pending 出列
    expect(useInterventionsStore.getState().interventions).toHaveLength(0);
  });

  it("poll 对已见事件不重复触发 notify", async () => {
    const iv = makeIntervention();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ interventions: [iv] }));
    vi.stubGlobal("fetch", fetchMock);

    await useInterventionsStore.getState().poll();
    await useInterventionsStore.getState().poll();

    expect(notifyIntervention).toHaveBeenCalledTimes(1);
  });

  it("poll 空列表 -> 不触发 notify", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ interventions: [] })),
    );

    await useInterventionsStore.getState().poll();

    expect(notifyIntervention).not.toHaveBeenCalled();
  });

  it("acknowledge 调用 POST /interventions/{id}/ack 并移除本地", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    useInterventionsStore.setState({
      interventions: [makeIntervention({ id: 5 })],
    });

    await useInterventionsStore.getState().acknowledge(5);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/interventions/5/ack",
      expect.objectContaining({ method: "POST" }),
    );
    expect(useInterventionsStore.getState().interventions).toHaveLength(0);
  });
});
