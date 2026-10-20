const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../core.js");
const updates = require("../updates.js");
const manifest = require("../manifest.json");
const root = path.resolve(__dirname, "..");
function harness(persisted) {
  const listeners = {};
  const downloads = new Map();
  const downloadCalls = [], resumeCalls = [], eraseCalls = [], operations = [];
  let nextId = 0, maxActive = 0;
  const stored = persisted || {};
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    storage: { local: { async get(key) { return structuredClone({ [key]: stored[key] }); },
      async set(value) { Object.assign(stored, structuredClone(value)); } } },
    scripting: { async executeScript({ args, target }) {
      const fixture = chrome.sources?.[target.tabId] || chrome;
      const prefix = fixture.sourcePrefix || "";
      const name = fixture.sourceName || "Test";
      const ids = ["one", "two", "three"].map(id => prefix + id);
      const source = { sourceKey: `course:${name}`, revision: ids.join("|"), courseName: name,
        scope: "course", status: fixture.sourceLoading ? "loading" : "ready", count: 3 };
      if (args[0] === "context") return [{ result: source }];
      if (args[0] === "snapshot") return [{ result: { ...source, records:
        ids.map(id => ({ id, courseName: name, week: "1" })) } }];
      if (args[1] === prefix + "two" && fixture.failDetail) throw new Error("test timeout");
      if (fixture.detailGate) await fixture.detailGate;
      return [{ result: { id: args[1], courseName: name, week: "1",
        startTime: "2026-09-09 19:55:00", endTime: "2026-09-09 20:45:00",
        teacherViewFiles: [], vgaViewFiles: [{ id: args[1], outerIp: "http://example.com/",
          videoStorePath: `/${args[1]}.mp4`, videoFileSize: 1024 }] } }];
    } },
    alarms: { async get() { return {}; }, async create() {}, async clear() {}, onAlarm: event("alarm") },
    downloads: {
      async download(options) {
        downloadCalls.push(options); operations.push("download");
        const id = ++nextId;
        downloads.set(id, { id, url: options.url, state: "in_progress", bytesReceived: 0, totalBytes: 1024 });
        maxActive = Math.max(maxActive, [...downloads.values()].filter(d => d.state === "in_progress").length);
        return id;
      },
      async search(query) { return query.id ? [downloads.get(query.id)].filter(Boolean)
        : [...downloads.values()].filter(d => d.url === query.url); },
      async resume(id) {
        resumeCalls.push(id); operations.push("resume");
        if (chrome.resumeFailure) throw new Error("Cannot resume");
        const item = downloads.get(id);
        if (!item?.canResume) throw new Error("Cannot resume");
        if (chrome.resumeNoop) return;
        item.state = "in_progress"; item.error = "";
        if (chrome.resumeGate) await chrome.resumeGate;
      },
      async erase(query) {
        eraseCalls.push(query); operations.push("erase");
        if (chrome.eraseFailure) throw new Error("Cannot clean partial download");
        chrome.beforeErase?.();
        const item = downloads.get(query.id);
        if (chrome.interruptedFilterBug && query.state === "interrupted") return [];
        if (!item || (query.state && item.state !== query.state) || item.url !== query.url) return [];
        downloads.delete(item.id);
        return [item.id];
      },
      onChanged: event("changed"),
    },
    tabs: { async query() { return []; }, async create() {} },
    action: { onClicked: event("click") },
    runtime: { id: "test", getURL: p => `chrome-extension://test/${p}`, getManifest: () => manifest,
      onMessage: event("message"), onStartup: event("startup"), onInstalled: event("installed") },
  };
  const context = vm.createContext({ chrome, console, ReplayCore: core,
    ReplayUpdates: { create: chrome => updates.create(chrome, { fetch: async () => ({ status: 404 }) }) },
    crypto: require("node:crypto").webcrypto,
    structuredClone, Date, URL, setTimeout, clearTimeout, importScripts() {}, classReplayPage() {} });
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  const request = (type, args = {}, senderOverride) => new Promise((resolve) => {
    const identity = ["queue", "export-links"].includes(type)
      ? { source: structuredClone(stored.classReplayV2?.course), scanId: stored.classReplayV2?.scan?.id } : {};
    listeners.message({ type, ...identity, ...args },
      senderOverride || { id: "test", url: "chrome-extension://test/popup.html" }, resolve);
  });
  async function settle() { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); }
  return { chrome, downloads, downloadCalls, resumeCalls, eraseCalls, operations,
    stored, request, settle, get maxActive() { return maxActive; },
    async wake() { listeners.alarm({ name: "class-replay-recovery" }); await settle(); },
    async finish(id, error) {
      const item = downloads.get(id); item.state = error ? "interrupted" : "complete";
      item.error = error; item.bytesReceived = error ? 0 : 1024;
      listeners.changed({ id, state: { current: item.state } }); await settle();
    } };
}
test("scan persists details and continues without the manager page", async () => {
  const h = harness(); h.chrome.failDetail = true;
  assert.equal((await h.request("scan", { tabId: 1 })).ok, true);
  await h.settle();
  const state = (await h.request("get-state")).state;
  assert.equal(state.scan.status, "complete");
  assert.equal(state.records.filter(r => r.status === "ready").length, 2);
  assert.equal(state.records[1].status, "error");
  h.chrome.failDetail = false;
  await h.request("retry-scan"); await h.settle();
  assert.equal(h.stored.classReplayV2.records.filter(r => r.status === "ready").length, 3);
  assert.ok(!h.stored.classReplayV2.records[1].error);
});
test("queue caps concurrency, deduplicates and advances on completion", async () => {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  const args = { ids: ["one", "two", "three"], views: ["courseware"] };
  const first = await h.request("queue", args); await h.settle();
  assert.equal(first.added, 3); assert.equal(h.downloads.size, 2);
  assert.equal((await h.request("queue", args)).skipped, 3); await h.settle();
  assert.equal(h.downloads.size, 2);
  await h.finish(1);
  assert.equal(h.downloads.size, 3); assert.equal(h.maxActive, 2);
});
test("pausing queue leaves active files alone, retry replaces failed jobs", async () => {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  await h.request("concurrency", { value: 1 });
  await h.request("queue", { ids: ["one", "two", "three"], views: ["courseware"] }); await h.settle();
  await h.request("pause-queue", { paused: true }); await h.finish(1, "NETWORK_FAILED");
  assert.equal(h.downloads.size, 1);
  await h.request("retry-downloads"); await h.settle(); assert.equal(h.downloads.size, 1);
  await h.request("pause-queue", { paused: false }); await h.settle();
  assert.equal(h.downloadCalls.length, 2); assert.equal(h.maxActive, 1);
  await h.request("clear-waiting");
  assert.equal(h.stored.classReplayV2.tasks.length, 1);
});
test("startup recovers persisted pending work after worker restart", async () => {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  await h.request("pause-queue", { paused: true });
  await h.request("queue", { ids: ["one"], views: ["courseware"] });
  const restored = harness(structuredClone(h.stored));
  assert.equal((await restored.request("get-state")).state.tasks.length, 1);
  await restored.request("pause-queue", { paused: false }); await restored.settle();
  assert.equal(restored.downloads.size, 1);
});
test("concurrent queue submissions do not duplicate tasks or exceed the limit", async () => {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  const args = { ids: ["one", "two", "three"], views: ["courseware"] };
  const results = await Promise.all([h.request("queue", args), h.request("queue", args), h.request("queue", args)]);
  await h.settle();
  assert.equal(results.reduce((sum, result) => sum + result.added, 0), 3);
  assert.equal(h.stored.classReplayV2.tasks.length, 3);
  assert.equal(h.downloads.size, 2);
  assert.equal(h.maxActive, 2);
});
test("recovery attaches an accepted download instead of submitting it again", async () => {
  const first = harness();
  await first.request("scan", { tabId: 1 }); await first.settle();
  await first.request("pause-queue", { paused: true });
  await first.request("queue", { ids: ["one"], views: ["courseware"] });
  const persisted = structuredClone(first.stored);
  const task = persisted.classReplayV2.tasks[0];
  task.status = "starting"; task.startedAt = Date.now();
  persisted.classReplayV2.paused = false;
  const h = harness(persisted);
  h.downloads.set(13, { id: 13, url: task.url, state: "in_progress", bytesReceived: 100, totalBytes: 1024 });
  await h.wake();
  assert.equal(h.stored.classReplayV2.tasks[0].downloadId, 13);
  assert.equal(h.stored.classReplayV2.tasks[0].status, "active");
  assert.equal(h.downloads.size, 1);
});
test("switching the current page automatically replaces the recordings, not queued tasks", async () => {
  const h = harness();
  await h.request("sync-source", { tabId: 1 }); await h.settle();
  const oldScan = h.stored.classReplayV2.scan.id;
  await h.request("sync-source", { tabId: 1 }); await h.settle();
  assert.equal(h.stored.classReplayV2.scan.id, oldScan, "Unchanged pages must not trigger a rescan");
  await h.request("pause-queue", { paused: true });
  await h.request("queue", { ids: ["one"], views: ["courseware"] });
  h.chrome.sourceName = "Database"; h.chrome.sourcePrefix = "db-";
  const result = await h.request("sync-source", { tabId: 1 }); await h.settle();
  assert.equal(result.source.courseName, "Database");
  assert.ok(h.stored.classReplayV2.records.every(r => r.courseName === "Database" && r.id.startsWith("db-")));
  assert.equal(h.stored.classReplayV2.tasks[0].courseName, "Test");
  assert.equal(h.stored.classReplayV2.tasks[0].status, "queued");
  const exported = await h.request("export-links", { ids: ["db-one"], views: ["courseware"] });
  assert.ok(exported.urls[0].endsWith("/db-one.mp4"));
});
test("download and export recheck the live course before using saved results", async () => {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  const oldSource = structuredClone(h.stored.classReplayV2.course);
  const scanId = h.stored.classReplayV2.scan.id;
  h.chrome.sourceName = "Database"; h.chrome.sourcePrefix = "db-";
  for (const type of ["queue", "export-links"]) {
    const result = await h.request(type, { ids: ["one"], views: ["courseware"], source: oldSource, scanId });
    assert.equal(result.ok, false);
    assert.match(result.error, /页面课程已变化/);
  }
  assert.equal(h.downloads.size, 0); assert.equal(h.stored.classReplayV2.tasks.length, 0);
  await h.request("sync-source", { tabId: 1 }); await h.settle();
  const stale = await h.request("queue", { ids: ["one"], views: ["courseware"], source: oldSource, scanId });
  assert.equal(stale.ok, false);
});
test("loading source disables old submissions without replacing state prematurely", async () => {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  h.chrome.sourceLoading = true;
  const result = await h.request("sync-source", { tabId: 1 });
  assert.equal(result.source.status, "loading");
  assert.equal(h.stored.classReplayV2.course.courseName, "Test");
  assert.equal((await h.request("queue", { ids: ["one"], views: ["courseware"] })).ok, false);
});
test("a late response from the previous course cannot enter the replacement scan", async () => {
  const h = harness();
  let release;
  h.chrome.detailGate = new Promise(resolve => { release = resolve; });
  await h.request("sync-source", { tabId: 1 }); await h.settle();
  h.chrome.sourceName = "Database"; h.chrome.sourcePrefix = "db-";
  await h.request("sync-source", { tabId: 1 });
  h.chrome.detailGate = null; release(); await h.settle();
  assert.equal(h.stored.classReplayV2.scan.status, "complete");
  assert.ok(h.stored.classReplayV2.records.every(r => r.courseName === "Database" && r.status === "ready"));
});
const panelSender = (tabId = 7) => ({
  id: "test", url: "chrome-extension://test/popup.html?embedded=1&channel=test",
  frameId: 42, tab: { id: tabId, url: "http://class.cumt.edu.cn/TeachingCenterStudentWeb/index.html" },
});
test("embedded UI derives its source tab from the browser, not a supplied tab ID", async () => {
  const h = harness(), sender = panelSender();
  assert.equal((await h.request("panel-context", {}, sender)).tabId, 7);
  await h.request("sync-source", { tabId: 999 }, sender); await h.settle();
  assert.equal(h.stored.classReplayV2.course.tabId, 7);
  const result = await h.request("export-links", { ids: ["one"], views: ["courseware"] }, sender);
  assert.equal(result.ok, true);
});
test("embedded UI cannot submit results for a different tab", async () => {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  for (const type of ["queue", "export-links"]) {
    const result = await h.request(type, { ids: ["one"], views: ["courseware"] }, panelSender(7));
    assert.equal(result.ok, false); assert.match(result.error, /所在页面/);
  }
  assert.equal(h.downloads.size, 0);
});
test("embedded UI rejects missing or non-classroom parent tabs", async () => {
  const h = harness();
  const absent = panelSender(); delete absent.tab;
  const outside = panelSender(); outside.tab.url = "https://example.com/";
  for (const sender of [absent, outside, { ...panelSender(), frameId: 0 }]) {
    assert.equal((await h.request("panel-context", {}, sender)).ok, false);
  }
});
test("two page catalogs scan independently and repeated sync does not restart either", async () => {
  const h = harness();
  let release;
  h.chrome.sources = {
    1: { sourceName: "Database", sourcePrefix: "db-", detailGate: new Promise(resolve => { release = resolve; }) },
    7: { sourceName: "Writing", sourcePrefix: "writing-" },
  };
  await h.request("sync-source", { tabId: 1 });
  await h.request("sync-source", { tabId: 7 }); await h.settle();
  const db = (await h.request("get-state", { tabId: 1 })).state;
  const writing = (await h.request("get-state", { tabId: 999 }, panelSender())).state;
  assert.equal(db.scan.status, "running");
  assert.equal(writing.scan.status, "complete");
  assert.equal(writing.course.tabId, 7);
  assert.ok(writing.records.every(r => r.id.startsWith("writing-") && r.status === "ready"));
  assert.equal(writing.catalogs, undefined, "Only the requested catalog is exposed to the UI");
  for (let i = 0; i < 3; i++) {
    await h.request("sync-source", { tabId: 1 });
    await h.request("sync-source", { tabId: 7 });
  }
  assert.equal((await h.request("get-state", { tabId: 1 })).state.scan.id, db.scan.id);
  assert.equal((await h.request("get-state", { tabId: 7 })).state.scan.id, writing.scan.id);
  h.chrome.sources[1].detailGate = null; release(); await h.settle();
  const finished = (await h.request("get-state", { tabId: 1 })).state;
  assert.equal(finished.scan.status, "complete");
  assert.ok(finished.records.every(r => r.id.startsWith("db-") && r.status === "ready"));
  for (const current of [finished, writing]) {
    const exported = await h.request("export-links", { source: current.course, scanId: current.scan.id,
      ids: [current.records[0].id], views: ["courseware"] });
    assert.equal(exported.ok, true);
    assert.ok(exported.urls[0].endsWith(`/${current.records[0].id}.mp4`));
  }
  await h.request("pause-queue", { paused: true });
  for (const current of [finished, writing]) {
    const queued = await h.request("queue", { source: current.course, scanId: current.scan.id,
      ids: [current.records[0].id], views: ["courseware"] });
    assert.equal(queued.added, 1);
  }
  assert.equal((await h.request("get-state", { tabId: 1 })).state.tasks.length, 2);
  assert.equal((await h.request("get-state", { tabId: 7 })).state.tasks.length, 2);
});
test("embedded stop and retry affect only their parent catalog", async () => {
  const h = harness();
  let release;
  h.chrome.sources = {
    1: { sourceName: "Database", sourcePrefix: "db-", detailGate: new Promise(resolve => { release = resolve; }) },
    7: { sourceName: "Writing", sourcePrefix: "writing-", failDetail: true },
  };
  await h.request("scan", { tabId: 1 });
  await h.request("scan", { tabId: 7 }); await h.settle();
  const original = (await h.request("get-state", { tabId: 1 })).state.scan.id;
  h.chrome.sources[7].failDetail = false;
  assert.equal((await h.request("retry-scan", { tabId: 1 }, panelSender())).ok, true);
  await h.settle();
  assert.ok((await h.request("get-state", {}, panelSender())).state.records.every(r => r.status === "ready"));
  await h.request("stop-scan", { tabId: 1 }, panelSender());
  const db = (await h.request("get-state", { tabId: 1 })).state;
  assert.equal(db.scan.status, "running");
  assert.equal(db.scan.id, original);
  await h.request("stop-scan", { tabId: 1 });
  h.chrome.sources[1].detailGate = null; release(); await h.settle();
  assert.equal((await h.request("get-state", { tabId: 1 })).state.scan.status, "stopped");
});
test("legacy scan state migrates and multiple unfinished catalogs recover after worker restart", async () => {
  const old = harness();
  await old.request("scan", { tabId: 1 }); await old.settle();
  const persisted = structuredClone(old.stored);
  delete persisted.classReplayV2.catalogs;
  const migrated = harness(persisted);
  assert.equal((await migrated.request("get-state", { tabId: 1 })).state.records.length, 3);
  await migrated.request("pause-queue", { paused: true });
  assert.equal(migrated.stored.classReplayV2.catalogs[1].course.courseName, "Test");
  const saved = structuredClone(migrated.stored);
  const second = structuredClone(saved.classReplayV2.catalogs[1]);
  second.course.tabId = 7; second.scan.tabId = 7; second.scan.id = "second";
  saved.classReplayV2.catalogs[7] = second;
  for (const value of Object.values(saved.classReplayV2.catalogs)) {
    value.scan.status = "running"; value.scan.current = 0;
    value.records.forEach(record => { record.status = "pending"; record.files = []; });
  }
  const recovered = harness(saved);
  await recovered.wake();
  for (const tabId of [1, 7]) {
    const current = (await recovered.request("get-state", { tabId })).state;
    assert.equal(current.scan.status, "complete");
    assert.ok(current.records.every(r => r.status === "ready"));
  }
});
async function failedDownload() {
  const h = harness();
  await h.request("scan", { tabId: 1 }); await h.settle();
  await h.request("queue", { ids: ["one"], views: ["courseware"] }); await h.settle();
  await h.finish(1, "NETWORK_FAILED");
  return h;
}
test("retry resumes a resumable item using the same ID and partial bytes", async () => {
  const h = await failedDownload();
  h.downloads.get(1).canResume = true; h.downloads.get(1).bytesReceived = 512;
  await h.request("retry-downloads"); await h.settle();
  const task = h.stored.classReplayV2.tasks[0];
  assert.deepEqual(h.resumeCalls, [1]);
  assert.equal(h.eraseCalls.length, 0); assert.equal(h.downloadCalls.length, 1);
  assert.equal(task.downloadId, 1); assert.equal(task.status, "active"); assert.equal(task.received, 512);
  assert.equal(task.retryDownloadId, undefined);
});
test("nonresumable retry discards only the old interrupted item before starting again", async () => {
  const h = await failedDownload();
  await Promise.all([h.request("retry-downloads"), h.request("retry-downloads")]); await h.settle();
  assert.deepEqual(h.operations, ["download", "erase", "download"]);
  assert.equal(h.eraseCalls[0].id, 1); assert.equal(h.eraseCalls[0].state, "interrupted");
  assert.equal(h.eraseCalls[0].url, h.downloadCalls[0].url);
  assert.equal(h.downloads.has(1), false);
  assert.equal(h.stored.classReplayV2.tasks[0].downloadId, 2);
  assert.equal(h.maxActive, 1);
});
test("a failed browser resume falls back to cleanup before a new attempt", async () => {
  const h = await failedDownload();
  h.downloads.get(1).canResume = true; h.chrome.resumeFailure = true;
  await h.request("retry-downloads"); await h.settle();
  assert.deepEqual(h.operations, ["download", "resume", "erase", "download"]);
  assert.equal(h.stored.classReplayV2.tasks[0].status, "active");
});
test("a successful API response that leaves the browser interrupted falls back to clean restart", async () => {
  const h = await failedDownload();
  h.downloads.get(1).canResume = true; h.chrome.resumeNoop = true;
  await h.request("retry-downloads"); await h.settle();
  assert.deepEqual(h.operations, ["download", "resume", "erase", "download"]);
  assert.equal(h.stored.classReplayV2.tasks[0].status, "active");
});
test("state-filter incompatibility falls back to the verified exact download ID", async () => {
  const h = await failedDownload(); h.chrome.interruptedFilterBug = true;
  await h.request("retry-downloads"); await h.settle();
  assert.equal(h.eraseCalls.length, 2);
  assert.equal(h.eraseCalls[1].id, 1); assert.equal(h.eraseCalls[1].url, h.downloadCalls[0].url);
  assert.equal(h.eraseCalls[1].state, undefined);
  assert.equal(h.downloads.has(1), false);
  assert.equal(h.stored.classReplayV2.tasks[0].status, "active");
});
test("cleanup failure retains the old attempt ID and blocks new downloads until retry", async () => {
  const h = await failedDownload(); h.chrome.eraseFailure = true;
  await h.request("retry-downloads"); await h.settle();
  assert.equal(h.downloadCalls.length, 1);
  assert.equal(h.stored.classReplayV2.tasks[0].retryDownloadId, 1);
  assert.equal(h.stored.classReplayV2.tasks[0].status, "error");
  h.chrome.eraseFailure = false;
  await h.request("retry-downloads"); await h.settle();
  assert.equal(h.downloadCalls.length, 2); assert.equal(h.eraseCalls.length, 2);
});
test("retry adopts an already completed or externally resumed item without deleting it", async () => {
  for (const status of ["complete", "in_progress"]) {
    const h = await failedDownload(); h.downloads.get(1).state = status;
    await h.request("retry-downloads"); await h.settle();
    assert.equal(h.downloadCalls.length, 1); assert.equal(h.eraseCalls.length, 0);
    assert.equal(h.stored.classReplayV2.tasks[0].status, status === "complete" ? "complete" : "active");
  }
});
test("an item completing between inspection and cleanup is never erased or downloaded again", async () => {
  const h = await failedDownload();
  h.chrome.beforeErase = () => { h.downloads.get(1).state = "complete"; };
  await h.request("retry-downloads"); await h.settle();
  assert.equal(h.downloadCalls.length, 1); assert.equal(h.downloads.has(1), true);
  assert.equal(h.stored.classReplayV2.tasks[0].status, "complete");
});
test("retry refuses a mismatched download ID without erasing unrelated files", async () => {
  const h = await failedDownload(); h.downloads.get(1).url = "http://example.com/unrelated.mp4";
  await h.request("retry-downloads"); await h.settle();
  assert.equal(h.downloadCalls.length, 1); assert.equal(h.eraseCalls.length, 0);
  assert.match(h.stored.classReplayV2.tasks[0].error, /不一致/);
});
test("retry with missing browser history creates a fresh attempt without deleting files", async () => {
  const h = await failedDownload(); h.downloads.delete(1);
  await h.request("retry-downloads"); await h.settle();
  assert.equal(h.downloadCalls.length, 2); assert.equal(h.eraseCalls.length, 0);
  assert.equal(h.stored.classReplayV2.tasks[0].status, "active");
});
test("worker recovery during resume reattaches the original ID instead of submitting again", async () => {
  const h = await failedDownload(); h.downloads.get(1).canResume = true;
  let release;
  h.chrome.resumeGate = new Promise(resolve => { release = resolve; });
  await h.request("retry-downloads"); await h.settle();
  const persisted = structuredClone(h.stored), item = structuredClone(h.downloads.get(1));
  assert.equal(persisted.classReplayV2.tasks[0].status, "starting");
  assert.equal(persisted.classReplayV2.tasks[0].retryDownloadId, 1);
  release(); await h.settle();
  const recovered = harness(persisted); recovered.downloads.set(1, item);
  await recovered.wake();
  assert.equal(recovered.downloadCalls.length, 0); assert.equal(recovered.resumeCalls.length, 0);
  assert.equal(recovered.eraseCalls.length, 0);
  assert.equal(recovered.stored.classReplayV2.tasks[0].downloadId, 1);
  assert.equal(recovered.stored.classReplayV2.tasks[0].status, "active");
});
