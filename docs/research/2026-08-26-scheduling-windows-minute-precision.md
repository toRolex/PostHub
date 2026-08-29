# PostHub 定时窗口与分钟级时间能力证据矩阵

- **调研日期**：2026-08-26
- **Issue**：[#66](https://github.com/toRolex/PostHub/issues/66)
- **范围**：抖音、小红书、微信视频号、快手；当前锁定 `social-auto-upload` 依赖源码、PostHub seam、历史测量和可访问的一手/上游文档。
- **非目标**：不修改产品代码、`CONTEXT.md` 或 ADR；本文只记录研究结果。

## 0. 证据等级与版本边界

| 标记 | 含义 | 本文如何使用 |
|---|---|---|
| **SRC** | 当前依赖/当前 PostHub 工作树的源码事实 | 可作为当前实现契约；不等于平台服务端接受范围 |
| **HIST** | 仓库历史手测或历史调研 | 仅作为候选边界；除非重新实测，不升级为产品契约 |
| **DOC** | `social-auto-upload` 作者文档 | 说明上游设计意图和参数语义；不替代平台官方限制 |
| **LIVE** | 平台官方创作者页面公开未登录部分 | 本次页面只显示标题/登录壳，未披露窗口参数 |
| **DERIVED** | 从上述源码推导的影响 | 明确注明推导链，不冒充平台官方事实 |

当前锁定版本为 `social-auto-upload==0.1.0`，git revision `008e4ff66abdf48eb1f4b999272ef979711af436`，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/uv.lock:525-536`。该 revision 的关键源码与运行时 `daemon/.venv` 文件 hash 一致；上游工作树对应位置为 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/`。

## 1. 结论速览

1. **源码确认的最短提前量是四个平台统一 2 小时；源码没有最长提前量。** `BaseVideoUploader.MIN_SCHEDULE_LEAD_TIME` 固定为 2 小时，`validate_publish_date` 只检查过去时间和“当前时间 + 2 小时”，没有 max 检查，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:25,54-70`。四个平台的 scheduled 分支均调用该校验：抖音 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/douyin_uploader/main.py:301-307`、小红书 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/xiaohongshu_uploader/main.py:312-321`、视频号 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/tencent_uploader/main.py:508-514`、快手 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/ks_uploader/main.py:312-321`。
2. **`daily_times` 的当前后端语义是 0–23 的整点小时数组，不是分钟数组。** 生成器以 `hour = daily_times[...]` 做小时加法，并把当前分钟、秒、微秒清零，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:41-83`。因此通过 `postVideo`/`postVideoBatch` 生成的时间是 `HH:00:00`。PostHub 矩阵 UI 虽保存 `HH:MM`，提交时明确丢弃分钟并向下取整，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:534-548,611-628`。
3. **分钟级不能由当前 `daily_times` seam 保留。** PostHub 单视频表单也是整数小时（`number[]`），见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:456-473` 和 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/views/PublishView.tsx:334-343,373-383`。底层平台页面定位器有差异：抖音/小红书输入到分钟，视频号只填小时，快手向页面填入秒格式字符串；但这不改变 `daily_times` 生成路径的整点限制，见第 3 节。
4. **时区/DST 没有产品契约。** 生成器用无 `tzinfo` 的 `datetime.now()`，加 `timedelta` 后返回 naive `datetime`；HTTP 请求也没有 timezone 字段。Python 官方文档定义 `datetime.now(tz=None)` 为本地时间、`tzinfo=None`。因此当前行为依赖运行机器本地时钟；没有显式 IANA 时区、UTC 转换、DST `fold` 或重复/跳过墙上时间处理，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:65-82`、`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:456-473`；官方说明见 <https://docs.python.org/3/library/datetime.html#datetime.datetime.now>。
5. **当前 `startDays` 实际不能驱动多日/整月排期，这是已确认的调用缺陷。** 生成器签名为 `(total_videos, videos_per_day, daily_times, timestamps=False, start_days=0)`，但上游四个 `post_video_*` 和 PostHub 声明 wrapper 都把 `start_days` 作为第 4 个位置参数传入。`startDays=0` 时只是 false；`startDays>0` 时被当成 `timestamps=True`，返回 Unix 整数而不是 `datetime`，随后四个平台的 `validate_publish_date` 拒绝该值（它只接受 `datetime | int | None`，但非 0 的 int 会抛 `TypeError`）。源码链：上游 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:41,81-83`、`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/myUtils/postVideo.py:13-20,32-41,53-60,71-79`；PostHub wrapper `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/posthub/uploader_wrapper.py:97-105,139-147`；校验 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:55-70`。在锁定环境中复现：`f(1,1,[10],1)` 返回 Unix 秒，`f(1,1,[10],False,1)` 才返回后天 10:00；`f(1,1,["10:00"],False,0)` 抛字符串减整数的 `TypeError`。
6. **因此“现有同步 `/postVideoBatch` 能否整月排期”的当前答案是：不能。** 该 endpoint 逐项同步调用上游发布函数，并在所有调用完成后才返回，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/sau_backend.py:635-709`。PostHub 矩阵提交确实一次 POST `/postVideoBatch`，每个视频×账号展开为一个请求项，且 timer 项设置 `videosPerDay=1`、`dailyTimes=[hour]`、`startDays=item.startDays`，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/stores/batchPublish.ts:175-201` 和 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:571-629`；但 `startDays>0` 在后端调用缺陷下不能工作。所以当前最多只能走 `startDays=0` 的“次日”排期，不能从一个现有 batch 请求稳定地产生整月日期。
7. **平台最长窗口目前不能由锁定源码确认。** 历史 A 组记录了抖音“2 小时后及 14 天内”、小红书“1 小时后和两周内”、视频号“2 小时后和一个月内”，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/a-group-results.env:11-13`；但 B 组明确将边界值列为“已知未确认值”，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/b-group-automated-upload-results.env:17-21`。当前 `CONTEXT.md` 又写成抖音 2h–14d、小红书 2h–7d、视频号 2h–1 月，且声明来自历史调研，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/CONTEXT.md:42-50`。小红书的 1 小时/2 周、2 小时/7 天两组说法冲突，均不能当作当前平台契约。快手没有仓库内的窗口测量。
8. **即使修正 `startDays` 调用，整月也应按经真实账号验证的平台窗口分阶段提交，而不能让一个请求假设四平台边界相同。** 条件性规划为：若抖音 14 天上限复测成立，30 天至少 `ceil(30/14)=3` 个阶段；若小红书上限为 7 天则至少 5 个阶段、若为 14 天则至少 3 个阶段；若视频号 1 个月上限复测成立，可理论上 1 阶段；快手窗口未知，先实测再决定。上述数量是**窗口假设下的排期规划**，不是当前源码或官方平台保证。当前实现因第 5 条缺陷，四平台都不能用现有同步 batch 稳定完成跨日整月排期。

## 2. 四平台证据矩阵

| 平台（官方 type） | 定时策略 / 当前最短 | 当前源码最长 | `daily_times` / 底层时间控件精度 | 时区/DST | 窗口候选与可信度 |
|---|---|---|---|---|---|
| **抖音 `douyin`（3）** | `scheduled`；继承 2h。`DouYinBaseUploader.validate_base_args` 在 scheduled 时调用 `validate_publish_date`。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/douyin_uploader/main.py:301-307`；共同校验 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:25,54-70`。 | **无源码上限**；共同校验没有 max。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:66-70`。 | `/postVideo*` 生成器只认整数小时并产生 `HH:00:00`。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:69-82`。直接 uploader 的页面字段输入 `YYYY-MM-DD HH:MM`，分钟级页面交互。**SRC**：`douyin_uploader/main.py:309-320`。 | `datetime.now()` 是 naive 本地时间；无 timezone/DST 字段或转换。**SRC/DERIVED**：`utils/files_times.py:65-82`、`web/src/api/official.ts:456-473`。 | 历史记录“2h 后及 14 天内”。**HIST，未确认**：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/a-group-results.env:11`；B 组保留为未确认：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/b-group-automated-upload-results.env:17-21`。 |
| **小红书 `xiaohongshu`（1）** | `scheduled`；当前源码同样是 2h，而不是历史表中的 1h。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/xiaohongshu_uploader/main.py:312-321`；**HIST**：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/a-group-results.env:12`。 | **无源码上限**。**SRC**：共同 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:66-70`。 | `/postVideo*` 仍为整数小时、结果 `HH:00:00`。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:69-82`。直接 uploader 的 XHS 日期输入 `YYYY-MM-DD HH:MM`。**SRC**：`xiaohongshu_uploader/main.py:323-330`。 | 无 timezone/DST 契约；依赖本地 naive clock。**SRC/DERIVED**：`utils/files_times.py:65-82`、`web/src/api/official.ts:456-473`。 | 历史记录为“1 小时后和两周内”，而 `CONTEXT.md` 注册表写“2h–7 天”，两者冲突且 B 组把边界整体列未确认。**HIST，不能作为当前契约**：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/a-group-results.env:12`、`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/CONTEXT.md:44-50`、`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/b-group-automated-upload-results.env:17-21`。 |
| **微信视频号 `wechat`（2）** | `scheduled`；当前源码 2h。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/tencent_uploader/main.py:508-514`；共同校验 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:25,54-70`。 | **无源码上限**。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:66-70`。 | 生成器/API 仍是整数小时、`HH:00:00`。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:69-82`。视频号页面选择日后只输入 `strftime("%H")`，是小时级控件。**SRC**：`tencent_uploader/main.py:516-539`。 | 依赖本地 naive clock；无 timezone/DST 字段。**SRC/DERIVED**：`utils/files_times.py:65-82`、`web/src/api/official.ts:456-473`。 | 历史记录“2 小时后和一个月内”。**HIST，未确认**：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/a-group-results.env:13`；B 组明确 boundary 未确认：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/b-group-automated-upload-results.env:17-21`。源码日期控件在目标月份与当前月份不同时只点击一次右箭头：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/tencent_uploader/main.py:521-525`，因此即使平台允许更远日期，当前 UI 自动化也没有证据支持多月跳转。 |
| **快手 `kuaishou`（4）** | `scheduled`；当前源码 2h。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/ks_uploader/main.py:312-321`；共同校验 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:25,54-70`。 | **无源码上限**；没有仓库内平台上限实现或测量。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:66-70`；**HIST gap**。 | 生成器/API 只支持整数小时、`HH:00:00`。**SRC**：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:69-82`。直接 uploader 组装 `YYYY-MM-DD HH:MM:SS` 并写入日期时间输入框，秒格式是自动化输入字符串，不足以证明平台接受秒级。**SRC，不等于服务端精度**：`ks_uploader/main.py:323-359`。 | 无 timezone/DST 字段或处理。**SRC/DERIVED**：`utils/files_times.py:65-82`、`web/src/api/official.ts:456-473`。 | 未发现仓库历史窗口测量；需真实账号验证最短、最长、页面步长及跨月行为。 |

### 2.1 上游作者文档能确认什么

上游作者文档只确认“次日开始”和参数的设计意图，不确认平台窗口。抖音页列出 `total_videos`、`videos_per_day`、`daily_times`（示例为 6、11、14、16、22 点）、`start_days`，并说明默认从第二天开始，见 **DOC**：<https://sap-doc.nasdaddy.com/docs/tutorial-basics/platform-douyin/>。视频号页明确说定时配置参数与抖音相同，也只列这些参数和“默认从第二天开始”，见 **DOC**：<https://sap-doc.nasdaddy.com/docs/tutorial-basics/platform-channels/>。小红书上游页没有定时窗口或 `daily_times` 细节，见 **DOC**：<https://sap-doc.nasdaddy.com/docs/tutorial-basics/platform-xiaohongshu/>。

因此“抖音 14 天、小红书 7/14 天、视频号 1 个月、快手某上限”都不是上述作者文档的现行源码契约；必须回到真实账号页面重新测边界。

## 3. `daily_times` 精度与时间流

### 3.1 上游生成器

`generate_schedule_time_next_day` 的实现要点：

- `daily_times is None` 时默认 `[6, 11, 14, 16, 22]`；
- `videos_per_day` 不能大于 `len(daily_times)`；
- `day = video // videos_per_day + start_days + 1`，设计上从明天起；
- 取 `hour = daily_times[daily_video_index]`，以 `timedelta(hours=hour - current_time.hour, minutes=-current_time.minute, seconds=-current_time.second, microseconds=-current_time.microsecond)` 生成时间；
- 因此即便底层页面能输入分钟，官方 `post_video_*` 的定时数组也只表达整点。

证据：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:41-83`；上游 README 也说明项目原始策略就是提前一天设置定时，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/README.md:234-238`。

### 3.2 PostHub seam

- 单视频 `PostVideoRequest.dailyTimes?: number[]`，注释明确为 0–23 整点小时，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:443-473`。
- 单视频表单解析输入为整数小时，过滤范围 0–23，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/views/PublishView.tsx:334-343`。
- 矩阵批量允许 `HH:MM` 表示 UI 时刻，但 `parseHHMMToHour` 注释和实现明确只返回小时，并用 `Math.floor(hour)`；例如 `14:30` 和 `14:00` 都发送 `14`，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:534-548`。
- 矩阵 timer 项固定 `videosPerDay: 1`，发送 `dailyTimes: [hour]`，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:611-628`。

### 3.3 上游官方前端的反差（需注意）

锁定 revision 的上游 Vue 前端日期控件设置 `step="00:30"`、范围 `00:00`–`23:30`，并把 `HH:MM` 字符串作为 `dailyTimes` 发送，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/sau_frontend/src/views/PublishCenter.vue:444-469,792-809`。但同一 revision 的 Python 生成器将 `daily_times` 当数字做减法；直接传 `"10:00"` 会抛 `TypeError`。这是上游前端/后端当前实现不一致的源码事实，不应把“30 分钟 UI 控件”误写为后端实际支持的分钟级能力。PostHub 当前 React seam 已主动采用整数小时/批量向下取整，避免把字符串直接传给生成器，但没有实现分钟级。

## 4. 时区与 DST 语义

### 已确认

- 生成器调用 `datetime.now()`，未传 `tz`，返回本地 naive datetime，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:65-82`。
- 下游 uploader 的 `validate_publish_date` 对 aware datetime 会以同一 `tzinfo` 调用 `datetime.now(tz=...)`，但 PostHub HTTP seam 的 `dailyTimes/startDays` 没有 timezone 字段，且生成器返回的仍是 naive datetime，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:55-70`、`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:456-473`。
- Python 官方文档：无 `tz` 的 `datetime.now()` 返回当前本地日期时间；传入 `tz` 才将当前时间转换到指定时区：<https://docs.python.org/3/library/datetime.html#datetime.datetime.now>。

### 未确认 / 不能假设

- 平台服务端采用账号地区、浏览器本地时区还是固定中国标准时间（UTC+08:00）；源码没有向平台传时区标识。
- DST 开始时跳过的墙上时间、DST 结束时重复的墙上时间如何处理；当前链路没有 `zoneinfo`、UTC、`fold` 或冲突消歧逻辑。
- 由于中国大陆通常无 DST，不能据此推导海外/异地运行机器的行为；应把部署机器本地时区固定和平台实测作为后续验收项。

## 5. `/postVideoBatch` 与整月排期

### 5.1 当前请求与执行形态

- `postVideoBatch` 接受 JSON 数组，先收集声明字段，再逐项读取 `fileList/accountList/type/.../videosPerDay/dailyTimes/startDays`，按官方 type 调 `post_video_xhs`、`post_video_tencent`、`post_video_DouYin` 或 `post_video_ks`，最后才返回 200；没有独立的持久化排期表或异步排队层，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/sau_backend.py:635-709`。
- 上游每个 `post_video_*` 在同一调用中计算日期并逐文件、逐账号 `asyncio.run(...)`，见 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/myUtils/postVideo.py:13-87`。
- 矩阵批量把每个 `(视频, 平台, 账号)` 展开成一个 request 项；timer 项将一个 `HH:MM` 映射为单个小时、`videosPerDay=1`，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:571-629`；store 只发一次 `/postVideoBatch`，见 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/stores/batchPublish.ts:175-201`。

### 5.2 当前实现能否做一个月

**不能。** 不是因为 `/postVideoBatch` 的 JSON 数组不能装一个月，而是：

1. 要生成日期序列必须依赖 `startDays`；
2. 当前所有 `post_video_*` 调用把 `start_days` 传到了 `timestamps` 位置；
3. `startDays>0` 会得到 Unix 秒整数；
4. 四个平台的 `BaseVideoUploader.validate_publish_date` 会拒绝该非 0 整数；
5. `startDays=0` 只产生“明天”（生成器固定 `+1`）。

因此不能把当前一次同步 batch 描述为“已支持整月排期”。要实现该能力，至少需要在产品变更中修正调用参数并重新验证每个平台的真实窗口；本调研不改代码。

### 5.3 条件性阶段规划（不是当前承诺）

| 平台 | 若复测候选窗口成立 | 30 天排期阶段数（条件性） | 当前状态 |
|---|---:|---:|---|
| 抖音 | 2h–14d | 至少 3 阶段 | 14d 只来自 HIST；源码无 max；且当前 `startDays` 缺陷未修 |
| 小红书 | 2h–7d（CONTEXT）或 1h–14d（A 组） | 7d 时至少 5 阶段；14d 时至少 3 阶段 | 两份历史证据冲突；需实测 |
| 视频号 | 2h–1 月（CONTEXT/HIST） | 理论上 1 阶段 | 无源码 max；日期控件跨月只右移一页；需实测 |
| 快手 | 未知 | 不可计算 | 无历史窗口；需实测 |

**分阶段提交的操作含义**：不是把四个平台混在一条 batch 里等待平台自行截断；应按平台和已验证窗口构造不同 request 数组/提交批次。抖音、小红书若候选上限成立必须分阶段；视频号只有在“1 月上限”真实复测成立、且日期控件覆盖目标月份时才可单阶段；快手先验证再决定。无论平台窗口如何，当前 `startDays` 缺陷修复前均不能声称任何平台可整月执行。

## 6. 需要真实账号关闭的验证项

1. 每个平台分别以 `now + 1h`、`now + 2h`、候选 max−1、候选 max、候选 max+1 提交测试，记录页面原文、是否创建定时任务、实际显示时间。
2. 分别测试 `HH:00`、`HH:01`、`HH:30`；区分页面控件能输入的粒度与 `/postVideo*` `daily_times` 实际能表达的粒度。
3. 测试跨当前月/下月以及跨两个月；特别是视频号 `tencent_uploader` 只点击一次下月箭头的路径。
4. 在明确设置系统时区的环境中测试平台显示时间；若需 DST，使用支持 DST 的 `zoneinfo` 环境和重复/跳过墙上时间，记录平台最终时间。当前源码没有可依赖的 DST 语义。
5. 修正 `start_days` 关键字调用后，先用 3 个日期（明天、后天、+30 天）做四平台烟测，再决定是否开放阶段化整月导入。

## 7. 来源清单

### 当前锁定源码 / PostHub（SRC）

- Lock：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/uv.lock:525-536`；upstream URL <https://github.com/dreammis/social-auto-upload/tree/008e4ff66abdf48eb1f4b999272ef979711af436>。
- 通用发布时间校验：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/base_video.py:25,54-70`。
- 日期生成器：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/utils/files_times.py:41-83`。
- 四平台页面定时控件：抖音 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/douyin_uploader/main.py:301-320,758-760`；小红书 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/xiaohongshu_uploader/main.py:312-330,597-603`；视频号 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/tencent_uploader/main.py:508-539,952-956`；快手 `/Users/rolex/Documents/Codes/githubProject/social-auto-upload/uploader/ks_uploader/main.py:312-359,535-537`。
- 上游批量调用：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/myUtils/postVideo.py:13-87`。
- PostHub REST 批量 endpoint：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/daemon/sau_backend.py:635-709`。
- PostHub 请求/矩阵映射：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/api/official.ts:443-473,534-548,571-629`；`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/stores/batchPublish.ts:175-201`；`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/web/src/views/PublishView.tsx:334-343,373-396`。

### 仓库历史测量 / 决策（HIST）

- `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/a-group-results.env:11-13`：历史边界文本。
- `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/measurements/b-group-automated-upload-results.env:17-21`：明确保留边界为未确认。
- `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/CONTEXT.md:42-50,76-80`：当前注册表和待验证声明。
- `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub/docs/adr/0002-manifest-batch-format.md:63-79`：旧 manifest 的 2h–7d 假设，文档自身注明来自调研且官方无明文，不能覆盖当前官方后端实现。

### 上游作者文档（DOC）

- 抖音定时参数：<https://sap-doc.nasdaddy.com/docs/tutorial-basics/platform-douyin/>。
- 视频号定时参数：<https://sap-doc.nasdaddy.com/docs/tutorial-basics/platform-channels/>。
- 小红书页（没有窗口参数）：<https://sap-doc.nasdaddy.com/docs/tutorial-basics/platform-xiaohongshu/>。
- 上游 README 的“提前一天”背景：`/Users/rolex/Documents/Codes/githubProject/social-auto-upload/README.md:234-238`。

### 平台官方创作者页面（LIVE）

本次未登录访问的官方页面仅返回登录壳/标题，没有公开窗口、分钟精度或时区/DST文本，不能据此填入数值：

- 抖音：<https://creator.douyin.com/creator-micro/content/upload>
- 小红书：<https://creator.xiaohongshu.com/publish/publish>
- 视频号：<https://channels.weixin.qq.com/platform/post/create>
- 快手帮助入口：<https://www.kuaishou.com/help/feedback>

### 时间标准（官方 Python 文档）

- `datetime.now(tz=None)` 本地 naive 时间；`tz` 非空时转换到该时区：<https://docs.python.org/3/library/datetime.html#datetime.datetime.now>。

## 8. 执行记录（本 artifact 内）

- 核对 `daemon/uv.lock` revision，并对 upstream 工作树与 `daemon/.venv` 关键文件 hash 做一致性检查。
- 阅读 `CONTEXT.md`、ADR-0001/0002/0005/0006/0008、既有 research 与历史测量；发现小红书窗口历史值与当前注册表冲突，保留为未确认。
- 逐平台阅读 `base_video.py`、`files_times.py`、`myUtils/postVideo.py`、四个 uploader 和 `sau_backend.py`；确认共同 2h 下限、无源码 max、整点 `daily_times`、naive local time、`startDays` 位置参数缺陷、同步 batch 形态。
- 访问上游作者文档和平台官方创作者公开页面；作者文档只说明参数/次日策略，平台未登录页面未披露窗口数值。
- 未修改产品代码、`CONTEXT.md` 或 ADR；本文件是本任务唯一新增 Markdown artifact。
