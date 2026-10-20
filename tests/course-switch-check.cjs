const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const core = require("../core.js");
const id = process.env.REPLAY_EXTENSION_ID || "plodkkochjanbcoifkkmidhkplhndohb";
const output = path.resolve(__dirname, "../../edge-class-replay-downloader-qa");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let source, originalName;
  try {
    const context = browser.contexts()[0];
    source = context.pages().find(p => p.url().includes("teacherVideoResource.htm"));
    assert.ok(source, "A logged-in classroom course list must be open");
    originalName = await source.evaluate(() => document.querySelector(".teacher-video-resource").__vue__.weekList.courseName);
    const extensions = await context.newPage();
    await extensions.goto("edge://extensions");
    await extensions.evaluate(async (extensionId) => new Promise((resolve, reject) => {
      chrome.developerPrivate.reload(extensionId, { failQuietly: true }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    }), id);
    for (const p of context.pages().filter(p => p.url().startsWith(`chrome-extension://${id}/popup.html`))) {
      await p.reload().catch(() => {});
    }
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/popup.html`);
    await manager.bringToFront();
    const errors = [];
    manager.on("pageerror", e => errors.push(e.message));
    const get = () => manager.evaluate(async () => (await chrome.runtime.sendMessage({ type: "get-state" })).state);
    async function ready(name) {
      const deadline = Date.now() + 90000;
      let current;
      do {
        current = await get();
        if (current.course?.courseName === name && current.scan?.status === "complete") break;
        await new Promise(resolve => setTimeout(resolve, 300));
      } while (Date.now() < deadline);
      assert.equal(current.course?.courseName, name);
      assert.equal(current.scan.status, "complete");
      assert.ok(current.records.every(r => r.status === "ready"));
      await manager.waitForFunction(({ name, count }) =>
        document.querySelector("#course-name").textContent === name &&
        document.querySelectorAll("#records tr").length === count,
      { name, count: current.records.length });
      return current;
    }
    async function choose(name) {
      await source.bringToFront();
      await source.locator(".course-name").filter({ hasText: name }).click();
      await source.waitForFunction(name => {
        const list = document.querySelector(".teacher-video-resource").__vue__;
        return !list.loading && list.weekList.courseName === name &&
          list.videoInfoData.every(record => record.courseId === list.weekList.courseId);
      }, name);
    }
    let current = await ready(originalName);
    const oldTasks = current.tasks.map(t => ({ key: t.key, courseName: t.courseName, status: t.status }));
    const courses = await source.locator(".course-name").allTextContents();
    const sequence = [...courses.map(n => n.trim()).filter(n => n && n !== originalName), originalName];
    const results = [];
    for (const name of sequence) {
      const stale = { source: current.course, scanId: current.scan.id,
        ids: current.records.map(r => r.id), views: ["courseware"] };
      await manager.locator("#search").fill("a-filter-that-must-be-cleared");
      await choose(name);
      // The manager is hidden, so the old result has not been refreshed yet.
      for (const type of ["queue", "export-links"]) {
        const blocked = await manager.evaluate(async (message) => chrome.runtime.sendMessage(message), { type, ...stale });
        assert.equal(blocked.ok, false, "A stale course must never be downloadable/exportable");
      }
      await manager.bringToFront();
      current = await ready(name);
      const pageIds = await source.evaluate(() => document.querySelector(".teacher-video-resource").__vue__.videoInfoData.map(r => r.id).sort());
      assert.deepEqual(current.records.map(r => r.id).sort(), pageIds);
      assert.equal(await manager.locator("#search").inputValue(), "");
      assert.equal(await manager.locator("#week-filter").inputValue(), "");
      assert.ok((await manager.locator("#source-status").textContent()).includes(name));
      assert.deepEqual(current.tasks.map(t => ({ key: t.key, courseName: t.courseName, status: t.status })), oldTasks);
      const exported = await manager.evaluate(async (message) => chrome.runtime.sendMessage(message), {
        type: "export-links", source: current.course, scanId: current.scan.id,
        ids: current.records.map(r => r.id), views: ["courseware"],
      });
      assert.equal(exported.ok, true);
      const files = core.selectedFiles(current.records, pageIds, ["courseware"]);
      assert.deepEqual(exported.urls, files.map(f => f.url));
      assert.ok(files.every(f => f.filename.startsWith(`课堂回放/${core.safeName(name)}/`)));
      results.push({ course: name, lessons: pageIds.length, coursewareFiles: files.length,
        teacherFiles: current.records.flatMap(r => r.files).filter(f => f.view === "teacher").length });
      console.log(JSON.stringify(results.at(-1)));
    }
    const before = current.scan.id;
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal((await get()).scan.id, before, "Repeated context checks must not rescan an unchanged page");
    assert.deepEqual(errors, []);
    await fs.mkdir(output, { recursive: true });
    await manager.setViewportSize({ width: 1440, height: 1100 });
    await manager.screenshot({ path: path.join(output, "course-switch-desktop.png"), fullPage: true });
    await manager.setViewportSize({ width: 390, height: 844 });
    assert.ok(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await manager.screenshot({ path: path.join(output, "course-switch-mobile.png"), fullPage: true });
    await manager.setViewportSize({ width: 1440, height: 1100 });
    const info = await extensions.evaluate(async (extensionId) => {
      const info = await chrome.developerPrivate.getExtensionInfo(extensionId);
      return { version: info.version, manifestErrors: info.manifestErrors, runtimeErrors: info.runtimeErrors };
    }, id);
    assert.deepEqual(info.manifestErrors, []); assert.deepEqual(info.runtimeErrors, []);
    assert.equal(info.version, require("../manifest.json").version);
    await fs.writeFile(path.join(output, "course-switch-results.json"), JSON.stringify({ results, extension: info, pageErrors: errors }, null, 2));
    console.log(JSON.stringify({ extension: info, staleSubmissionsBlocked: sequence.length * 2, pageErrors: errors }));
  } finally {
    if (source && originalName) {
      const name = await source.evaluate(() => document.querySelector(".teacher-video-resource").__vue__.weekList.courseName).catch(() => "");
      if (name !== originalName) await source.locator(".course-name").filter({ hasText: originalName }).click().catch(() => {});
    }
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "default" });
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
