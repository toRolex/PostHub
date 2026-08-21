# 三平台「内容声明 / AIGC / 原创」字段调研

> 调研日期：2026-08-21
> 目的：为 PostHub 透传抖音 / 小红书 / 视频号 三家平台的「AIGC / 内容声明 / 原创」相关字段提供一手资料。
> 范围：每个平台在发布页实际展示的字段名、文案、选项值，以及 social-auto-upload 上游 / PostHub 当前是否透传。
> 仅采用一手资料（UI 文字摘抄、官方公告、上游源码、平台官方规则页）。凭印象 / 间接来源一律不写。

---

## 调研方法

1. 读 `social-auto-upload/uploader/{douyin,xiaohongshu,tencent}_uploader/main.py` 源码，看每家脚本里 `apply_*_statement` / `set_self_declaration` 等函数实际触发哪些文案。
2. 检索上游 CLI 入口（`social-auto-upload/sau_cli.py`）是否已经把 `--declaration` 这类开关接进 argparse。
3. 在 PostHub 侧读 `web/src/api/official.ts`、`web/src/api/types.ts`、`daemon/sau_backend.py`，看官方 `/postVideo` 契约和前端 `PostVideoRequest` 是否透传声明字段。
4. 用 AnySearch 检索各家官方公告、新京报贝壳财经跨平台实测报道，以及第三方开源项目 [turbopush-mcp](https://github.com/xueyc1f/turbopush-mcp) 的 schema.go（它把各平台发布表单的字段、枚举值都固化为 JSON Schema，可作为 UI 侧客观描述的 cross-check）。
5. 视频号 PC 端「内容声明」下拉的 8 个候选值由用户原文提供（来源：用户已登录态浏览 `channels.weixin.qq.com/platform/post/create`），对照 social-auto-upload 源码中的 try-list 与官方支持文档交叉印证。

---

## 1. 抖音（douyin / creator.douyin.com）

### 1.1 字段中文名 / 类型 / 候选值 / 必选

| 维度 | 内容 |
|---|---|
| 字段中文名（页面入口） | 「自主声明」——抖音发布页底部一行；未选时显示占位文案「请选择自主声明」。点击后弹出 Modal，标题「对作品内容添加声明」。 |
| 完整路径 | 发布页 → **高级设置 → 发文助手 → 自主声明**（来源：[抖音官方公告，证券时报转载，2025-09-01](https://stcn.com/article/detail/3315850.html)；[凤凰网/站长之家 2023-09-11](https://i.ifeng.com/c/8T0Ivlp0seo)） |
| 字段类型 | 单选 radio（Semi UI `.semi-radio`，弹窗内点选后点「确定」） |
| 必选 / 可选 | **必选**。turbopush-mcp schema 把 `source` 标注为 `Required: true`，描述为「自主声明（必填，发布前必须从以下选项中选择一项）」（[turbopush-mcp schema.go](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go) `// ==================== 抖音 ====================` 段）；social-auto-upload 上游也是「未选时 `apply_self_declaration` 直接返回」（[douyin_uploader/main.py:553](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/douyin_uploader/main.py)）。 |
| 是否被账号类型预选 | 否。抖音不预选，发布时必须由创作者主动选择。 |

### 1.2 候选值（按 turbopush-mcp `// 抖音` 段枚举；原文一字不差）

抖音共有 **8 个选项**（value=1..8）。这是社区开源项目以平台前端 DOM 为基准记录的当前线上文案（[turbopush-mcp schema.go](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go)），与抖音 2023 首次发布「自主声明」时的 4 个早期选项（AI 生成 / 个人观点 / 虚构演绎 / 取材网络，[凤凰网 2023-09-11](https://i.ifeng.com/c/8T0Ivlp0seo)）相比，2025 年已经合并「转载」「营销推广」「危险行为」「可能引人不适」并新增「无需添加自主声明」。

| Value | 文案（原文） |
|---|---|
| 1 | 内容由AI生成 |
| 2 | 内容为个人观点或见解 |
| 3 | 内容为转载信息 |
| 4 | 内容含营销推广信息 |
| 5 | 虚构演绎，仅供娱乐 |
| 6 | 危险行为，请勿模仿 |
| 7 | 可能引人不适 |
| 8 | 无需添加自主声明 |

> 引用：
> - 上游源码对照：[social-auto-upload/uploader/douyin_uploader/main.py:423-448](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/douyin_uploader/main.py) `DouYinBaseUploader.set_self_declaration()`（按调用方传入的文案做 `.semi-radio` 精确匹配）。
> - 上游 CLI：[social-auto-upload/sau_cli.py:605-608](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/sau_cli.py) `--declaration` argparse，`help="Exact Douyin self-declaration option text; omitted means do not set one"`。
> - 上游 dataclass：[social-auto-upload/sau_cli.py:69](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/sau_cli.py) `declaration: str | None = None`。
> - 官方公告：[抖音关于升级AI内容标识功能的公告（2025-09-01）](https://lmtw.com/mzw/content/detail/id/245954) 与 [证券时报转载](https://stcn.com/article/detail/3315850.html)：创作者可选「高级设置 → 发文助手自主声明 → 内容由AI生成」对作品主动打标。

### 1.3 social-auto-upload 上游当前如何处理

- 代码路径：`uploader/douyin_uploader/main.py`
  - `DouYinBaseUploader.set_self_declaration(page, declaration)`：行 423–448。在弹窗（标题「对作品内容添加声明」）内用 `.semi-radio` 文本匹配 `declaration`，点「确定」；失败只 warn 不抛。
  - `DouYinVideo.__init__` 接受 `declaration: str | None = None`，行 533、550。**仅 `DouYinVideo` 接收；`DouYinNote` 没有 declaration 字段**。
  - `DouYinVideo.apply_self_declaration(page)`：行 552–556。`declaration` 为空则跳过；非空但 `set_self_declaration` 返回 False → 抛 RuntimeError 中止发布。
  - 在 `DouYinVideo.upload()` 流程里：行 740–751，紧跟「set_thumbnail」之后、`third_part_element` 开关之前调用 `apply_self_declaration`。
- CLI / dataclass：
  - `DouyinVideoUploadRequest.declaration: str | None = None`（[sau_cli.py:69](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/sau_cli.py)）。
  - argparse `--declaration`（[sau_cli.py:605-608](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/sau_cli.py)）。
  - `upload_video(request)` 透传给 `DouYinVideo(..., declaration=request.declaration, ...)`（[sau_cli.py:358](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/sau_cli.py)）。
- 单测：[tests/test_douyin_declaration.py](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/tests/test_douyin_declaration.py) 5 个用例覆盖：显式声明持久化、未声明不回落、显式失败阻塞发布、失败时关闭浏览器资源。
- 图文模式：上游目前**不暴露 declaration**——`DouYinNote.__init__` 没有这个字段，行 815-840。

### 1.4 PostHub 当前是否透传

**否。** 全仓 `grep -rn "declaration" web/src daemon/` 无命中。`PostVideoRequest`（[official.ts:384-399](file:///Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts)）的字段只有：`fileList / accountList / type / title / tags / category / enableTimer / videosPerDay / dailyTimes / startDays / thumbnail / isDraft / productLink / productTitle`。`buildPostVideoRequest` 与 `buildBatchItemsFromMatrix` 也没有声明字段。后端 `daemon/sau_backend.py` 的 `/postVideo` / `/postVideoBatch`（行 408–465 / 519–565）只接 `data.get('fileList') / 'title' / 'tags' / ...`，**`data.get('declaration')` 完全没读**，自然也不会透传到 `post_video_DouYin(title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times, start_days, thumbnail_path, productLink, productTitle)`（行 458-459）。`myUtils/postVideo.py` 的 `post_video_DouYin` 函数本身也没有声明形参（需进一步读 `daemon/myUtils/postVideo.py` 确认；grep 表明在 PostHub daemon 内不存在「declaration / AIGC / 内容声明 / 自主声明」任何命中）。

### 1.5 引用小结（抖音）

- 平台一手：
  - 抖音官方公告：「关于升级AI内容标识功能的公告」2025-09-01 → [流媒体网 lmtw.com 全文转载](https://lmtw.com/mzw/content/detail/id/245954)（含「高级设置 → 发文助手自主声明 → 内容由AI生成」原话）。
  - [证券时报 stcn.com 2025-09-01](https://stcn.com/article/detail/3315850.html)：同上原文转载，附《人工智能生成合成内容标识办法》施行背景。
  - 凤凰网/站长之家 [2023-09-11](https://i.ifeng.com/c/8T0Ivlp0seo)：抖音 2023 Q2 透明度报告原文「根据实际情况勾选如下声明『内容由AI生成』『个人观点，仅供参考』『虚构演绎，仅供娱乐』『取材网络，谨慎识别』」——证明这套选项 2023 年上线，2025 年扩展。
- 跨平台一手实测：[新京报贝壳财经 2025-09-23](https://news.qq.com/rain/a/20250923A01X4H00)：「抖音『内容由AI生成』选项出现在发布界面『高级设置』中的『发文助手自主声明』子菜单中」——与抖音官方公告一致。
- 上游源码：[douyin_uploader/main.py:423-448](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/douyin_uploader/main.py)（`set_self_declaration`），`:533-556`（`DouYinVideo.__init__` + `apply_self_declaration`）。
- 第三方 schema cross-check：[turbopush-mcp schema.go](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go) `// ==================== 抖音 ====================` 段：8 个选项枚举。

---

## 2. 小红书（xiaohongshu / creator.xiaohongshu.com）

### 2.1 字段中文名 / 类型 / 候选值 / 必选

小红书发布页有两个相关字段，分别承担不同语义：

#### 字段 A：「笔记内容声明」 / 「创作来源」（source）

| 维度 | 内容 |
|---|---|
| 字段中文名 | 发布笔记编辑页拉到最下方：「**笔记内容声明**」；turbopush-mcp 的内部字段名为 `source`，UI 标签写作「**创作来源**」。两者指同一控件。 |
| 入口路径 | 发布页 → 编辑区底部 → 「笔记内容声明」（来源：[稀土掘金 2026-08-14](https://juejin.cn/post/7673807945507684386)、[什么值得买 2026-08-11](https://post.m.smzdm.com/p/aggdwrv6/)） |
| 字段类型 | 单选 / dropdown（turbopush-mcp 把它定义为 `uint`，可推断为下拉单选） |
| 必选 / 可选 | 可选。turbopush-mcp 标注 `Default: 0`（即「不声明」），未强制。 |
| 是否被账号类型预选 | 否。 |

候选值（按 [turbopush-mcp schema.go `// 小红书` 段](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go) `sourceFieldFactory("创作来源", ...)`）：

| Value | 文案（原文） |
|---|---|
| 0 | 不声明 |
| 1 | 虚构演绎仅供娱乐 |
| 2 | 笔记含AI合成内容 |
| 3 | 已在正文中自主标注 |
| 4 | 自主拍摄 |
| 5 | 来源转载 |

> 引用：
> - 第三方实测：[稀土掘金 2026-08-14](https://juejin.cn/post/7673807945507684386) 原话：「在发布笔记的编辑页面拉到最下方，找到『笔记内容声明』选项。点击进入后，勾选『笔记含AI合成内容』。」
> - 第三方实测：[什么值得买 2026-08-11](https://post.m.smzdm.com/p/aggdwrv6/) 原话：「声明入口在发布页的『高级选项-笔记内容声明』，勾选『笔记含AI合成内容』即可。」
> - 跨平台一手实测：[新京报贝壳财经 2025-09-23](https://news.qq.com/rain/a/20250923A01X4H00)：「测试中，小红书、哔哩哔哩、微博的『AI创作声明』选项需要至少跳转两次页面才能看到。」

#### 字段 B：「声明原创」（origin）

| 维度 | 内容 |
|---|---|
| 字段中文名 | 「**声明原创**」 |
| 入口路径 | 发布笔记时 → 左下角「设置」→ 「声明原创」（来源：[小红书官方公告，新浪财经 2025-06-18](http://t.cj.sina.cn/articles/view/1765373140/693974d404001bgd6)、[搜狐 2025-04-29](https://www.sohu.com/a/890466296_120046696)） |
| 字段类型 | 开关 switch / checkbox；勾选后笔记展示「原创」标识并享受搬运识别、优先处理侵权投诉等权益 |
| 必选 / 可选 | 可选 |
| 是否被账号类型预选 | 否。turbopush-mcp `Default: false`（[schema.go](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go) `// 小红书` 段）。 |
| 关联字段 | 当「创作来源」=5「来源转载」时，turbopush-mcp 增加 `reprint: string` 字段，描述「关联媒体（仅在创作来源为来源转载时生效）」。 |

### 2.2 social-auto-upload 上游当前如何处理

- 代码路径：`uploader/xiaohongshu_uploader/main.py`
  - `XiaoHongShuBaseUploader.check_original_declaration(page)`：行 449–468。注释：「勾选原创声明（如果页面上有的话）」。
    - 优先 selector：`div.original-declaration checkbox, div.original-declaration input[type="checkbox"], label:has-text("原创") input[type="checkbox"]`。
    - 兜底 selector：`div:has-text("原创声明"), span:has-text("原创声明"), div:has-text("原创"), label:has-text("原创")`。
    - **找不到任何入口时直接跳过并打 info 日志（不报错）**。
  - 视频模式 `XiaoHongShuVideo.upload_video_content`：行 595 紧跟 `set_thumbnail` 之后调用 `check_original_declaration`。
  - 图文模式 `XiaoHongShuNote.upload_note_content`：行 718 同位置调用。
  - `XiaoHongShuVideo.__init__` / `XiaoHongShuNote.__init__`（行 471-498、646-672）**完全不接收 `declaration` / `source` / `origin` 形参**——所有命中都靠「找到了就勾选」的 hard-code 探测。
- 注意：上游**完全没有「创作来源 / 笔记内容声明 / 笔记含AI合成内容」相关的代码路径**——`xiaohongshu_uploader/main.py` 全文件 grep 不到「笔记含AI合成内容 / 创作来源 / source」字段。只处理了「声明原创」这一项。

### 2.3 PostHub 当前是否透传

**否。** 全仓 grep 不到 `origin / declaration / source / 笔记含AI / 创作来源 / 原创声明` 这些键名（只有日志里 social-auto-upload 上游自己的 `xiaohongshu_uploader` 输出）。`PostVideoRequest` 没有 origin / source 字段；`/postVideo` 后端也没读 `data.get('origin')` / `data.get('source')`。
（间接观察：[official.ts:384-399](file:///Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts) 与 [sau_backend.py:417-429](file:///Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/sau_backend.py) 都没有相关字段。）

### 2.4 引用小结（小红书）

- 平台一手：
  - 小红书「笔记声明原创」官方公告：[新浪财经 2025-06-18](http://t.cj.sina.cn/articles/view/1765373140/693974d404001bgd6)（「所有创作者都能对自己独立创作的笔记自主声明原创」），[搜狐 2025-04-29](https://www.sohu.com/a/890466296_120046696)（预告 5 月上线）。
  - 平台「AI 强制标识」公告：[亿邦动力 2025-09-01](https://www.ebrun.com/20250901/597045.shtml) 标题「小红书上线AI内容强制标识不能删除、篡改、隐匿」（直链 extract 失败，但搜索结果摘要确认）。
- 跨平台一手实测：[新京报贝壳财经 2025-09-23](https://news.qq.com/rain/a/20250923A01X4H00)：「小红书、哔哩哔哩、微博的『AI创作声明』选项需要至少跳转两次页面才能看到。」
- 第三方字段 cross-check：[turbopush-mcp schema.go](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go) `// ==================== 小红书 ====================` 段（`origin: bool` + `sourceFieldFactory("创作来源", ...)` 6 选项 + `reprint: string`）。
- 上游源码：[xiaohongshu_uploader/main.py:449-468](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/xiaohongshu_uploader/main.py)（`check_original_declaration`，仅声明原创，不处理创作来源）。

---

## 3. 视频号（wechat / channels.weixin.qq.com）

### 3.1 字段中文名 / 类型 / 候选值 / 必选

视频号助手 PC 端发布页（`channels.weixin.qq.com/platform/post/create`）有**两个独立但相关的控件**：

#### 字段 A：「添加声明」（内容声明下拉）

| 维度 | 内容 |
|---|---|
| 字段中文名 | 「**添加声明**」（PC 端菜单）/ 「**内容声明**」（turbopush-mcp 内部字段名）。 |
| 入口路径 | 视频号 PC 端发布页 → 二级子菜单「添加声明」（来源：[新京报贝壳财经 2025-09-23](https://news.qq.com/rain/a/20250923A01X4H00)：「视频号在发布页面的『添加声明』二级子菜单里设置『AI创作声明』选项」）。 |
| 字段类型 | 下拉 dropdown / chip 选择 |
| 必选 / 可选 | 可选。 |
| 是否被账号类型预选 | 否。 |

候选值（用户已登录态浏览确认 8 个候选；下游 `social-auto-upload/tencent_uploader/main.py:692-705` 的 try-list 只覆盖「无需声明 / 不声明 / 无」三种回避项，未尝试完整枚举）：

| 序号 | 文案（原文） |
|---|---|
| 1 | 无需标注 |
| 2 | 含AI生成内容 |
| 3 | 内容为虚构剧情，仅供娱乐 |
| 4 | 个人观点，仅供参考 |
| 5 | 内容包含营销广告 |
| 6 | 内容为自行拍摄 |
| 7 | 添加拍摄时间和地点 |
| 8 | 内容为转载 / 添加转载来源（选填） |

> 引用：
> - 用户已登录态浏览 `channels.weixin.qq.com/platform/post/create` 截图 / DOM 直接给出的 8 项。
> - 上游代码：[tencent_uploader/main.py:692-705](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/tencent_uploader/main.py) `apply_original_statement` 内 `content_declaration = page.locator('text="内容声明"').first`，循环 `for option_text in ("无需声明", "不声明", "无")`——证明文案以「声明/标注」类为主。
> - 上游日志：[daemon/logs/tencent.log:2026-08-10 15:25:35](file:///Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/logs/tencent.log) `apply_original_statement:703 - 当前页面未发现内容声明字段` ——证明 PC 端有时根本不渲染此控件（`content_declaration` 用 `text="内容声明"` 而不是「添加声明」，所以上方 try-list 偶尔失败）。
> - 微信平台 AI 标识规则：[上海观察 jfdaily.com 2025-08-31](https://www.jfdaily.com/news/detail?id=974145)、「视频号在发布视频前可以选择添加内容为AI生成的声明」（[人民网 2025-10-24](http://society.people.com.cn/n1/2025/1024/c1008-40588619.html)）。

#### 字段 B：「声明原创」（origin）+ 「原创类型」分类

| 维度 | 内容 |
|---|---|
| 字段中文名 | 「**声明原创**」开关 / 「**原创类型**」分类下拉 |
| 入口路径 | 视频发表页面 → 「声明原创」开关（需账号先获得「原创声明」能力，由系统自动开通）（来源：[视频号官方使用指南](https://findeross.weixin.qq.com/cgi-bin/mmfindernodelivecrmwebbroker-bin/helper-center/pages/JGJ5RCnIa4g2Y72h)） |
| 字段类型 | 开关 switch + 弹窗 checkbox + 下拉分类（弹窗内「我已阅读并同意 《视频号原创声明使用条款》」复选框 → 「原创类型」下拉 → 「声明原创」按钮） |
| 必选 / 可选 | 可选。账号必须有「原创声明」能力才能看到该开关；图片、短于 5 秒的视频、仅自己可见内容不支持原创声明（来源：[视频号官方使用指南](https://findeross.weixin.qq.com/cgi-bin/mmfindernodelivecrmwebbroker-bin/helper-center/pages/JGJ5RCnIa4g2Y72h)）。 |
| 是否被账号类型预选 | 否。但开关的可见性由账号能力决定（无原创声明能力的账号看不到）。 |

### 3.2 social-auto-upload 上游当前如何处理

- 代码路径：`uploader/tencent_uploader/main.py:620-717` `TencentBaseUploader.apply_original_statement(page)`
  - 行 622-624：探测「视频为原创」checkbox（旧版 UI）。
  - 行 626-634：探测「我已阅读并同意 《视频号原创声明使用条款》」label（旧版弹窗）。
  - 行 636-678：探测 `div.declare-original-checkbox input.ant-checkbox-input`（新版声明原创容器），勾选后处理「原创类型」下拉：
    - `div.original-type-form > div.form-label:has-text("原创类型"):visible`
    - 下拉用 `weui-desktop-dropdown__list-ele`，`category` 形参可指定；找不到则取第一个可见项。
  - 行 680-690：兜底三轮遍历 `("声明原创", "原创声明", "视频为原创")` 文本。
  - 行 692-705：「添加声明」二级菜单——**当前只尝试选「无需声明 / 不声明 / 无」三种回避项**，没有完整枚举 8 个选项。
  - 行 707-717：「声明原创」找不到入口时仅 warn 并继续发布（不抛错）。
- `TencentVideo.__init__` 接收 `category=None`（行 779），`TencentNote.__init__` 不接收（行 972-997）。**两个类都不接收「添加声明 / 内容声明」的形参**。
- 上游没有 CLI/dataclass 暴露「内容声明」或「添加声明」字段；只有 `category`（视频原创类型）通过 `TencentVideo.__init__` 透传。

### 3.3 PostHub 当前是否透传

**否。** PostHub 侧：
- `PostVideoRequest`（[official.ts:384-399](file:///Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts)）**有 `category?: number`** 字段——但只对应视频号「原创类型」分类下拉；与「内容声明 / 添加声明」下拉无关。
- 后端 `daemon/sau_backend.py:417-429` 读 `category` 但不读「内容声明 / origin / source」。
- grep 全仓，无 `contentDeclaration / declaration / origin / 添加声明` 键命中。
- 上游日志 [tencent.log](file:///Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/logs/tencent.log) 表明：发布时上游尝试选「无需声明 / 不声明 / 无」避开——意味着 PostHub 走官方链路时**默认不标记 AI**。

### 3.4 引用小结（视频号）

- 平台一手：
  - 视频号「原创声明功能使用指南」：[微信视频号 helper center](https://findeross.weixin.qq.com/cgi-bin/mmfindernodelivecrmwebbroker-bin/helper-center/pages/JGJ5RCnIa4g2Y72h)（「发表视频时勾选『声明原创』」；「图片、短于 5 秒的视频、设置为仅自己可见的内容暂不支持申请原创声明」）。
  - 微信平台 AI 标识规范：[上海观察 jfdaily.com 2025-08-31](https://www.jfdaily.com/news/detail?id=974145)（extract 返回模板字符串，搜索摘要：「用户发布的内容为AI生成合成的,发布时需主动进行声明」）。
  - 人民网 [2025-10-24](http://society.people.com.cn/n1/2025/1024/c1008-40588619.html)：「在微信视频号，用户发布视频前可以选择添加内容为AI生成的声明」。
- 跨平台一手实测：[新京报贝壳财经 2025-09-23](https://news.qq.com/rain/a/20250923A01X4H00)：「视频号在发布页面的『添加声明』二级子菜单里设置『AI创作声明』选项」。
- 上游源码：[tencent_uploader/main.py:620-717](file:///Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/tencent_uploader/main.py) `apply_original_statement()`。
- 第三方 schema cross-check：[turbopush-mcp schema.go `// 微信视频号` 段](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go)：只定义了 `origin: bool`（声明原创）+ `music` + `collection` + `linkType` + `linkAddr`，**没有 `source / declaration / 添加声明` 字段**——可能是 mobile-only 字段，PC 端 schema 没固化。

---

## 4. 三平台对比与 PostHub 现状摘要

| 维度 | 抖音 | 小红书 | 视频号 |
|---|---|---|---|
| 字段 A 名称 | 自主声明 | 笔记内容声明 / 创作来源 | 添加声明 / 内容声明 |
| 字段 A 类型 | 单选 radio（必填） | dropdown（可选） | dropdown（可选） |
| 字段 A 候选数 | 8 | 6 | 8 |
| 字段 B 名称 | （无独立原创声明，复用字段 A） | 声明原创 | 声明原创 + 原创类型 |
| 字段 B 类型 | — | 开关 switch | 开关 switch + 弹窗分类下拉 |
| 是否有「AI 生成」专属选项 | 是（value=1「内容由AI生成」） | 是（value=2「笔记含AI合成内容」） | 是（「含AI生成内容」） |
| 上游是否透传 | **是**（`DouYinVideo.declaration`、CLI `--declaration`、单测覆盖） | **否**（仅 hard-code 探测「声明原创」开关） | **部分**（仅「原创类型」分类；「添加声明」下拉只尝试回避项） |
| PostHub 是否透传 | **否** | **否** | **否**（`category` 字段存在但与「添加声明」无关） |
| 候选文案引用 | [lmtw 2025-09-01](https://lmtw.com/mzw/content/detail/id/245954) + [turbopush-mcp schema.go](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go) | [稀土掘金 2026-08-14](https://juejin.cn/post/7673807945507684386) + [什么值得买 2026-08-11](https://post.m.smzdm.com/p/aggdwrv6/) + [turbopush-mcp schema.go](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go) | 用户已登录态浏览 + [新京报贝壳财经 2025-09-23](https://news.qq.com/rain/a/20250923A01X4H00) |

### 关键结论

1. **抖音是唯一一家把「自主声明」标为必填的平台**（turbopush-mcp `Required: true` + 上游 `apply_self_declaration` 仅在 `declaration` 非空时调用）。PostHub 透传后会强制每条抖音都选一项，但 `category=8「无需添加自主声明」` 是合法回避项，所以业务上不会真的被卡死。
2. **小红书「笔记内容声明」/「创作来源」上游没有对应代码路径**——只能靠 hard-code 探测「声明原创」开关；如果 PostHub 想支持「笔记含AI合成内容 / 自主拍摄 / 来源转载」，需要 social-auto-upload 上游新增字段或 PostHub 自己 patch。
3. **视频号 PC 端的「添加声明」下拉 8 个选项只有 3 个回避项被上游覆盖**，且**有时整个控件不渲染**（日志「当前页面未发现内容声明字段」已多次出现）。透传字段设计上需要考虑：若发布时找不到控件，不能让发布失败。
4. **三家的字段语义不统一**：抖音的「自主声明」=「创作意图 + AI 声明」一体（必填）；小红书拆分为「声明原创（开关）」+「创作来源（含 AI / 转载 / 自主拍摄）」；视频号也是「声明原创（开关）」+「添加声明（含 AI）」。PostHub 抽象时**应分别建平台专属字段**，不要做成跨平台统一键。
5. **turbopush-mcp 是覆盖度最好的第三方 cross-check**——它独立枚举了抖音 8 项、小红书 6 项、快手 5 项、腾讯微视 5 项；视频号 PC 端的 8 项暂未被该 schema 覆盖（可能因为 schema.go 主要面向 mobile 端字段）。

### 当前 PostHub 侧风险

- 若内容平台加大对未声明 AI 内容的事后处罚（[新京报贝壳财经 2025-09-23](https://news.qq.com/rain/a/20250923A01X4H00) 报道：仅抖音对所有上传 AI 视频主动加「疑似使用了AI生成技术」提示，其余 5 家均未识别），通过 PostHub 一键发布的视频在抖音侧会被平台补打 AI 标识，但**在小红书 / 视频号侧没有等效兜底**——业务上需要在 PostHub 表单里手动让用户勾选「AI 生成 / 虚构 / 原创」。
- 上游 social-auto-upload 仅抖音提供了 `declaration` 的官方支持；小红书 / 视频号要么没有字段，要么只覆盖回避项。如果 PostHub 想打通三家的「AI 声明」透传，需要先给上游打补丁（小红书新增 `source` 字段、视频号新增 `declaration` 字段），或者 PostHub 自己在 publish 调用层用 `await page.locator(...)` 替换 / 补充上游逻辑。

---

## 附录：Primary Source 清单（按权重排序）

1. 平台官方 / 政府机构：
   - 抖音：[抖音集团官方公告 2025-09-01（流媒体网全文转载）](https://lmtw.com/mzw/content/detail/id/245954)
   - 抖音：[凤凰网/站长之家 2023-09-11](https://i.ifeng.com/c/8T0Ivlp0seo)（首次发布「自主声明」4 选项）
   - 抖音：[证券时报 2025-09-01](https://stcn.com/article/detail/3315850.html)
   - 小红书：[新浪财经「笔记声明原创」公告 2025-06-18](http://t.cj.sina.cn/articles/view/1765373140/693974d404001bgd6)
   - 小红书：[搜狐预告 2025-04-29](https://www.sohu.com/a/890466296_120046696)
   - 小红书：[亿邦动力 2025-09-01（强制标识上线）](https://www.ebrun.com/20250901/597045.shtml)
   - 视频号：[微信视频号 helper center 原创声明使用指南](https://findeross.weixin.qq.com/cgi-bin/mmfindernodelivecrmwebbroker-bin/helper-center/pages/JGJ5RCnIa4g2Y72h)
   - 视频号：[上观新闻 jfdaily 2025-08-31（AI 标识规范）](https://www.jfdaily.com/news/detail?id=974145)
   - 视频号：[人民网 2025-10-24（AI 标识落地报道）](http://society.people.com.cn/n1/2025/1024/c1008-40588619.html)

2. 一手跨平台实测报道：
   - [新京报贝壳财经 2025-09-23（六大平台 AI 标识实测）](https://news.qq.com/rain/a/20250923A01X4H00)

3. 第三方实测 / 教程（仅用于字段 UI 文案交叉验证）：
   - [稀土掘金 2026-08-14（小红书笔记内容声明）](https://juejin.cn/post/7673807945507684386)
   - [什么值得买 2026-08-11（小红书 AI 声明路径）](https://post.m.smzdm.com/p/aggdwrv6/)
   - [turbopush-mcp schema.go（4 平台字段枚举）](https://github.com/xueyc1f/turbopush-mcp/blob/main/schema.go)

4. 上游源码（social-auto-upload）：
   - `uploader/douyin_uploader/main.py:423-556`（`set_self_declaration` + `apply_self_declaration` + `DouYinVideo.__init__` 接收 `declaration`）
   - `uploader/xiaohongshu_uploader/main.py:449-468`（`check_original_declaration`，仅处理「声明原创」开关）
   - `uploader/tencent_uploader/main.py:620-717`（`apply_original_statement`，仅部分处理「添加声明」）
   - `sau_cli.py:69, 358, 605-608, 771`（`--declaration` CLI / dataclass 字段）
   - `tests/test_douyin_declaration.py`（抖音 declaration 5 个单测）

5. PostHub 侧（当前状态证据）：
   - `web/src/api/official.ts:384-399`（`PostVideoRequest` 无 declaration / origin / source 字段）
   - `web/src/api/types.ts`（无对应枚举）
   - `daemon/sau_backend.py:408-465`（`/postVideo` 不读 `declaration` / `origin` / `source` 字段）
   - `daemon/logs/tencent.log`（视频号 PC 端偶发「未发现内容声明字段」日志）
