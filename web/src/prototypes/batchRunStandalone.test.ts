import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const htmlPath = resolve(process.cwd(), "prototypes/batch-run-state-machine.html");
const html = readFileSync(htmlPath, "utf8");

function inlineScripts(source: string): string[] {
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1],
  );
}

describe("standalone Logic 原型", () => {
  it("有独立页面标识，不会把 SPA fallback 当成原型", () => {
    expect(html).toContain("<title>PostHub Logic 原型：批量 run 状态机</title>");
    expect(html).toContain('data-prototype="batch-run-state-machine"');
  });

  it("所有内联脚本都是浏览器可解析的纯 JavaScript", () => {
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) {
      expect(() => new vm.Script(source)).not.toThrow();
    }
  });

  it("提供加载错误、storage 错误与快照清理反馈", () => {
    expect(html).toContain('id="prototypeError"');
    expect(html).toContain('<script src="./batch-run-contract.js"></script>');
    expect(html).toContain("const STORAGE_VERSION = 1");
    expect(html).toContain("candidate.version !== STORAGE_VERSION");
    expect(html).toContain("localStorage 不可用");
    expect(html).toContain("清理损坏快照");
    expect(html).toContain("模拟恢复");
  });
});
