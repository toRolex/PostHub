# 调研：social-auto-upload 的发布链路是什么，PostHub 能否直接复用原版方案

**日期**：2026-08-18
**来源**：上游仓库 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload`（git HEAD `008e4ff`，与 PostHub `daemon/.venv` 内安装的 `social-auto-upload==0.1.0` + `patchright==1.58.2` 同版本，已用行数比对核实）
**背景**：PostHub 视频号（wechat）发布在 CDP 接管下 `set_input_files` 超时；用户问「上游原版是怎么实现的？不能就安装原版的方案吗」。本次调研回答：上游发布链路、是否支持 CDP 复用、PostHub CDP 接管的初衷与代价、能否直接改回上游原生方案。

---

## 一、结论速览

1. **上游发布链路从始至终都是「每次自起全新浏览器 + `new_context(storage_state=账号cookie)` 注入登录态」**，没有复用已登录浏览器、没有 CDP 接管发布。发完会 `context.storage_state(path=...)` 回写 cookie。
2. **上游对 CDP 只开放了一个口子：抖音 / 快手的「登录扫码」流程支持 `cdp_url`（`connect_over_cdp`）**，用于把二维码打开在用户已登录的账号 Chrome 里；上传/发布流程三平台**都不**支持 CDP。
3. **视频号（tencent_uploader）没有任何 CDP 能力**，登录、cookie 校验、发布全部自起浏览器。
4. PostHub 当初选「CDP 接管发布」是**自创的增强**（ADR-0001 T1 方案 B），不是上游带来的约束。它的价值是「界面打开的就是账号真实 Chrome，登录态天然持久化，免扫码、免 cookie 文件」。
5. **上游原生方案对视频号完全可行且更贴近上游设计**：PostHub 侧的「每账号一台真实 Chrome + 登录态持久化」可以保留为「登录态来源」，发布时从账号 Chrome 导出 `storage_state` → 交给上游自起浏览器注入。这条链路对视频号等价于「把原本应在真实 Chrome 里完成的发布，换成在 cookie 注入的新浏览器里完成」。
6. **唯一需要决策的分歧点**：抖音 / 小红书 / 视频号三平台是「统一走 cookie 注入（B1）」还是「仅视频号切换（B2）」。两者对视频号都是同样可行；B2 侵入更小、不动已验证的抖音/小红书。

---

## 二、上游发布链路（登录 / 发布全流程）

### 2.1 登录（cookie 生成）

每个平台的登录入口是一个 `xxx_cookie_gen`（如 `douyin_cookie_gen` / `tencent_cookie_gen`），流程统一：

1. **自起浏览器**：`async with async_playwright()` → `chromium.launch(headless=...)`。
   - 抖音：`uploader/douyin_uploader/main.py:234`（`chromium.launch(headless=headless, channel="chromium")`）
   - 视频号：`uploader/tencent_uploader/main.py:389`（`chromium.launch(**_build_launch_kwargs(headless=headless))`）
2. **新 context**：`browser.new_context()`（无 storage_state）。
3. **打开登录页 → 展示二维码** → 用户扫码 → 轮询等登录成功。
4. **成功即导出 cookie**：`context.storage_state(path=account_file)`。视频号 `main.py:416`；抖音 `main.py:257`。
5. 关闭浏览器，结束。

> 例外：抖音 / 快手登录入口支持 `cdp_url` 参数，此时走 `connect_over_cdp` 复用账号 Chrome（`douyin main.py:229-232`、`ks_uploader/main.py:203`）。仅用于「把二维码展示在已登录的账号浏览器里」，登录完成后同样 `storage_state(path=...)` 导出。**这个概念与 PostHub 的 CDP 接管同源**。

### 2.2 cookie 校验

- `cookie_auth(account_file)`：自起新浏览器 + `new_context(storage_state=account_file)` → 打开登录后主页 → 判断是否被跳转登录页/出现扫码框。视频号 `main.py:108-136`。
- PostHub 上传前的校验走的就是这条（`CONTEXT.md:112`），不经过任何 CDP patch。

### 2.3 发布

三平台发布方法结构完全一致（`DouYinVideo.upload` / `XiaoHongShuVideo.upload` / `TencentVideo.upload`）：

```python
async def upload(self, playwright: Playwright) -> None:
    await self.validate_upload_args()                       # 校验 cookie/文件/发布时间
    browser = await playwright.chromium.launch(**launch_kwargs)   # 自起新浏览器
    context = await browser.new_context(storage_state=self.account_file)  # 注入 cookie
    page = await context.new_page()
    await self.open_upload_page(page)                        # goto 发布页
    await self.upload_video_file(page, self.file_path)       # 找 input[type=file] → set_input_files
    ... 填标题/标签/封面/定时 ...
    await self.submit_publish(page)
    await context.storage_state(path=self.account_file)      # 回写 cookie
    # finally: context.close() + browser.close()
