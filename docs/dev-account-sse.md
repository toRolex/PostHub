# 账号页：官方 seam 对接 + 扫码登录（SSE）实测记录

ticket/05 实测结论。范围：账号页直连官方后端（`daemon/sau_backend.py:5409`），扫码登录走官方
`/login` SSE，账号列表/删除走官方 `/getAccounts` `/getValidAccounts` `/deleteAccount`。

## 官方 seam 契约（源码 + 实测确认）

### `/login`（轮询式 SSE）

- 请求：`GET /login?type=<1|2|3|4>&id=<账号名>`
  - `type`：1 小红书 · 2 视频号 · 3 抖音 · 4 快手（`sau_backend.py:387` 注释）
  - `id` = 账号名，成功登录后写入 `user_info.userName`
- 响应：`Content-Type: text/event-stream`，每条消息 `data: <payload>\n\n`
- 事件序列（源码 `myUtils/login.py` + 实测）：
  1. 首帧：二维码 src —— base64 data URL（实测 `data:image/png;base64,...`）或普通 URL
  2. 登录成功：`data: 200`（随后 `INSERT INTO user_info` 并落盘 cookie）
  3. 失败/超时：`data: 500`
- **轮询式 = 每产生一个状态就推一帧**，不是定时心跳。实测流建立后先推 1 帧二维码，
  然后保持连接等待结果帧（200/500）。
- 浏览器拉起：官方 `get_browser_options()` 优先用 `conf.LOCAL_CHROME_PATH`（本机 Chrome），
  未配置时用 playwright 自带 chromium（需 `uv run playwright install chromium`）。

### `/getAccounts` / `/getValidAccounts`

- 均 `GET`，返回 `{code, data: [[id, type, filePath, userName, status], ...], msg}`
- `getAccounts` 只读库（快）；`getValidAccounts` 逐个 `check_cookie`，失效账号把
  `user_info.status` 落库置 0（**保留该行**，不删）。因此「有效性」判断应依据 `status===1`，
  而不能用「是否出现在返回里」。
- 实测（空库）：`{"code":200,"data":[],"msg":null}`

### `/deleteAccount`

- `GET /deleteAccount?id=<int>`；删除关联 cookie 文件 + 数据库行
- 不存在 id 返回 `404 {"code":404,"msg":"account not found","data":null}`

## 前端实现

- `web/src/api/official.ts`：官方 seam 客户端
  - `openLoginSse({url,type,accountName})`：fetch 流式读取 + `parseSseChunk` 增量解析；
    返回 `{readQr, readResult, abort}`。`abort()` 用于用户关闭 dialog 时立即断开。
  - `getAccounts` / `getValidAccounts` / `deleteAccount`：官方响应体 `{code,msg,data}` 解析。
- `web/src/stores/accounts.ts`：
  - `fetchAccounts`：`getAccounts`（列表）+ `getValidAccounts`（合并 cookie 有效态）并行拉取
  - `mapDaoAccount`：口径 `row.status===1` -> `cookieValid`；`validAccountIds` 仅统计有效 id
  - `removeAccount`：官方 `/deleteAccount`，成功后本地移除
- `web/src/views/AccountsView.tsx`：扫码登录 dialog（选平台 + 账号名 -> 连 `/login` SSE ->
  展示 base64 二维码 -> 等 200/500 -> 成功刷新列表）；账号列表展示 cookie 有效性；删除走官方接口。

## SSE 稳定性实测结论（2026-08-18，daemon 5409）

| 场景 | 结果 |
|------|------|
| `/login?type=1`（小红书）建流 | ✅ 立即推首帧 `data: data:image/png;base64,...` 真实抖音/小红书二维码 |
| 连接保持 | ✅ 服务端保持连接不额外发帧，等登录结果（200/500） |
| 客户端主动断开 | ⚠️ `on_close` 清理队列依赖 Flask 关闭回调，实测断开后下一个请求正常；
  残留队列以 `active_queues` 的 id 覆盖为代价（同 id 并发只保留最后一个）。前端不依赖服务端清理，`abort()` 自行断开 |
| 同 id 并发 `/login` | ⚠️ 队列被后者覆盖——**前端禁止同一账号名重复发起登录**；dialog 内重复点击有防御 |
| 无 Chrome 时 | ❌ 后端抛 `BrowserType.launch: Executable doesn't exist`，SSE 连接被 Flask 断开（无帧）；
  需预装 `uv run playwright install chromium` 或配置 `POSTHUB_LOCAL_CHROME_PATH` |

结论：官方 SSE 是「一帧二维码 + 一帧结果」的**两段式事件流**，前端只需：解析 `data:` 帧 ->
首帧当二维码展示 -> 收到 `200`/`500` 即结束。不需要轮询重连——连接建立后一直挂着即可。
前端 `parseSseChunk` 已按「完整消息（空行分隔）」解析，跨网络分片安全（未闭合尾部缓冲续拼）。

## 独立验证指引（不依赖桌面壳）

```bash
# 1) 启动官方后端（daemon/，uv 管理；首次装 playwright chromium）
cd daemon
uv run playwright install chromium          # 仅首次
uv run python run_backend.py                # 监听 127.0.0.1:5409，自动初始化 db

# 2) 启动前端（另开终端）
cd web
pnpm install
pnpm dev                                    # http://127.0.0.1:5173

# 3) 最小 curl 冒烟（不打开页面即可验证 seam）
curl -s http://127.0.0.1:5409/getAccounts                 # {"code":200,"data":[...]}
curl -s "http://127.0.0.1:5409/login?type=3&id=smoke" -N   # 流式：首帧二维码 + ...（需扫码完成）
curl -s "http://127.0.0.1:5409/deleteAccount?id=1"         # 删除 id=1
```

浏览器打开 `http://127.0.0.1:5173`，CSP 已放行 5409（P4），页面「账号」页即为官方账号管理。