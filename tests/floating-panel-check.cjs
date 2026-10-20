const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const extensionId = process.env.REPLAY_EXTENSION_ID || "plodkkochjanbcoifkkmidhkplhndohb";
const output = path.resolve(__dirname, "../../edge-class-replay-downloader-qa");
const base = `chrome-extension://${extensionId}/popup.html`;
async function currentPanel(page) {
  await page.locator("#class-replay-downloader-root #drawer").evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  const expected = await page.locator("#class-replay-downloader-root iframe").getAttribute("src");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const frame = page.frames().find(frame => !frame.isDetached() && frame.url() === expected);
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("The current panel frame did not navigate");
}
async function selectAll(frame) {
  await frame.evaluate(() => {
    globalThis.selectDebug = [];
    for (const type of ["pointerdown", "click", "change", "focus"]) {
      document.addEventListener(type, (event) => selectDebug.push({
        type, target: event.target.id, checked: document.getElementById("select-all").checked,
        fresh: freshSource(), selected: selected.size,
      }), { capture: true, once: true });
    }
  });
  try { await frame.locator("#select-all").check(); }
  catch (error) {
    console.error("Select-all state", await frame.evaluate(() => ({
      checked: document.getElementById("select-all").checked,
      indeterminate: document.getElementById("select-all").indeterminate,
      fresh: freshSource(), size: selected.size, filtered: filtered().length,
      course: data.course?.courseName, sourceStatus: sourceState.status,
      events: selectDebug,
    })));
    throw error;
  }
}

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let source, originalName, player;
  try {
    const context = browser.contexts()[0];
    source = context.pages().find(page => page.url().includes("teacherVideoResource.htm"));
    assert.ok(source, "A logged-in course list is required");
    originalName = await source.evaluate(() => document.querySelector(".teacher-video-resource").__vue__.weekList.courseName);
    const extensions = await context.newPage();
    await extensions.goto("edge://extensions");
    await extensions.evaluate(async id => new Promise((resolve, reject) => {
      chrome.developerPrivate.reload(id, { failQuietly: true }, () =>
        chrome.runtime.lastError ? reject(Error(chrome.runtime.lastError.message)) : resolve());
    }), extensionId);
    const manager = context.pages().find(page => page.url().startsWith(base)) || await context.newPage();
    if (manager.url().startsWith(base)) await manager.reload();
    else await manager.goto(base);
    const get = (frame = manager) => frame.evaluate(async () => (await chrome.runtime.sendMessage({
      type: "get-state", tabId: Number(document.querySelector("#source-tab").value),
    })).state);
    const initialTasks = (await get()).tasks.map(t => ({ key: t.key, courseName: t.courseName, status: t.status }));
    const host = source.locator("#class-replay-downloader-root");
    await source.bringToFront();
    await source.setViewportSize({ width: 1440, height: 1000 });
    await host.waitFor({ state: "attached" });
    assert.equal(await host.count(), 1);
    const launcher = host.locator("#launcher");
    await launcher.click();
    let panel = await currentPanel(source);
    assert.ok(panel);
    const ready = async (frame, name) => {
      try {
        await frame.waitForFunction(name => document.querySelector("#course-name")?.textContent === name &&
          document.querySelector("#scan-status").textContent.includes("扫描完成") &&
          document.querySelector("#records tr"), name, { timeout: 45000 });
      } catch (error) {
        console.error("Panel not ready", await frame.evaluate(() => ({
          hidden: document.hidden, course: document.querySelector("#course-name").textContent,
          source: document.querySelector("#source-status").textContent,
          status: document.querySelector("#scan-status").textContent,
          notice: document.querySelector("#notice").textContent,
        })));
        throw error;
      }
    };
    await ready(panel, originalName);
    console.log("Course panel recognized the parent page");
    const parent = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: "panel-context" }));
    assert.equal(parent.ok, true);
    assert.equal(await panel.locator("#source-tab").isDisabled(), true);
    assert.equal(Number(await panel.locator("#source-tab").inputValue()), parent.tabId);
    const sourceRecords = await source.evaluate(() => document.querySelector(".teacher-video-resource").__vue__.videoInfoData.map(r => ({ id: r.id, week: String(r.week) })));
    assert.equal(await panel.locator("#records tr").count(), sourceRecords.length);
    await selectAll(panel);
    await panel.locator("#view-courseware").check();
    await panel.locator("#view-teacher").check();
    await panel.locator("#week-filter").selectOption("1");
    const weekCount = sourceRecords.filter(r => r.week === "1").length;
    assert.equal(await panel.locator("#records tr").count(), weekCount);
    const downloadEvent = source.waitForEvent("download");
    await panel.locator("#export").click();
    const exported = await downloadEvent;
    await fs.mkdir(output, { recursive: true });
    await exported.saveAs(path.join(output, "floating-export.txt"));
    assert.equal((await fs.readFile(path.join(output, "floating-export.txt"), "utf8")).trim().split(/\r?\n/).length, weekCount * 2);
    console.log("View selection, week filter and link export passed");
    await panel.locator("#view-teacher").uncheck();
    await panel.locator("#week-filter").selectOption("");
    await panel.locator("#records tr").first().locator('input[type="checkbox"]').uncheck();
    const beforeCollapse = (await get(panel)).scan.id;
    await panel.locator("#close-panel").click();
    await host.locator("#drawer").waitFor({ state: "hidden" });
    assert.equal(await host.locator("iframe").count(), 0, "Collapsed panels must not keep polling");
    assert.equal((await manager.evaluate(async tabId =>
      (await chrome.runtime.sendMessage({ type: "get-state", tabId })).state, parent.tabId)).scan.id, beforeCollapse);
    await launcher.click();
    await source.waitForFunction(() => document.querySelector("#class-replay-downloader-root")?.shadowRoot.querySelector("iframe"));
    panel = await currentPanel(source);
    await ready(panel, originalName);
    assert.equal(await panel.locator("#records tr").first().locator('input[type="checkbox"]').isChecked(), false);
    console.log("Collapse, reopen and selection restore passed");
    await selectAll(panel);
    await panel.locator("#search").focus();
    await panel.locator("#search").press("Escape");
    await host.locator("#drawer").waitFor({ state: "hidden" });
    await launcher.click();
    panel = await currentPanel(source);
    await ready(panel, originalName);
    const other = (await source.locator(".course-name").allTextContents()).map(s => s.trim()).find(s => s !== originalName);
    await source.locator(".course-name").filter({ hasText: other }).click();
    await ready(panel, other);
    assert.deepEqual((await get()).tasks.map(t => ({ key: t.key, courseName: t.courseName, status: t.status })), initialTasks);
    await source.locator(".course-name").filter({ hasText: originalName }).click();
    await ready(panel, originalName);
    await source.screenshot({ path: path.join(output, "floating-course-desktop.png") });
    await source.setViewportSize({ width: 390, height: 844 });
    await source.screenshot({ path: path.join(output, "floating-course-mobile.png") });
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await source.setViewportSize({ width: 1440, height: 1000 });

    await panel.locator("#open-manager").click();
    await manager.waitForFunction(() => !document.hidden && document.querySelector("#course-name"));
    await source.bringToFront();
    await panel.locator("#close-panel").click();

    const recordId = sourceRecords[0].id;
    player = await context.newPage();
    await player.goto(`http://class.cumt.edu.cn/TeachingCenterStudentWeb/index.html#/fullpage/videoDetail.htm?id=${recordId}`,
      { waitUntil: "domcontentloaded" });
    await player.bringToFront();
    await player.waitForFunction(() => document.querySelectorAll("video").length >= 1, null, { timeout: 45000 });
    await player.evaluate(() => document.querySelectorAll("video").forEach(v => v.pause()));
    await player.locator("#class-replay-downloader-root #launcher").click();
    const videoPanel = await currentPanel(player);
    console.log("Video page panel opened");
    await ready(videoPanel, originalName);
    assert.equal(await videoPanel.locator("#records tr").count(), 1);
    const state = await get(videoPanel);
    assert.equal(state.course.scope, "recording");
    assert.equal(state.records[0].id, recordId);
    const actual = await player.evaluate(() => {
      const detail = document.querySelector(".course-video-detail").__vue__.videoDetailObj;
      return [...(detail.teacherViewFiles || []), ...(detail.vgaViewFiles || [])].map(f => f.outerIp + f.videoStorePath);
    });
    assert.ok(state.records[0].files.every(f => actual.includes(f.url)));
    assert.deepEqual(state.tasks.map(t => ({ key: t.key, courseName: t.courseName, status: t.status })), initialTasks);
    await player.evaluate(async () => {
      await Promise.race([
        Promise.all([...document.querySelectorAll("video")].map(async video => {
          video.muted = true;
          await video.play().catch(() => {});
        })),
        new Promise(resolve => setTimeout(resolve, 8000)),
      ]);
      document.querySelectorAll("video").forEach(video => video.pause());
    });
    await player.setViewportSize({ width: 1440, height: 1000 });
    await player.screenshot({ path: path.join(output, "floating-player-desktop.png") });
    await player.setViewportSize({ width: 390, height: 844 });
    await player.screenshot({ path: path.join(output, "floating-player-mobile.png") });
    assert.ok(await videoPanel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await videoPanel.locator("#close-panel").click();
    await player.locator("#class-replay-downloader-root #drawer").waitFor({ state: "hidden" });
    await player.close();
    await source.bringToFront();
    await launcher.click();
    panel = await currentPanel(source);
    await ready(panel, originalName);
    const info = await extensions.evaluate(async id => {
      const value = await chrome.developerPrivate.getExtensionInfo(id);
      return { version: value.version, manifestErrors: value.manifestErrors, runtimeErrors: value.runtimeErrors };
    }, extensionId);
    assert.equal(info.version, require("../manifest.json").version);
    assert.deepEqual(info.manifestErrors, []); assert.deepEqual(info.runtimeErrors, []);
    const result = { course: originalName, courseRecordings: sourceRecords.length, playerRecordings: 1,
      exportLinks: weekCount * 2, parentTabId: parent.tabId, switchedTo: other, extension: info };
    await fs.writeFile(path.join(output, "floating-results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (player && !player.isClosed()) await player.close().catch(() => {});
    if (source && originalName) {
      const current = await source.evaluate(() => document.querySelector(".teacher-video-resource").__vue__.weekList.courseName).catch(() => "");
      if (current !== originalName) await source.locator(".course-name").filter({ hasText: originalName }).click().catch(() => {});
      await source.setViewportSize({ width: 1440, height: 1000 }).catch(() => {});
    }
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "default" });
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
