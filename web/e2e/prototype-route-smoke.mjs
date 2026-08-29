#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const HOST = "127.0.0.1";
const DEV_PORT = 5193;
const PREVIEW_PORT = 4193;
const STORAGE_KEY = "posthub-prototype-batch-run-v1";

const FORBIDDEN_PRODUCTION_MARKERS = [
  "BatchRunUiPrototype",
  "TimePickerPrototype",
  "批量发布结果工作台",
  "手机闹钟式定时时间选择器",
  "batch-run-state-machine",
];

function buildProduction() {
  const result = spawnSync("pnpm", ["run", "build"], {
    cwd: WEB_ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`fresh production build 失败\n${result.stdout}\n${result.stderr}`);
  }
}

function start(command, args, label) {
  const child = spawn(command, args, {
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  return { child, label, logs };
}

async function waitForServer(server, url) {
  const deadline = Date.now() + 20_000;
  let lastError = "尚未连接";
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `${server.label} 在就绪前退出（code=${server.child.exitCode}）\n${server.logs.join("")}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const processIsReady = server.logs.join("").includes("Local:");
      if (response.ok && processIsReady) return;
      lastError = response.ok ? "Vite 子进程尚未报告就绪" : `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(
    `${server.label} 未就绪：${url}\n最后错误：${lastError}\n${server.logs.join("")}`,
  );
}

async function stop(server) {
  const child = server.child;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}

async function goto(page, url) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  assert(response, `${url} 没有 navigation response`);
  assert(response.ok(), `${url} 返回 HTTP ${response.status()}`);
}

function trackPageErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

function assertNoPageErrors(errors, label) {
  assert.deepEqual(errors, [], `${label} 出现浏览器错误：\n${errors.join("\n")}`);
}

async function installSeamCounters(context) {
  await context.addInitScript(() => {
    globalThis.__POSTHUB_SMOKE__ = { tauriInvokes: 0 };
    globalThis.__TAURI_INTERNALS__ = {
      invoke: async () => {
        globalThis.__POSTHUB_SMOKE__.tauriInvokes += 1;
        return "http://127.0.0.1:5409";
      },
    };
  });
}

async function mockDaemon(context, daemonRequests) {
  await context.route("http://127.0.0.1:5409/**", async (route) => {
    daemonRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code: 0, data: [] }),
    });
  });
}

async function assertPrototypeIsolation(page, daemonRequests, label) {
  const tauriInvokes = await page.evaluate(() => globalThis.__POSTHUB_SMOKE__.tauriInvokes);
  assert.equal(tauriInvokes, 0, `${label} 不应调用 Tauri invoke`);
  assert.deepEqual(daemonRequests, [], `${label} 不应请求 daemon`);
}

async function verifyDevPrototypeRoutes(browser, devBase) {
  for (const [query, heading] of [
    ["?prototype=time-picker&variant=A", "手机闹钟式定时时间选择器"],
    ["?prototype=time-picker&variant=B", "手机闹钟式定时时间选择器"],
    ["?prototype=time-picker&variant=C", "手机闹钟式定时时间选择器"],
    ["?prototype=batch-run&variant=A", "批量发布结果工作台"],
    ["?prototype=batch-run&variant=B", "批量发布结果工作台"],
    ["?prototype=batch-run&variant=C", "批量发布结果工作台"],
  ]) {
    const context = await browser.newContext();
    const daemonRequests = [];
    await installSeamCounters(context);
    await mockDaemon(context, daemonRequests);
    const page = await context.newPage();
    const errors = trackPageErrors(page);
    await goto(page, `${devBase}${query}`);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await assertPrototypeIsolation(page, daemonRequests, query);
    assertNoPageErrors(errors, query);
    await context.close();
  }
}

function runHeader(page) {
  return page
    .getByRole("heading", { name: "批量发布 · 春游与夜市" })
    .locator("xpath=ancestor::div[.//span[contains(@class, 'font-mono')]][1]");
}

