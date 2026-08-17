#!/usr/bin/env bash
# PostHub ticket 11「验收：全链路端到端 smoke」一键验收线（可重复运行）。
#
# 覆盖两级验收（不触发真实发布、无需真实凭证）：
#   1. 契约 smoke：隔离临时 BASE_DIR 启动官方后端 → 探活 5409 → 断言官方 code 格式、
#      db 自动建表、/postVideo 校验错误中继、/uploadSave→/getFiles→/deleteFile 素材链往返。见 daemon/tests/test_e2e_acceptance.py。
#   2. 壳启停：spawn 官方后端 → 探活就绪 → 退出 → 断言 5409 无残留进程。见 scripts/dev-shell-verify.sh。
#   前端 seam 契约单测（web/src/api/official.test.ts 等）单独用 pnpm test 跑，不改数据。
#
# 用法: bash scripts/e2e-acceptance.sh   （需在仓库根执行）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="${REPO}/daemon"
WEB="${REPO}/web"

log() { echo "[e2e] $*"; }

log "step 1/3: 契约级后端 smoke（daemon pytest，含 test_e2e_acceptance.py）"
( cd "${DAEMON}" && uv run pytest -q )

log "step 2/3: 壳启停验收（无残留 5409 进程）"
bash "${REPO}/scripts/dev-shell-verify.sh"

log "step 3/3: 前端 seam 契约单测（pnpm test）"
( cd "${WEB}" && pnpm test )

log "全部验收通过 ✅"
