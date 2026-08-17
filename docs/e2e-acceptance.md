# PostHub 全链路端到端验收（ticket 11）

一条**可重复运行、无需真实发布凭证、不触发真实发布**的验收线，把 PostHub 的启动壳、
官方后端、各功能页 seam 契约串起来做全链路 smoke。验收点为「**契约级**」（HTTP 状态码、
官方 `{code,msg,data}` 格式、参数校验错误中继、db 自动初始化、壳启停无残留），**不测**
上游 `uploader/*` 内部，也不做真实发布。

## 覆盖的验收点

| 验收项 | 断言 | 位置 |
|--------|------|------|
| 官方后端自动拉起 | 127.0.0.1:5409 TCP 可达 + `/getAccounts` 200 | `daemon/tests/test_e2e_acceptance.py` |
| database.db 自动初始化 | `db/database.db` 存在，`user_info`/`file_records` 表就绪 | 同上 |
| `/getAccounts` 契约 | HTTP 200 + 官方 `{code,msg,data}` 格式，`data` 为数组 | 同上 |
| `/getFiles` 契约 | HTTP 200 + 官方格式 | 同上 |
| `/postVideo` 校验错误中继 | 空/缺参 → 官方 400 + `code:400` + 非空 `msg` | 同上 |
| `/postVideoBatch` 契约 | 非数组请求体 → 官方 400 拒绝 | 同上 |
| `/deleteFile` 契约 | 非法 `id` → 官方 400 校验错误中继 | 同上 |
| 素材链往返 | `/uploadSave` → `/getFiles` 可见 → `/deleteFile` 移除 | 同上 |
| `/downloadCookie` 契约 | 缺 `filePath` → HTTP 400 + 官方 `{code,msg,data}` 中继 | 同上 |
| 壳启停无残留 | spawn → 就绪 → 退出 → 5409 端口释放、无 `run_backend.py` 残留 | `scripts/dev-shell-verify.sh` |
| 前端 seam 契约单测 | `parseSse*`/`getAccounts`/`postVideo` 等 URL/格式解析 | `web/src/api/official.test.ts` 等 |

> `/login`(SSE) 不上自动链：官方 Flask dev server 对流式响应不 flush headers，
> 且二维码/结果帧需真人扫码与真实浏览器，无法在「不触发真实扫码」前提下稳定验证
> SSE framing。其客户端契约（query 构造 + `parseSseDataLine`/`parseSseChunk`/
> `parseSsePayload` 解析）由前端 `official.test.ts` 单测覆盖。

## 运行验收线

```bash
bash scripts/e2e-acceptance.sh    # 仓库根执行
```

脚本依次：
1. 在 **daemon** 目录 `uv run pytest -q` —— 跑契约 smoke（含 `test_e2e_acceptance.py`）。
2. `bash scripts/dev-shell-verify.sh` —— 跑壳启停验收。
3. 在 **web** 目录 `pnpm test` —— 跑前端 seam 契约单测。

### 为什么可重复 / 无需真实凭证

- 契约 smoke 在**隔离临时 BASE_DIR 目录**启动官方后端（`POSTHUB_BASE_DIR` 指向 pytest
  tmp），不触碰仓库 `daemon/db/`，也不读任何真实 cookie 凭证。
- `/postVideo` 只走官方**参数校验失败**分支（缺 `fileList` 等即 400 返回，不会进入发布）；
  `/postVideoBatch` 只走**请求级错误**分支。不遗留数据库/磁盘副作用（素材链测试完毕即删除）。

### 单独运行各段

```bash
# 仅契约 smoke（daemon 后端 + db 初始化 + postVideo 错误中继 + 素材链）
cd daemon && uv run pytest tests/test_e2e_acceptance.py -v

# 仅壳启停（spawn → 退出 → 5409 无残留）
bash scripts/dev-shell-verify.sh

# 前端 seam 契约单测
cd web && pnpm test
```

## 前置

- 端口 5409 空闲（验收线会自行拉起/退出后端子进程；如被占用会失败并提示释放）。
- daemon 依赖已安装：`cd daemon && uv sync`。
- 前端依赖已安装：`cd web && pnpm install`。
