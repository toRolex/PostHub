import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const browserContract = readFileSync(
  resolve(process.cwd(), "prototypes/batch-run-contract.js"),
  "utf8",
);
const moduleContract = readFileSync(
  resolve(process.cwd(), "src/prototypes/batchRunContract.js"),
  "utf8",
);

describe("批量 run 共享浏览器契约", () => {
  it("TSX 与 standalone 使用完全相同的纯 JavaScript contract", () => {
    expect(moduleContract).toBe(browserContract);
    expect(() => new vm.Script(browserContract)).not.toThrow();
  });
});
