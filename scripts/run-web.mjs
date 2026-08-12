// 在任意 cwd 下定位 web/ 并跑 pnpm 命令，供 tauri.conf beforeDev/BuildCommand 使用。
// tauri CLI 版本/运行 cwd 差异可能导致相对路径失效，脚本内用绝对路径解析规避。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const cmd = process.argv[2] ?? "build";
const child = spawn("pnpm", ["run", cmd], {
  cwd: web,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
