#!/usr/bin/env bash
# PostHub Issue #100 最终验收线（本地可重复部分）。
#
# 覆盖自动化门（不触发真实发布、无需真实凭证）：
#   1. 契约 smoke：隔离临时 BASE_DIR 启动官方后端 → 探活 5409 → 断言官方 code 格式、
#      db 自动建表、/postVideo 校验错误、/postRuns accepted、/postVideoBatch=410 与素材链往返。
#   2. 壳启停：spawn 官方后端 → 探活就绪 → 退出 → 断言 5409 无残留进程。
#   3. web seam/domain tests + typecheck/build。
#
# 用法: bash scripts/e2e-acceptance.sh   （需在仓库根执行）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="${REPO}/daemon"
WEB="${REPO}/web"

log() { echo "[e2e] $*"; }

log "step 1/4: 契约级后端 smoke（daemon pytest，含 Issue 100 gate）"
( cd "${DAEMON}" && uv run pytest -q )

log "step 2/4: 壳启停验收（无残留 5409 进程）"
bash "${REPO}/scripts/dev-shell-verify.sh"

log "step 3/4: 前端 seam/domain 单测"
( cd "${WEB}" && pnpm test -- --run )

log "step 4/4: 前端 typecheck/build"
( cd "${WEB}" && pnpm run build )

log "本地自动化验收通过"
