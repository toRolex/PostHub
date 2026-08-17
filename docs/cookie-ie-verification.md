# Cookie 导入/导出 —— 直连官方后端独立验证指引（ticket 06）

本票的 cookie 导入/导出能力只依赖官方后端 seam（P 组能力基座），与登录 SSE
（t05）、文件页（t07）完全并行，可在直连官方后端进程下独立验证。

## 前置

- 官方后端已在 `127.0.0.1:5409` 运行（`daemon/run_backend.py`，数据库自动初始化）。
  未运行时先用 uv 启动：

  ```bash
  cd daemon
  uv run python run_backend.py
  ```

## 后端可直连验证（curl 层面）

`user_info` 表结构（官方 db/createTable.py，db_init.py 幂等建表）：

| 列 | 说明 |
|---|---|
| `id` | 主键 |
| `type` | 平台：1 小红书 / 2 视频号 / 3 抖音 / 4 快手 |
| `filePath` | cookie 文件名（`BASE_DIR/cookiesFile/` 下的相对路径，如 `xxx.json`） |
| `userName` | 账号会话名 |
| `status` | 1 有效 / 0 失效 |

### 1. 找一个可操作的账号

```bash
curl -s http://127.0.0.1:5409/getAccounts
# → {"code":200,"msg":null,"data":[[id,type,filePath,userName,status], ...]}
```

空表时先通过官方 `/login`（SSE）登录产生一行，或用 SQL 直接插入一行测试：

```bash
# daemon 目录下（uv run）
uv run python -c "
import sqlite3
from pathlib import Path
conn = sqlite3.connect(Path('db/database.db'))
try:
    conn.execute(\"INSERT INTO user_info (type, filePath, userName, status) VALUES (3, 'demo.json', 'demo', 0)\")
    conn.commit()
    print('inserted demo row id =', conn.execute('SELECT last_insert_rowid()').fetchone()[0])
finally:
    conn.close()
"
```

> 注：`/downloadCookie` 会读取对应 `filePath` 的文件，且路径必须存在于
> `cookiesFile/` 下（不存在返回 404 前先确保文件存在）。

### 2. 导出 cookie（/downloadCookie）

```bash
curl -sOJ "http://127.0.0.1:5409/downloadCookie?filePath=/path/to/xxx.json"
# -OJ 按响应 Content-Disposition 保存附件；成功得到 .json 文件
```

### 3. 导入 cookie（/uploadCookie）

```bash
curl -s -X POST http://127.0.0.1:5409/uploadCookie \
  -F "file=@/path/to/cookie.json" \
  -F "id=<user_info.id>" \
  -F "platform=<官方type 1/2/3/4>"
# → {"code":200,"msg":"Cookie文件上传成功","data":null}
```

校验导入后的账号可用：

```bash
curl -s http://127.0.0.1:5409/getValidAccounts
# 逐个 check_cookie，失效行会被置 status=0
```

## 前端验证

```bash
cd web
pnpm build   # tsc --noEmit + vite build，typecheck + 打包
pnpm test    # vitest run（含 stores/cookies.test.ts 9 项）
```

浏览器手测：`pnpm dev` 后在「账号」页展开 **Cookie 导入/导出（官方后端）** 区段：

- 列表来自 `/getAccounts`（user_info 全行）
- 行内「导入」选 `.json` → `/uploadCookie`
- 「校验全部」→ `/getValidAccounts`，失效行标记为失效
- 行内「导出」→ `/downloadCookie` 下载附件

> 前端 base url 由桌面壳注入 `http://127.0.0.1:5409`；纯浏览器独立验证时
> Vite 默认 `5173` 端口若与后端有 CORS 限制，官方后端已开 `CORS(app)` 放行，
> 可直接直连。

## 已实现文件

- `web/src/api/client.ts`：新增官方 seam 方法（`officialAccounts` /
  `officialValidAccounts` / `uploadCookie` / `downloadCookie`）与 `officialRequest` 包装
- `web/src/api/types.ts`：`OfficialAccountRow`（官方数组行）、`CookiedAccount` 及
  `OfficialPlatform` / `OfficialCookieStatus` 联合类型
- `web/src/api/platformNames.ts`：`OFFICIAL_PLATFORM_NAMES`（官方 type → 中文名）
- `web/src/stores/cookies.ts`：cookie 导入/导出 store（导入成功自动触发一次校验）
- `web/src/components/CookieManager.tsx`：账号页内独立 cookie 区段
- `web/src/stores/cookies.test.ts`：9 项 vitest 覆盖