```

证据：
- 视频号：`uploader/tencent_uploader/main.py:933-962`（launch `938`、new_context `939`、storage_state 回写 `958`）
- 抖音：`uploader/douyin_uploader/main.py:672-690`（launch `677`、new_context `678-680`、storage_state 回写 `801`）
- 小红书：`uploader/xiaohongshu_uploader/main.py:618-632`（launch `622`、new_context `623-625`、storage_state 回写 `632`）

**要点**：发布用的浏览器是 CDP 之外的完全独立浏览器，与任何已登录 Chrome 无连接；登录态完全靠 `storage_state` cookie 文件注入。

### 2.4 驱动

- 上游当前主线用 **`patchright==1.58.2`**（`pyproject.toml:14`），README 明示「主线更换为 patchright 驱动，提升兼容性与隐蔽性」（`README.md` L157）。
- `requirements.txt:47` 仍是旧 `playwright==1.52.0`（README `L129`：requirements 仅历史兼容路径）。
- 两者都是「自起浏览器 + CDP 无关」的 Playwright 驱动，最大的差异是 patchright 会把 `navigator.webdriver` 等自动化特征伪装得更隐蔽。

---

## 三、上游是否支持 CDP / 复用已登录浏览器

| 流程 | 抖音 | 快手 | 小红书 | 视频号 |
|---|---|---|---|---|
| 登录扫码 | ✅ `cdp_url`（`main.py:229`） | ✅ `cdp_url`（`ks:203`） | ❌ | ❌ |
| cookie 校验 | ❌ 自起 | ❌ 自起 | ❌ 自起 | ❌ 自起 |
| 发布/上传 | ❌ 自起 | ❌ 自起 | ❌ 自起 | ❌ 自起 |

- 全仓 `grep connect_over_cdp / connect_to_over_cdp / launch_persistent_context / user_data_dir`：只在 douyin/ks 登录入口出现 `connect_over_cdp`，无 `launch_persistent_context`、无多 profile 复用。
- **结论**：上游对「复用已登录浏览器」只用于登录扫码的便利，**发布流程一律自起浏览器 + cookie 注入**。PostHub 的「CDP 接管账号 Chrome 来发布」是自创增强，上游没有这个用法。

---

## 四、cookie / storage_state 结构

- 登录态持久化 = Playwright `context.storage_state()` 的标准结构 JSON（`cookies` 数组 + `localStorage`/`origins` + `hostPermissions`）。
- 视频号实际验证：生产机 `~/.posthub/cookies/12.json` 为 482B，含 `sessionid` + `wxuin`（handoff 实测），即 `cookies` 数组里的关键字段。
- 上游「登录 → storage_state 导出 → 发布时 storage_state 注入」的闭环依赖的就是这份文件；多账号靠多文件区分（`account_file` 路径，视频号 `_resolve_account_file` `main.py:32-38`）。
- PostHub 的 `context.storage_state(path=account_file)`（`cdp_attach.py:118`）导出的正是同一格式，**格式天然兼容**，可直接交给上游。

---

## 五、PostHub CDP 接管 vs 上游原生方案

| 维度 | PostHub 现状（CDP 接管发布） | 上游原生（自起浏览器 + cookie 注入） |
|---|---|---|
| 登录态来源 | 账号真实 Chrome 的 profile | `account_file` cookie 文件 |
| 发布时浏览器 | `connect_over_cdp` 接管账号 Chrome（连接存续整个发布） | 每次全新浏览器，无长时间 CDP 连接 |
| 渲染风险 | ⚠️ 视频号 CDP 存续期间发布页不渲染（本次 bug 根因） | ✅ 无 CDP 连接，不受此抑制（上游实测可行） |
| 多账号隔离 | 每账号独立 user-data-dir + 独立端口 | 每账号一份 cookie 文件 |
| 登录态失效 | 真实 Chrome profile 天然持久 | cookie 文件可能过期，需 `cookie_auth` 校验 + 重新扫码 |
| 首次登录 | 界面「打开」拉账号 Chrome 扫码，profile 固化 | 需一次 cookie 生成流程（扫码 → storage_state） |
| 侵入面 | patch `chromium.launch/new_context/close`（`cdp_attach.py`） | 无 patch，直接给上游原始 playwright |
| 对上游 | 用得上「登录 cdp_url」概念，但发布路径上游无先例 | 100% 上游原生路径 |

**关键洞察**：PostHub 的账号模型（每账号一台真实 Chrome）与上游的 cookie 模型（每账号一份文件）其实可以**协作**而非互斥——真实 Chrome 负责「维护登录态 + 扫码」，cookie 文件负责「给发布浏览器注入登录态」。PostHub 现在已经做了「发布前从 CDP context 导出 storage_state」（`uploader.py:198-204`），只是导出后**继续用 CDP 连接发布**；上游原生方案把这段改成「导出后断连，交给上游自起浏览器发布」，语义、数据流向完全不变。

---

## 六、改用上游原生方案的可行性（针对「不能就安装原版的方案吗」）

### 6.1 结论：可行，且对视频号是「回到上游原生」，不是绕路

- 我们对视频号做的是「把 CDP 接管发布换成上游原生发布」，上游 `TencentVideo.upload` 本身就长这样（`main.py:933-962`）。
- PostHub 侧唯一需要补的环节是**登录态导出**：从账号 Chrome 的 CDP context 执行 `context.storage_state(path=account_file)`（已有 `cdp_attach.py:118`），然后**断开 CDP、不 patch**，让上游自起浏览器 + storage_state 注入。
- **这就是 handoff 里的方案 B2**：仅视频号切换。

### 6.2 需要补 / 要决策的点

| 项 | 说明 | 决策 |
|---|---|---|
| 导出时机 | 发布时从账号 Chrome 现导（连接→导出→断连），或发布前预取 | 发布时现导即可，数据最新 |
| 账号模型语义 | 「视频号账号 = 独立真实 Chrome」保留为登录态来源；发布浏览器变成上游自起 | 无需改表/改 schema，改执行器分叉 |
| 登录态失效 | 账号 Chrome 登录态 ≠ cookie 文件新鲜度；需靠上游 `cookie_auth` 报 `auth` → needs_relogin | 沿用现有 job 状态机，无新开销 |
| 抖音/小红书 | 三平台统一（B1）还是仅视频号（B2） | 探针证据只覆盖视频号；B2 不动已可用的抖音/小红书，回归风险最小 |
| 多实例并发 | 视频号发布自起浏览器，不再占用账号 Chrome 的 CDP 端口 → **不再有「多 daemon 抢同一 Chrome」的干扰面** | B2 的实际收益 |

### 6.3 「直接装原版」是否可行

- **对视频号：完全可行，等价于 B2**。上游十几天前刚为视频号专门修过 cookie 误报 + 上传页登录跳转前置检测（git HEAD `008e4ff` 前的 `662633b`），视频号发布是上游维护热点，跟着原版路径走最稳。
- **对抖音/小红书：也原生可行**，但 PostHub 现在的 CDP 接管对这些平台「能用」（探针反证的是视频号），切换是行为改变而非修 bug，需要重新实测。
- **不能照抄的点**：上游是命令行/示例脚本对单账号发布，没有 PostHub 的调度/任务/账号体系；PostHub 要继续用自己的执行器（`UpstreamUploadExecutor`）做编排，只是把「attach 的是什么形态的 playwright」改成「不 patch 的原生 playwright」。

---

## 七、结论

1. **可以就「用上游原版方案」**，且对视频号这正是修法：放弃「发布期间 CDP 接管」，改用「从账号 Chrome 导出 cookie → 上游自起浏览器 + storage_state 注入」。
2. **这不是推翻 PostHub 账号模型**：真实 Chrome 保留为登录态来源与扫码入口，cookie 文件成为发布浏览器与账号之间的传递介质，格式已天然兼容。
3. **推荐落地形态 = 方案 B2（仅视频号切换）**：`UpstreamUploadExecutor.upload` 按平台分叉——wechat 走「导出+断开+不 patch」，douyin/xhs 维持现状；并发时视频号不再占账号 Chrome CDP 端口，顺带消除多实例抢 Chrome 的干扰面。
4. 发版前仍需：从账号 Chrome 导出 cookie 后断开 CDP，在真实页面坐实「视频号发布页恢复渲染」；否则一切停留在推断。

**不确定处**：视频号「CDP 连接抑制渲染」的具体前端检测点未坐实（探针自动化标志检查通过，但页面仍不渲染），目前都是行为学推断；这是发版前必须实测关门的一项。