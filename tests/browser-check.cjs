const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const core = require("../core.js");
const EXTENSION_ID = process.env.REPLAY_EXTENSION_ID || "plodkkochjanbcoifkkmidhkplhndohb";
const output = path.resolve(__dirname, "../../edge-class-replay-downloader-qa");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  try {
    const context = browser.contexts()[0];
    const source = context.pages().find(p => p.url().includes("teacherVideoResource.htm"));
    assert.ok(source, "A logged-in course list must be open");
    const manager = await context.newPage();
    const errors = [];
    manager.on("pageerror", e => errors.push(e.message));
    await manager.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await manager.waitForFunction(() => document.querySelector("#source-tab").value);
    const sourceOption = await manager.locator("#source-tab option").filter({ hasText: "课程列表" }).first().getAttribute("value");
    await manager.locator("#source-tab").selectOption(sourceOption);
    const getState = () => manager.evaluate(async () => (await chrome.runtime.sendMessage({
      type: "get-state", tabId: Number(document.querySelector("#source-tab").value),
    })).state);
    const previousScan = (await getState()).scan?.id;
    await manager.locator("#scan").click();
    let state;
    const deadline = Date.now() + 120000;
    do {
      state = await getState();
      if (state.scan?.id !== previousScan && state.scan?.status === "complete") break;
      await new Promise(r => setTimeout(r, 300));
    } while (Date.now() < deadline);
    assert.notEqual(state.scan?.id, previousScan);
    assert.equal(state.scan?.status, "complete");
    assert.equal(state.scan.current, state.scan.total);
    assert.ok(state.records.length >= 1);
    assert.ok(state.records.every(r => r.status === "ready"), JSON.stringify(state.records.filter(r => r.status !== "ready")));
    assert.ok(state.records.every(r => r.files.some(f => f.view === "courseware")));
    assert.ok(state.records.every(r => r.files.some(f => f.view === "teacher")));
    const total = state.records.length;
    await manager.waitForFunction((count) => document.querySelectorAll("#records tr").length === count &&
      document.querySelectorAll("#records td.ready").length === count, total);
    assert.equal(await manager.locator("#records tr").count(), total);
    assert.equal(await manager.locator("#selected-files").textContent(), `${core.selectedFiles(state.records, state.records.map(r=>r.id), ["courseware"]).length} 个文件`);
    await manager.locator("#week-filter").selectOption("1");
    const firstWeek = state.records.filter(r => r.week === "1");
    assert.equal(await manager.locator("#records tr").count(), firstWeek.length);
    assert.equal(await manager.locator("#selected-files").textContent(), `${firstWeek.length} 个文件`);
    await manager.locator("#view-teacher").check();
    assert.equal(await manager.locator("#selected-files").textContent(), `${firstWeek.length * 2} 个文件`);
    const exportEvent = manager.waitForEvent("download");
    await manager.locator("#export").click();
    const exported = await exportEvent;
    await fs.mkdir(output, { recursive: true });
    await exported.saveAs(path.join(output, "week1-links.txt"));
    assert.equal((await fs.readFile(path.join(output, "week1-links.txt"), "utf8")).trim().split(/\r?\n/).length, firstWeek.length * 2);
    await manager.locator("#view-teacher").uncheck();
    await manager.locator("#records tr").first().locator('input[type="checkbox"]').uncheck();
    await manager.reload();
    await manager.waitForFunction(() => document.querySelector("#records tr"));
    assert.equal(await manager.locator("#records tr").first().locator('input[type="checkbox"]').isChecked(), false);
    await manager.locator("#select-all").check();

    const player = context.pages().find(p => p.url().includes("videoDetail.htm"));
    if (player) {
      const current = await player.evaluate(() => {
        const vm = document.querySelector(".course-video-detail").__vue__;
        return { id: vm.videoDetailObj.id, urls: [...document.querySelectorAll("video")].map(v => v.currentSrc || v.src) };
      });
      const record = state.records.find(r => r.id === current.id);
      if (record) assert.ok(record.files.every(f => current.urls.includes(f.url)), "Actual file addresses must match the real player");
    }
    const sample = state.records[0].files.find(f => f.view === "courseware");
    const controller = new AbortController();
    const response = await fetch(sample.url, { headers: { Range: "bytes=0-1023" }, signal: controller.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel(); controller.abort();
    assert.ok(response.ok);
    assert.ok(Buffer.from(first.value).includes(Buffer.from("ftyp")), "The sample must be an MP4, not an error page");
    assert.ok(response.headers.get("content-type")?.includes("video"), "The source must return actual video");

    await manager.locator("#week-filter").selectOption("");
    await manager.setViewportSize({ width: 1440, height: 1100 });
    await manager.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
    await manager.setViewportSize({ width: 390, height: 844 });
    assert.ok(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page-level horizontal overflow");
    await manager.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
    await manager.setViewportSize({ width: 1440, height: 1100 });
    await fs.writeFile(path.join(output, "scan-results.json"), JSON.stringify(state, null, 2));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ course: state.course.courseName, lessons: total,
      coursewareFiles: state.records.flatMap(r=>r.files).filter(f=>f.view==="courseware").length,
      teacherFiles: state.records.flatMap(r=>r.files).filter(f=>f.view==="teacher").length,
      coursewareBytes: state.records.flatMap(r=>r.files).filter(f=>f.view==="courseware").reduce((s,f)=>s+f.bytes,0),
      mediaResponse: { status: response.status, type: response.headers.get("content-type"), range: response.headers.get("content-range") },
      screenshots: output, pageErrors: errors }, null, 2));
  } finally {
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "default" });
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
