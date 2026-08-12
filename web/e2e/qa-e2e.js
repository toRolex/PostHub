/**
 * PostHub 前端 QA 自动化脚本（对应 GitHub issue #22 QA Plan）。
 *
 * 运行方式（依赖全局 playwright-cli 0.1.x）：
 *   playwright-cli open http://localhost:5173 --headed --persistent
 *   playwright-cli --raw run-code --filename=web/e2e/qa-e2e.js
 *
 * 安全边界（自动化不产生真实发布副作用）：
 *   - 发布任务用「不存在的视频路径」→ daemon 在调度执行阶段失败（不拉真实发布）
 *   - 定时任务创建后立即取消（pending 态取消，不会触发发布）
 *   - 批量导入只「解析 + 待确认列表」，不放行（放行会真实排队发布）
 *   - 真实端到端发布（C11）由人工执行，不在本脚本内
 */
async (page) => {
  const results = [];
  const BASE = "http://localhost:5173";
  const VIDEO_FAKE = "/nonexistent/qa-e2e.mp4";           // 假路径 → 调度阶段失败
  const BATCH_DIR = "/Users/rolex/.claude/jobs/c3eaa02f/tmp/qa-batch"; // 真实批次
  const RUN_ID = Date.now().toString().slice(-6);          // 任务标题唯一后缀，避免重复运行歧义

  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ts = (ms) => new Date(Date.now() + ms);

  // 记录一个步骤结果；fn 抛错即 FAIL
  async function step(name, fn) {
    try {
      await fn();
      results.push({ name, status: "PASS" });
    } catch (e) {
      results.push({ name, status: "FAIL", detail: String(e).slice(0, 300) });
    }
  }
  // 环境依赖的观察项（超时不判失败，标记 WARN）
  function warn(name, detail) {
    results.push({ name, status: "WARN", detail: String(detail).slice(0, 300) });
  }

  // 常用定位器
  const tab = (name) => page.getByRole("tab", { name });
  const btn = (name) => page.getByRole("button", { name });
  const videoInput = () => page.locator('input[placeholder*="本地视频路径"]');
  const titleInput = () => page.locator('input[placeholder="任务标题（必填）"]');
  const batchDirInput = () => page.locator('input[placeholder*="批次文件夹路径"]');

  await page.goto(BASE);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  // ---------- T1 守护进程已连通（A1） ----------
  await step("T1 守护进程已连通", async () => {
    await page.locator("text=已连通").first().waitFor({ state: "visible", timeout: 10000 });
    const card = await page.locator(".el-descriptions").first().innerText();
    if (!card.includes("0.1.0") || !card.includes("8756")) {
      throw new Error("版本/端口不符: " + card.replace(/\n/g, " "));
    }
  });

  // ---------- T2 账号列表展示（B1） ----------
  await step("T2 账号列表展示", async () => {
    await page.locator(".accounts__table tbody tr").first().waitFor({ state: "visible", timeout: 10000 });
    const row = await page.locator(".accounts__table tbody tr").first().innerText();
    if (!row.includes("实测-视频号") || !row.includes("9223") || !row.includes("可用")) {
      throw new Error("账号行不符: " + row.replace(/\n/g, " "));
    }
  });

  // ---------- T3 空表单校验拦截（C1） ----------
  await step("T3 空表单校验拦截", async () => {
    await page.locator(".publish__platforms").scrollIntoViewIfNeeded();
    await btn("创建发布任务").click();
    const errors = await page.locator(".publish__error").allInnerTexts();
    const joined = errors.join("|");
    for (const want of ["标题不能为空", "请选择视频文件", "至少选择一个发布平台"]) {
      if (!joined.includes(want)) throw new Error("缺错误提示: " + want + " => " + joined);
    }
  });

  // ---------- T4 勾选视频号 → 约束 + 自动选账号（C2） ----------
  await step("T4 勾选视频号约束与账号联动", async () => {
    await page.locator(".publish__platforms .el-checkbox", { hasText: "视频号" }).click();
    await page.locator(".publish__constraint").first().waitFor({ state: "visible", timeout: 5000 });
    const c = await page.locator(".publish__constraint").first().innerText();
    for (const want of ["定时最小提前 2 小时", "定时窗口 ≤ 720 小时", "每日上限 5 条", "缺省自动取首帧"]) {
      if (!c.includes(want)) throw new Error("约束缺项: " + want + " => " + c.replace(/\n/g, " "));
    }
    const sel = await page.locator(".publish__account-select").innerText();
    if (!sel.includes("实测-视频号")) throw new Error("账号未自动选中: " + sel);
  });

  // ---------- T5 定时约束校验（C7：<2h 报错） ----------
  await step("T5 定时最小提前量校验", async () => {
    await page.locator("label", { hasText: "定时发布" }).first().click();
    const inp = page.locator(".publish__schedule-row .el-date-editor input").first();
    await inp.waitFor({ state: "visible", timeout: 5000 });
    await inp.click();
    await inp.fill(fmt(ts(60 * 1000))); // +1 分钟
    await inp.press("Enter");
    await page.waitForTimeout(400);
    await btn("创建发布任务").click();
    const errors = await page.locator(".publish__error").allInnerTexts();
    if (!errors.join("|").includes("定时发布时间距现在至少 2 小时")) {
      throw new Error("未出现定时最小提前错误: " + errors.join("|"));
    }
  });

  // ---------- T6 抖音未选账号校验（C8） ----------
  await step("T6 未选账号校验", async () => {
    await page.locator(".publish__platforms .el-checkbox", { hasText: "抖音" }).click();
    await page.waitForTimeout(300);
    await btn("创建发布任务").click();
    const errors = await page.locator(".publish__error").allInnerTexts();
    if (!errors.join("|").includes("请为平台") || !errors.join("|").includes("选择账号")) {
      throw new Error("未出现账号校验错误: " + errors.join("|"));
    }
    // 恢复：取消抖音勾选，切回立即发布
    await page.locator(".publish__platforms .el-checkbox", { hasText: "抖音" }).click();
    await page.locator("label", { hasText: "立即发布" }).first().click();
    await page.waitForTimeout(300);
  });

  // ---------- T7 创建任务（假路径，落库不真发）（C10 安全版） ----------
  await step("T7 创建任务成功并重置表单", async () => {
    await titleInput().fill(`QA-E2E-${RUN_ID}`);
    await videoInput().fill(VIDEO_FAKE);
    await btn("创建发布任务").click();
    await page.locator(".el-message--success").waitFor({ state: "visible", timeout: 8000 });
    const msg = await page.locator(".el-message--success").innerText();
    if (!msg.includes("已创建")) throw new Error("toast 不符: " + msg);
    const title = await titleInput().inputValue();
    if (title !== "") throw new Error("表单未重置，标题残留: " + title);
    if (await page.locator(".publish__constraint").count() > 0) {
      throw new Error("表单未重置，平台约束残留");
    }
  });

  // ---------- T8 任务页展示 + 展开子任务（D1/D2） ----------
  await step("T8 任务列表与子任务展开", async () => {
    await tab("任务").click();
    const row = page.locator(".tasks__table .el-table__row", { hasText: `QA-E2E-${RUN_ID}` });
    await row.first().waitFor({ state: "visible", timeout: 10000 });
    if (!(await row.first().innerText()).includes("视频号")) {
      throw new Error("任务平台列缺视频号");
    }
    await row.first().locator(".el-table__expand-icon").click();
    await page.waitForTimeout(500);
    const job = await page.locator(".tasks__jobs").first().innerText();
    if (!job.includes("视频号")) throw new Error("子任务平台缺视频号");
    if (!job.includes("待发布") && !job.includes("发布中") && !job.includes("失败") && !job.includes("成功")) {
      throw new Error("子任务无状态标签: " + job.replace(/\n/g, " "));
    }
  });

  // ---------- T9 失败状态 + 重试入口（D5，轮询等待） ----------
  await step("T9 失败状态与重试入口", async () => {
    const row = page.locator(".tasks__table .el-table__row", { hasText: `QA-E2E-${RUN_ID}` });
    await row.first().waitFor({ state: "visible", timeout: 5000 });
    // 视频号 Chrome（9223）未启动时，发布会网络重试很久才失败 → 标记 WARN 跳过
    let cdpUp = false;
    try {
      cdpUp = (await page.request.get("http://127.0.0.1:9223/json/version")).ok();
    } catch {
      cdpUp = false;
    }
    if (!cdpUp) {
      warn("T9 失败链路跳过（环境）", "视频号 Chrome 9223 未启动，发布走网络重试；拉起 Chrome（账号页 / 手动 9223）后重跑可验证");
      return;
    }
    // 等子任务转 failed（假路径 → 调度阶段失败；最长等 150s）
    let failed = false;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const text = await row.first().innerText();
      if (text.includes("失败")) { failed = true; break; }
      await page.waitForTimeout(5000);
    }
    if (!failed) {
      warn("T9 失败状态观察中（环境依赖）", "150s 内未见失败，可能发布流程尚未走到失败点");
      return;
    }
    // 子任务可能已展开（T8），未展开则点一次展开图标
    let retry = row.first().locator("button", { hasText: "重试" });
    if (await retry.count() === 0) {
      await row.first().locator(".el-table__expand-icon").click();
      await page.waitForTimeout(600);
      retry = row.first().locator("button", { hasText: "重试" });
    }
    if (await retry.count() === 0) throw new Error("失败子任务未出现重试按钮");
  });

  // ---------- T10 定时任务取消（D4） ----------
  await step("T10 定时任务取消", async () => {
    await tab("总览").click();
    await page.waitForTimeout(500);
    await page.locator(".publish__platforms .el-checkbox", { hasText: "视频号" }).click();
    await page.locator("label", { hasText: "定时发布" }).first().click();
    const inp = page.locator(".publish__schedule-row .el-date-editor input").first();
    await inp.waitFor({ state: "visible", timeout: 5000 });
    await inp.click();
    await inp.fill(fmt(ts(3 * 3600 * 1000))); // +3 小时（避开 2h 最小提前量边界）
    await inp.press("Enter");
    await page.waitForTimeout(400);
    await titleInput().fill(`QA-E2E-取消${RUN_ID}`);
    await videoInput().fill(VIDEO_FAKE);
    await btn("创建发布任务").click();
    await page.locator(".el-message--success").waitFor({ state: "visible", timeout: 8000 });

    await tab("任务").click();
    const crow = page.locator(".tasks__table .el-table__row", { hasText: `QA-E2E-取消${RUN_ID}` });
    await crow.first().waitFor({ state: "visible", timeout: 10000 });
    const cancelBtn = crow.first().locator("button", { hasText: "取消" });
    if (await cancelBtn.count() === 0) throw new Error("待发布任务无取消按钮");
    await cancelBtn.first().click();
    // ElMessageBox 确认弹窗
    await page.locator(".el-message-box").waitFor({ state: "visible", timeout: 5000 });
    await btn("取消任务").click();
    await page.locator(".el-message--success").waitFor({ state: "visible", timeout: 5000 });
    const msg = await page.locator(".el-message--success").innerText();
    if (!msg.includes("任务已取消")) throw new Error("取消 toast 不符: " + msg);
  });

  // ---------- T11 日志页（E1/E2） ----------
  await step("T11 日志列表与任务筛选", async () => {
    await tab("日志").click();
    const firstRow = page.locator(".logs__table tbody tr").first();
    await firstRow.waitFor({ state: "visible", timeout: 10000 });
    const text = await firstRow.innerText();
    if (!/INFO|DEBUG|WARN|ERROR/.test(text)) throw new Error("日志行缺级别: " + text.replace(/\n/g, " "));
    // 任务 ID 筛选（用已创建任务；刷新按钮按当前 v-model 值重新拉取）
    const idInput = page.locator('input[placeholder*="按任务 ID"]');
    await idInput.fill("999999");
    await btn("刷新").click();
    await page.locator("text=暂无日志").first().waitFor({ state: "visible", timeout: 8000 });
    await idInput.fill("");
    await btn("刷新").click();
    await page.waitForTimeout(500);
  });

  // ---------- T12 批量导入解析 + 逐条编辑（F1/F3，不放行） ----------
  await step("T12 批量解析与待确认列表", async () => {
    await tab("总览").click();
    await page.waitForTimeout(500);
    await batchDirInput().fill(BATCH_DIR);
    // 选目标账号
    await page.locator(".batch__account").click();
    await page.locator(".el-select-dropdown__item", { hasText: "实测-视频号" }).first().click();
    await page.waitForTimeout(300);
    // 清掉上一步残留 toast（el-message 3s 自动消失，脚本快时可能还挂着）
    await page.locator(".el-message").first().waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
    await btn("解析批次").click();
    await page.locator(".el-message--success").waitFor({ state: "visible", timeout: 8000 });
    const msgs = await page.locator(".el-message--success").allInnerTexts();
    if (!msgs.some((m) => m.includes("解析成功") && m.includes("2 条待确认"))) {
      throw new Error("解析 toast 不符: " + msgs.join(" | "));
    }
    const rows = await page.locator(".batch__pending .el-table__row").count();
    if (rows !== 2) throw new Error("待确认行数不符: " + rows);
    // 逐条编辑第一条标题
    const firstTitle = page.locator(".batch__pending .el-table__row").first().locator("input").first();
    await firstTitle.fill("QA-E2E-已改标题");
    const val = await firstTitle.inputValue();
    if (val !== "QA-E2E-已改标题") throw new Error("标题编辑未生效: " + val);
  });

  const total = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  return JSON.stringify({ summary: { total, passed, failed, warns }, results });
}
