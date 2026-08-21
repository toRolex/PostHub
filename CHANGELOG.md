# Changelog

## v0.1.7 (2026-08-21)

### Added
- FileView「上传素材」支持多选：`<input multiple>` + `handleFileChange` 顺序串行上传至官方素材库
- docs/handoffs/2026-08-21-issue-43-handoff.md：归档 issue #43 实现细节、测试结果、待办与文件路径速查

### Notes
- 本轮 bump 仅记录本次新增；v0.1.3~v0.1.6 的 CHANGELOG 条目仍待补（reviewer risk #4），按 ADR/issue 节奏后续 issue 跟进

## v0.1.2 (2026-08-14)

### Fixed
- Windows 每次打开弹终端：uv 子进程 stdio 全量重定向到 `app_data/daemon.log` + `CREATE_NO_WINDOW`（日志落盘顺带让 daemon 失败原因可见）
- 视频号发布报「cookie文件不存在」：CDP 接管账号 Chrome 时把登录态导出为上游要求的 `account_file`（`~/.posthub/cookies/{账号id}.json`）

## v0.1.1 (2026-08-13)

### Fixed
- Windows 首次启动「守护进程未连接」：上游 git 源构建期 wheel 化 + patchright Chromium 预打包 + `UV_PYTHON_INSTALL_DIR` 隔离 managed Python（绕开 `%APPDATA%\uv\python` 不可信 junction，ADR-0004 修订 5）
- Windows 安装包缺失 Chromium：`bundle.resources` 补 `resources/browser`

## v0.1.0 (2026-08-13)

### Added
- 工程脚手架：Tauri 双端托盘壳 + uv 守护进程 + conf 模块 + 执行引擎 seam（#14）
- 账号模型 + 账号管理页：每账号独立 Chrome 调试端口 + CRUD（#15）
- 发布表单 + 平台约束校验 + 任务落库（#16）
- 任务执行引擎 + 调度器 + SQLite 状态机（#17）
- CDP 接管真实 Chrome + 单平台 upload 最小链路（#20）
- manifest 批量导入（#19）
- 任务管理页 + 本地通知 + 应用内日志（#18）
- 兜底交互：人工介入事件 + Tauri 弹窗 + 重登引导（#21）
- 文件选择器 Tauri v2 真实路径
- 前端全量迁移 React（shadcn/ui + Zustand + Tailwind v4）
- Tauri 桌面 mac+win 双端打包：daemon 资源分发 + CI 矩阵

### Changed
- 前端技术栈由 Vue 3 迁移至 React 19（见 ADR-0003）
- 桌面打包决策记录（见 ADR-0004）

### Fixed
- code review 整改：调度器接入运行时 + uploader 参数映射 + 账号关联清理
- CI 双端构建：win cp1252 编码、smoke 模块解析、uv 下载断连、NSIS 下载缓存等
