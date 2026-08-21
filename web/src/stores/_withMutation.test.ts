import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";

import { withMutation, type WithMutationOptions } from "./_withMutation";

interface DemoState {
  loading: boolean;
  deletingId: number | null;
  connected: boolean;
  error: string;
  value: number;
  run: <R>(
    fn: () => Promise<R>,
    opts?: WithMutationOptions<DemoState>,
  ) => Promise<R | undefined>;
}

const useDemoStore = create<DemoState>()((set) => ({
  loading: false,
  deletingId: null,
  connected: true,
  error: "",
  value: 0,
  run: (fn, opts) => withMutation(set, fn, opts),
}));

describe("withMutation（store mutation 骨架收敛）", () => {
  beforeEach(() => {
    useDemoStore.setState({
      loading: false,
      deletingId: null,
      connected: true,
      error: "",
      value: 0,
    });
  });

  it("loading 转场：begin 置位在 fn 执行期间可见，成功后 end 复位", async () => {
    let loadingDuring = false;
    await useDemoStore.getState().run(
      async () => {
        loadingDuring = useDemoStore.getState().loading;
        useDemoStore.setState({ value: 42 });
      },
      { begin: { loading: true }, end: { loading: false } },
    );

    expect(loadingDuring).toBe(true);
    expect(useDemoStore.getState().loading).toBe(false);
    expect(useDemoStore.getState().value).toBe(42);
  });

  it("loading 转场支持 id 型置位（begin 写 id / end 复位 null）", async () => {
    let idDuring: number | null = null;
    await useDemoStore.getState().run(
      async () => {
        idDuring = useDemoStore.getState().deletingId;
      },
      { begin: { deletingId: 7 }, end: { deletingId: null } },
    );

    expect(idDuring).toBe(7);
    expect(useDemoStore.getState().deletingId).toBeNull();
  });

  it("默认错误归一化：Error 实例写 message 到 error，不 rethrow", async () => {
    await useDemoStore.getState().run(
      async () => {
        throw new Error("boom");
      },
      { begin: { loading: true }, end: { loading: false } },
    );

    const s = useDemoStore.getState();
    expect(s.error).toBe("boom");
    expect(s.loading).toBe(false);
  });

  it("非 Error 异常归一化：字符串 / 数字转字符串写入 error", async () => {
    await useDemoStore.getState().run(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "纯字符串错误";
    });
    expect(useDemoStore.getState().error).toBe("纯字符串错误");

    await useDemoStore.getState().run(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 404;
    });
    expect(useDemoStore.getState().error).toBe("404");
  });

  it("finally 兜底：fn 抛错时 end 复位仍执行", async () => {
    await useDemoStore.getState().run(
      async () => {
        throw new Error("fail");
      },
      { begin: { loading: true }, end: { loading: false } },
    );
    expect(useDemoStore.getState().loading).toBe(false);
  });

  it("finally 兜底：rethrow 场景 end 复位仍执行", async () => {
    await expect(
      useDemoStore.getState().run(
        async () => {
          throw new Error("fail");
        },
        { begin: { loading: true }, end: { loading: false }, rethrow: true },
      ),
    ).rejects.toThrow("fail");
    expect(useDemoStore.getState().loading).toBe(false);
  });

  it("rethrow 语义：默认吞错仅写 error；rethrow: true 先写 error 再抛原异常", async () => {
    const err = new Error("keep-original");
    await useDemoStore.getState().run(async () => {
      throw err;
    });
    expect(useDemoStore.getState().error).toBe("keep-original");

    let caught: unknown;
    try {
      await useDemoStore.getState().run(
        async () => {
          throw err;
        },
        { rethrow: true },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(useDemoStore.getState().error).toBe("keep-original");
  });

  it("自定义 onError：返回 Partial 合并写入（覆盖默认 error 归一化）", async () => {
    await useDemoStore.getState().run(
      async () => {
        throw new Error("net down");
      },
      { onError: (message) => ({ connected: false, error: `自定义:${message}` }) },
    );

    const s = useDemoStore.getState();
    expect(s.connected).toBe(false);
    expect(s.error).toBe("自定义:net down");
  });

  it("onError 返回 undefined -> 不写 error（逐平台自有反馈的 mutation）", async () => {
    useDemoStore.setState({ error: "旧错误" });
    await expect(
      useDemoStore.getState().run(
        async () => {
          throw new Error("propagate");
        },
        { onError: () => undefined, rethrow: true },
      ),
    ).rejects.toThrow("propagate");
    expect(useDemoStore.getState().error).toBe("旧错误");
  });

  it("无 begin/end：仅 try/catch 骨架（loading 状态不被触碰）", async () => {
    await useDemoStore.getState().run(async () => {
      useDemoStore.setState({ value: 1 });
    });
    expect(useDemoStore.getState().value).toBe(1);
    expect(useDemoStore.getState().loading).toBe(false);

    await useDemoStore.getState().run(async () => {
      throw new Error("x");
    });
    expect(useDemoStore.getState().loading).toBe(false);
    expect(useDemoStore.getState().error).toBe("x");
  });

  it("fn 返回值透传给调用方", async () => {
    const result = await useDemoStore.getState().run(async () => "ok-value");
    expect(result).toBe("ok-value");
  });
});
