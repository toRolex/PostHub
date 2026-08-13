# Changelog

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
