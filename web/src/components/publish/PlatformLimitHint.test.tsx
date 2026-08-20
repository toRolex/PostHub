/**
 * PlatformLimitHint 组件 DOM 测试（issue #40）。
 *
 * 注：本项目未装 @testing-library/react 或 happy-dom；本测试用 react-dom/server 的
 * renderToString 同步生成 HTML 字符串（不依赖 DOM），再断言 className / textContent /
 * 属性。该方式无需 root.unmount 与异步 scheduler，避免 React 19 + jsdom 的 lifecycle 冲突。
 *
 * 覆盖：
 * - 阈值内（count <= limit）：文案「本批次累计 N 条定时任务」、class 含 `bg-warn-tint`、
 *   不含 `bg-warn-deep`。
 * - 超过阈值（count > limit）：文案「超出仅提示，提交由官方兜底」、class 含 `bg-warn-deep`、
 *   `data-exceeded="true"`。
 * - 默认 limit=5。
 * - 自定义 limit。
 * - count=0 边界。
 * - count=limit 边界（仍属阈值内）。
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformLimitHint } from "./PlatformLimitHint";

function renderHint(props: { count: number; limit?: number }): string {
  return renderToStaticMarkup(
    createElement(PlatformLimitHint, { count: props.count, limit: props.limit }),
  );
}

describe("PlatformLimitHint（视频号软提示徽标）", () => {
  it("count=0 + 默认 limit=5 → 阈值内，'0/5' 徽标 + 文案'本批次累计 0 条定时任务'", () => {
    const html = renderHint({ count: 0 });
    expect(html).toContain('data-slot="platform-limit-hint"');
    expect(html).toContain('data-exceeded="false"');
    expect(html).toContain("bg-warn-tint");
    expect(html).not.toContain("bg-warn-deep");
    expect(html).toContain("0/5");
    expect(html).toContain("本批次累计 0 条定时任务");
  });

  it("count=3 + 默认 limit=5 → 阈值内，'3/5' + 文案'本批次累计 3 条定时任务'", () => {
    const html = renderHint({ count: 3 });
    expect(html).toContain('data-exceeded="false"');
    expect(html).toContain("bg-warn-tint");
    expect(html).not.toContain("bg-warn-deep");
    expect(html).toContain("3/5");
    expect(html).toContain("本批次累计 3 条定时任务");
  });

  it("count=5 + limit=5 → 边界，仍属阈值内", () => {
    const html = renderHint({ count: 5 });
    expect(html).toContain('data-exceeded="false"');
    expect(html).toContain("bg-warn-tint");
    expect(html).not.toContain("bg-warn-deep");
    expect(html).toContain("5/5");
    expect(html).toContain("本批次累计 5 条定时任务");
  });

  it("count=6 + limit=5 → 超过阈值，'6/5' 深黄徽标 + '超出仅提示，提交由官方兜底'", () => {
    const html = renderHint({ count: 6 });
    expect(html).toContain('data-exceeded="true"');
    expect(html).toContain("bg-warn-deep");
    expect(html).not.toContain("bg-warn-tint");
    expect(html).toContain("6/5");
    expect(html).toContain("超出仅提示，提交由官方兜底");
  });

  it("自定义 limit=10 → count=10 仍阈值内、count=11 超阈值", () => {
    const html10 = renderHint({ count: 10, limit: 10 });
    expect(html10).toContain('data-exceeded="false"');
    expect(html10).toContain("10/10");
    expect(html10).toContain("本批次累计 10 条定时任务");
    const html11 = renderHint({ count: 11, limit: 10 });
    expect(html11).toContain('data-exceeded="true"');
    expect(html11).toContain("11/10");
    expect(html11).toContain("超出仅提示，提交由官方兜底");
  });

  it("aria-label 含阈值描述，便于无障碍读屏", () => {
    const html = renderHint({ count: 7, limit: 5 });
    expect(html).toContain('aria-label="超出仅提示');
    expect(html).toContain("7");
    expect(html).toContain("5");
  });
});