async function verifyBatchRunWiring(browser, devBase) {
  const context = await browser.newContext();
  const daemonRequests = [];
  await installSeamCounters(context);
  await mockDaemon(context, daemonRequests);
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  await goto(page, `${devBase}?prototype=batch-run&variant=B`);

  await page.getByRole("button", { name: "409 冲突" }).click();
  await page.getByRole("button", { name: "查看 run-099" }).click();
  await page.getByText("已打开 synthetic run-099", { exact: true }).waitFor();
  assert.match(await runHeader(page).textContent(), /run-099/);

  await page.getByRole("button", { name: "部分成功" }).click();
  await page.getByRole("button", { name: "重试全部可重试项（3）", exact: true }).click();
  await page.getByText(/已创建 synthetic run-102，parentRunId=run-101/).waitFor();
  const retryHeader = await runHeader(page).textContent();
  assert.match(retryHeader, /run-102/);
  assert.match(retryHeader, /parent: run-101/);

  await assertPrototypeIsolation(page, daemonRequests, "batch-run 交互");
  assertNoPageErrors(errors, "batch-run 交互");

  await page.getByRole("button", { name: "退出原型" }).click();
  await page.getByText("PostHub", { exact: true }).waitFor();
  const url = new URL(page.url());
  for (const parameter of ["prototype", "variant", "runId"]) {
    assert.equal(url.searchParams.has(parameter), false, `退出后仍含 ${parameter}`);
  }
  await context.close();
}

async function verifyDevFallbackRoutes(browser, devBase) {
  for (const query of ["", "?prototype=unknown"]) {
    const context = await browser.newContext();
    const daemonRequests = [];
    await mockDaemon(context, daemonRequests);
    const page = await context.newPage();
    const errors = trackPageErrors(page);
    await goto(page, `${devBase}${query}`);
    await page.getByText("PostHub", { exact: true }).waitFor();
    await page.getByText("守护进程", { exact: false }).first().waitFor();
    assert(daemonRequests.length > 0, `${query || "普通 URL"} 应初始化正式 AppShell`);
    assertNoPageErrors(errors, query || "普通 URL");
    await context.close();
  }
}

async function standalonePage(browser, devBase, configure) {
  const context = await browser.newContext();
  if (configure) await configure(context);
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  return { context, page, errors, url: `${devBase}prototypes/batch-run-state-machine.html` };
}

async function expectStandaloneAlert(browser, devBase, configure, expected, action) {
  const { context, page, errors, url } = await standalonePage(browser, devBase, configure);
  await goto(page, url);
  if (action) await page.locator(`[data-action="${action}"]`).click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  assert.match(await alert.textContent(), expected);
  const expectedScriptError = expected.source.includes("原型加载错误");
  const expectedContractRequestError = expected.source.includes("请求失败");
  const unexpectedErrors = errors.filter((message) => {
    if (expectedScriptError && message.includes("Unexpected token")) return false;
    if (expectedContractRequestError && message.includes("Failed to load resource")) return false;
    return true;
  });
  assertNoPageErrors(unexpectedErrors, `standalone alert ${expected}`);
  await context.close();
}

async function verifyStandalone(browser, devBase) {
  {
    const { context, page, errors, url } = await standalonePage(browser, devBase);
    await goto(page, url);
    await page.getByRole("button", { name: "模拟恢复快照" }).click();
    await page.getByText("没有可模拟恢复的快照", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").isVisible(), false);
    assertNoPageErrors(errors, "standalone 无快照");
    await context.close();
  }

  {
    const { context, page, errors, url } = await standalonePage(browser, devBase);
    await goto(page, url);
    await page.getByRole("heading", { name: "批量 run 状态机" }).waitFor();
    await page.getByText("run-101", { exact: true }).first().waitFor();

    await page.getByRole("button", { name: "保存 synthetic 快照" }).click();
    await page.getByRole("button", { name: "409 后查看 run-099" }).click();
    await page.getByText("run-099", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "模拟恢复快照" }).click();
    await page.getByText("run-101", { exact: true }).first().waitFor();

    await page.getByRole("button", { name: "写入损坏快照" }).click();
    await page.getByRole("button", { name: "模拟恢复快照" }).click();
    assert.match(await page.getByRole("alert").textContent(), /快照 JSON 已损坏/);
    assertNoPageErrors(errors, "standalone 正常与损坏 JSON");
    await context.close();
  }

  await expectStandaloneAlert(
    browser,
    devBase,
    (context) => context.route("**/batch-run-contract.js", (route) => route.fulfill({ status: 404, body: "missing" })),
    /共享 contract 请求失败/,
  );
  await expectStandaloneAlert(
    browser,
    devBase,
    (context) => context.route("**/batch-run-contract.js", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "function {" })),
    /原型加载错误/,
  );
  await expectStandaloneAlert(
    browser,
    devBase,
    (context) => context.route("**/batch-run-contract.js", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "globalThis.UnexpectedContract = {};" })),
    /未导出预期接口/,
  );

  for (const [snapshot, expected] of [
    [{ version: 0, run: {} }, /不支持的快照版本/],
    [{ version: 1, run: { runId: "run-101", status: "running", items: [] } }, /模拟恢复 run-101/],
    [{ version: 1, run: { runId: "run-101", status: "running", items: [{ id: "1", file: "a.mp4", platform: "douyin", scheduled: "今天", status: "pending" }] } }, /account/],
    [{ version: 1, run: { runId: "run-101", status: "running", items: [{ id: "1", file: "a.mp4", platform: "douyin", account: "主号", status: "pending" }] } }, /scheduled/],
    [{ version: 1, run: { runId: "run-101", status: "running", items: [{ id: "1", file: "a.mp4", account: "主号", scheduled: "今天", status: "pending" }] } }, /platform/],
    [{ version: 1, run: { runId: "run-101", status: "running", items: [{ id: "1", file: "a.mp4", platform: "kuaishou", account: "主号", scheduled: "今天", status: "pending" }] } }, /kuaishou/],
    [{ version: 1, run: { runId: "run-101", status: "running", items: [
      { id: "1", file: "a.mp4", platform: "douyin", account: "主号", scheduled: "今天", status: "pending" },
      { id: "1", file: "b.mp4", platform: "wechat", account: "运营号", scheduled: "明天", status: "pending" },
    ] } }, /重复 item ID/],
  ]) {
    const { context, page, errors, url } = await standalonePage(browser, devBase);
    await goto(page, url);
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [STORAGE_KEY, JSON.stringify(snapshot)],
    );
    await page.getByRole("button", { name: "模拟恢复快照" }).click();
    if (expected.source.startsWith("模拟恢复")) {
      await page.getByText(expected).waitFor();
    } else {
      assert.match(await page.getByRole("alert").textContent(), expected);
    }
    assertNoPageErrors(errors, `standalone snapshot ${expected}`);
    await context.close();
  }

  await expectStandaloneAlert(
    browser,
    devBase,
    (context) => context.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error("get denied"); };
    }),
    /localStorage 不可用（读取）.*get denied/s,
    "restore",
  );
  await expectStandaloneAlert(
    browser,
    devBase,
    (context) => context.addInitScript(() => {
      Storage.prototype.setItem = () => { throw new Error("set denied"); };
    }),
    /localStorage 不可用（写入）.*set denied/s,
    "save",
  );
}

