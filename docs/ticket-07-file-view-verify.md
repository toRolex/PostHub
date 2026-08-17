# 文件页独立验证指引（ticket 07）

文件页（`web/src/views/FileView.tsx`）对接**官方后端 seam**（`daemon/sau_backend.py`，P2 起
已随官方后端跑在 `127.0.0.1:5409`），不依赖自研 daemon REST（`/files`、`/tasks` 等），因此可在
**直连官方后端进程**下独立验证。

## 前提

1. `daemon/` 的官方后端已在 `127.0.0.1:5409` 跑起来（`uv run python run_backend.py`，P4 桌面壳会拉起；
   本机手动验证时可自行启动或用 `daemon/db_init.py` 保证 db）。
2. 前端 base url 走 `stores/daemon.ts` 的 `DEFAULT_DAEMON_URL = http://127.0.0.1:5409`（P4 已放行 CSP）。

## 手动验证步骤

```bash
cd web
pnpm dev            # 浏览器打开 http://localhost:5173
```

侧边栏进入「文件」页：

- **列表**：官方 `GET /getFiles` 返回 `file_records` 全量并渲染为表格（类型 / 名称 / 大小 / 上传时间 /
  操作）。
- **上传**：点「选择视频 / 图片」选一个本地视频，走 `POST /uploadSave`（multipart `file`），成功后 toast
  提示并从列表看到新记录；磁盘上 `daemon/videoFile/<uuid>_<原名>` 也会出现该文件。
- **删除**：点行内「删除」，走 `GET /deleteFile?id=N`，磁盘文件与 db 记录同时删除，列表即时移除。

## 直连验证（无 Tauri 壳）

`web/` 作为独立 Vite 页面直连 `127.0.0.1:5409` 即可；上传走真实官方 seam，不经过 shell IPC。
`web/e2e/qa-e2e.js` 是既有 e2e 占位，本票未扩展（聚焦官方契约单测已覆盖 store 层交互与错误分支）。

## 契约要点（daemon/sau_backend.py）

| seam | 方法 | 请求 | 响应 `data` |
|------|------|------|-------------|
| `/uploadSave` | POST | multipart `file`；可选 `filename` | `{filename, filepath}`（code=200） |
| `/getFiles` | GET | 无 | 数组：`{id, filename, filesize(MB), upload_time, file_path, uuid}` |
| `/deleteFile` | GET | `?id=<数字>` | `{id, filename}` |
| `/getFile` | GET | `?filename=<file_path>` | 文件内容（预览/下载） |

> `filesize` 单位是 MB（上传时 `round(os.path.getsize(...)/1024/1024, 2)`）。`filename` 不带 uuid 前缀，
> `file_path` 是与磁盘 `videoFile/` 一致的完整文件名，`uuid` 是官方从 `file_path` 提的第一个下划线前缀。
> 前端以此展示元数据并用 `file_path` 拼接 `/getFile` 预览地址。