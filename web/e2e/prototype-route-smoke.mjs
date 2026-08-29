#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const HOST = "127.0.0.1";
const DEV_PORT = 5193;
const PREVIEW_PORT = 4193;

const FORBIDDEN_PRODUCTION_MARKERS = [
  "BatchRunUiPrototype",
  "TimePickerPrototype",
  "批量发布结果工作台",
  "手机闹钟式定时时间选择器",
  "batch-run-state-machine",
];

function start(command, args) {
  const child = spawn(command, args, {
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function fetchWithTimeout(url, timeoutMs = 5_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, 1_000);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`服务未就绪：${url}`);
}

async function requestText(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
  return response.text();
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) throw new Error(`${label} 缺少 ${expected}`);
}

function assertExcludes(value, expected, label) {
  if (value.includes(expected)) throw new Error(`${label} 不应包含 ${expected}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  let timer;
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(false), 2_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}

async function main() {
  const dev = start("pnpm", ["exec", "vite", "--host", HOST, "--port", String(DEV_PORT), "--strictPort"]);
  try {
    const devBase = `http://${HOST}:${DEV_PORT}/`;
    await waitFor(devBase);
    const standalone = await requestText(`${devBase}prototypes/batch-run-state-machine.html`);
    assertIncludes(standalone, "PostHub Logic 原型：批量 run 状态机", "standalone HTML");
    assertIncludes(standalone, 'data-prototype="batch-run-state-machine"', "standalone HTML");

    const timePickerModule = await requestText(`${devBase}src/prototypes/TimePickerPrototype.tsx`);
    const batchRunModule = await requestText(`${devBase}src/prototypes/BatchRunUiPrototype.tsx`);
    assertIncludes(timePickerModule, "TimePickerPrototype", "DEV time-picker module");
    assertIncludes(batchRunModule, "BatchRunUiPrototype", "DEV batch-run module");
  } finally {
    await stop(dev);
  }

  const preview = start("pnpm", ["exec", "vite", "preview", "--host", HOST, "--port", String(PREVIEW_PORT), "--strictPort"]);
  try {
    const previewBase = `http://${HOST}:${PREVIEW_PORT}/`;
    await waitFor(previewBase);
    const index = await requestText(`${previewBase}?prototype=batch-run&variant=C`);
    assertIncludes(index, '<div id="root"></div>', "production preview");
    const standaloneResponse = await fetchWithTimeout(`${previewBase}prototypes/batch-run-state-machine.html`);
    const standalonePreview = await standaloneResponse.text();
    assertExcludes(
      standalonePreview,
      'data-prototype="batch-run-state-machine"',
      "production preview standalone URL",
    );

    const assets = await readdir(resolve(WEB_ROOT, "dist/assets"));
    for (const name of assets) {
      const content = await readFile(resolve(WEB_ROOT, "dist/assets", name), "utf8").catch(() => "");
      for (const marker of FORBIDDEN_PRODUCTION_MARKERS) {
        assertExcludes(content, marker, `dist/assets/${name}`);
      }
    }
  } finally {
    await stop(preview);
  }

  console.log("prototype route smoke: passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