async function verifyProduction(browser, previewBase) {
  const context = await browser.newContext();
  const daemonRequests = [];
  await mockDaemon(context, daemonRequests);
  const page = await context.newPage();
  const errors = trackPageErrors(page);

  await goto(page, `${previewBase}?prototype=batch-run&variant=C`);
  await page.getByText("PostHub", { exact: true }).waitFor();
  assert.equal(await page.getByText("批量发布结果工作台", { exact: true }).count(), 0);
  assert(daemonRequests.length > 0, "production 应初始化正式 AppShell");
  assertNoPageErrors(errors, "production preview");

  await goto(page, `${previewBase}prototypes/batch-run-state-machine.html`);
  await page.getByText("PostHub", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-prototype="batch-run-state-machine"]').count(), 0);
  assert.equal(await page.getByRole("heading", { name: "批量 run 状态机" }).count(), 0);
  assertNoPageErrors(errors, "production standalone URL");
  await context.close();

  const artifactPaths = [
    resolve(WEB_ROOT, "dist/index.html"),
    ...(await readdir(resolve(WEB_ROOT, "dist/assets"))).map((name) =>
      resolve(WEB_ROOT, "dist/assets", name),
    ),
  ];
  for (const artifactPath of artifactPaths) {
    const content = await readFile(artifactPath, "utf8");
    for (const marker of FORBIDDEN_PRODUCTION_MARKERS) {
      assert.equal(content.includes(marker), false, `${artifactPath} 不应包含 ${marker}`);
    }
  }
}

async function main() {
  buildProduction();
  const browser = await chromium.launch();
  try {
    const dev = start("pnpm", ["exec", "vite", "--host", HOST, "--port", String(DEV_PORT), "--strictPort"], "Vite DEV");
    try {
      const devBase = `http://${HOST}:${DEV_PORT}/`;
      await waitForServer(dev, devBase);
      await verifyDevPrototypeRoutes(browser, devBase);
      await verifyBatchRunWiring(browser, devBase);
      await verifyDevFallbackRoutes(browser, devBase);
      await verifyStandalone(browser, devBase);
    } finally {
      await stop(dev);
    }

    const preview = start("pnpm", ["exec", "vite", "preview", "--host", HOST, "--port", String(PREVIEW_PORT), "--strictPort"], "Vite preview");
    try {
      const previewBase = `http://${HOST}:${PREVIEW_PORT}/`;
      await waitForServer(preview, previewBase);
      await verifyProduction(browser, previewBase);
    } finally {
      await stop(preview);
    }
  } finally {
    await browser.close();
  }

  console.log("prototype browser smoke: passed");
}


main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
