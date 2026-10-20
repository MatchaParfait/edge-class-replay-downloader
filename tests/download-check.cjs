const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const id = process.env.REPLAY_EXTENSION_ID || "plodkkochjanbcoifkkmidhkplhndohb";

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let manager, queuedKey;
  try {
    const context = browser.contexts()[0];
    manager = context.pages().find(p => p.url() === `chrome-extension://${id}/popup.html`) || await context.newPage();
    await manager.goto(`chrome-extension://${id}/popup.html`);
    await manager.waitForFunction(() => document.querySelector("#records tr"));
    const session = await browser.newBrowserCDPSession();
    // CDP automation otherwise routes files to its temporary artifact directory.
    await session.send("Browser.setDownloadBehavior", { behavior: "default" });
    const get = () => manager.evaluate(async () => (await chrome.runtime.sendMessage({ type: "get-state" })).state);
    const state = await get();
    const record = state.records[0];
    queuedKey = record.files.find(f => f.view === "courseware").key;
    const previous = state.tasks.find(t => t.key === queuedKey);
    if (previous?.status === "complete") {
      const [existing] = await manager.evaluate(async (downloadId) => chrome.downloads.search({ id: downloadId }), previous.downloadId);
      if (existing?.filename.includes("playwright-artifacts-")) {
        await manager.evaluate(async (key) => {
          await chrome.runtime.sendMessage({ type: "clear-finished" });
        }, queuedKey);
      }
    }
    const result = await manager.evaluate(async (recordId) => chrome.runtime.sendMessage({
      type: "queue", ids: [recordId.id], views: ["courseware"], source: recordId.source, scanId: recordId.scanId,
    }), { id: record.id, source: state.course, scanId: state.scan.id });
    assert.equal(result.ok, true);
    const deadline = Date.now() + 120000;
    let task, lastReceived = -1;
    while (Date.now() < deadline) {
      task = (await get()).tasks.find(t => t.key === queuedKey);
      if (task?.received !== lastReceived) {
        lastReceived = task?.received;
        console.log(JSON.stringify({ status: task?.status, received: task?.received, total: task?.total }));
      }
      if (task?.status === "complete" || task?.status === "error") break;
      await new Promise(r => setTimeout(r, 2000));
    }
    assert.equal(task?.status, "complete", task?.error || "Download did not complete within 120 seconds");
    const [download] = await manager.evaluate(async (downloadId) => chrome.downloads.search({ id: downloadId }), task.downloadId);
    const stat = await fs.stat(download.filename);
    assert.equal(stat.size, record.files.find(f => f.view === "courseware").bytes);
    assert.ok(download.filename.includes("课堂回放"), "The browser must use the actual named download directory");
    await manager.waitForFunction(() => document.querySelector("#queue-summary").textContent.includes("完成 1"));
    const output = path.resolve(__dirname, "../../edge-class-replay-downloader-qa");
    await fs.writeFile(path.join(output, "download-result.json"), JSON.stringify({
      filename: download.filename, bytes: stat.size, downloadId: download.id, state: download.state,
    }, null, 2));
    await manager.screenshot({ path: path.join(output, "download-complete.png"), fullPage: true });
    console.log(JSON.stringify({ savedFile: download.filename, bytes: stat.size, state: download.state }));
  } catch (error) {
    // A timed-out test must not leave an unexpected active test download behind.
    if (manager && queuedKey) await manager.evaluate(async (key) => {
      const state = (await chrome.runtime.sendMessage({ type: "get-state" })).state;
      const task = state.tasks.find(t => t.key === key);
      if (task?.status === "active" && task.downloadId != null) await chrome.downloads.cancel(task.downloadId);
    }, queuedKey).catch(() => {});
    throw error;
  } finally {
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "default" });
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
