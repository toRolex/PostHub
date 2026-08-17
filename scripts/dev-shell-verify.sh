#!/usr/bin/env bash
# posthub 壳 spawn/退出 本地端到端验证（不经打包 release 二进制）：
# 模拟 lib.rs spawn_daemon 的精确形态：daemon 为 cwd + uv run run_backend.py。
# 用法: bash scripts/dev-shell-verify.sh   （需要在仓库根执行）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="${REPO}/daemon"
PORT=5409
URL="http://127.0.0.1:${PORT}/getAccounts"

log() { echo "[verify] $*"; }

# 0) 前置：5409 空闲
if lsof -ti tcp:${PORT} >/dev/null 2>&1; then
  log "端口 ${PORT} 被占用，先释放：已存在的后端进程？"
  exit 1
fi

# 1) spawn（与 Rust 壳一致：daemon 目录为 cwd）
log "spawn: cd ${DAEMON} && uv run run_backend.py"
cd "${DAEMON}"
uv run run_backend.py > /tmp/posthub-verify.log 2>&1 &
CHILD=$!
log "spawned pid=${CHILD}"

# 2) 轮询就绪（探 /getAccounts 2xx，最多 30s）
ready=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 1 "${URL}" 2>/dev/null || true)
  if [ "${code}" = "200" ]; then ready=1; log "后端就绪：${URL} 200（探活第 ${i} 次）"; break; fi
  sleep 0.5
done
if [ "${ready}" != "1" ]; then
  log "后端 30s 内未就绪。日志："; tail -20 /tmp/posthub-verify.log || true
  kill "${CHILD}" 2>/dev/null || true
  exit 1
fi

# 3) 进程树可见性（应有 uv 与 daemon 内 python）
log "进程树："
pgrep -fl "run_backend.py" || true

# 4) 退出：killer == 壳 RunEvent::Exit 的 child.kill()
log "kill ${CHILD}（模拟点叉退出）"
kill "${CHILD}" 2>/dev/null || true
sleep 2

# 5) 断言端口释放 + 进程消失
if lsof -ti tcp:${PORT} >/dev/null 2>&1; then
  log "FAIL: ${PORT} 仍被监听"
  exit 1
fi
if pgrep -fl "run_backend.py" >/dev/null 2>&1; then
  log "FAIL: run_backend.py 进程残留"
  exit 1
fi
log "PASS: 退出后 ${PORT} 端口释放、无 run_backend.py 残留进程"