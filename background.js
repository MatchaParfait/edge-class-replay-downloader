importScripts("core.js", "page-bridge.js", "updates.js");

const STATE_KEY = "classReplayV2";
const ALARM = "class-replay-recovery";
const updates = ReplayUpdates.create(chrome);
let cache;
let loading;
let serial = Promise.resolve();
const scanning = new Set();
let pumping = false;
const initialState = () => ({
  version: 2, course: null, records: [], scan: null, catalogs: {}, tasks: [],
  paused: false, concurrency: 2,
});
async function state() {
  if (!cache) {
    loading ||= chrome.storage.local.get(STATE_KEY).then((stored) => {
      cache = stored[STATE_KEY] || initialState();
      cache.catalogs ||= {};
      if (cache.course?.tabId && !cache.catalogs[cache.course.tabId]) {
        cache.catalogs[cache.course.tabId] = {
          course: cache.course, records: cache.records || [], scan: cache.scan,
        };
      }
      return cache;
    });
    await loading;
  }
  return cache;
}
function catalog(data, tabId) {
  data.catalogs ||= {};
  data.catalogs[tabId] ||= { course: null, records: [], scan: null };
  return data.catalogs[tabId];
}
// Preserve the previous top-level format for migration and standalone legacy callers.
function touchCatalog(data, tabId) {
  const current = catalog(data, tabId);
  data.course = current.course; data.records = current.records; data.scan = current.scan;
}
// Serialize mutations so scan progress, UI commands and download events cannot overwrite each other.
function mutate(callback) {
  const job = serial.then(async () => {
    const data = await state();
    const result = await callback(data);
    await chrome.storage.local.set({ [STATE_KEY]: data });
    return result;
  });
  serial = job.catch(() => {});
  return job;
}
async function page(tabId, action, id) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func: classReplayPage, args: [action, id || null],
  });
  if (!results[0]?.result) throw new Error("页面没有返回录像数据，请刷新课堂页面后重试。");
  return results[0].result;
}
async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}
async function scanLoop(tabId) {
  if (scanning.has(tabId)) return;
  scanning.add(tabId);
  try {
    while (true) {
      const data = catalog(await state(), tabId);
      const scan = data.scan;
      if (!scan || scan.status !== "running") break;
      const record = scan.pending[scan.current];
      if (!record) {
        await mutate((s) => {
          const c = catalog(s, tabId);
          if (c.scan?.id === scan.id && c.scan.status === "running") {
            c.scan.status = "complete"; c.scan.finishedAt = Date.now();
            touchCatalog(s, tabId);
          }
        });
        break;
      }
      let result, error;
      try { result = ReplayCore.normalizeDetail(await page(scan.tabId, "detail", record.id)); }
      catch (cause) { error = cause.message; }
      await mutate((s) => {
        const c = catalog(s, tabId);
        if (c.scan?.id !== scan.id || c.scan.status !== "running") return;
        const index = c.records.findIndex((r) => r.id === record.id);
        if (index >= 0) c.records[index] = result
          ? { ...record, ...result, status: "ready", error: undefined }
          : { ...record, files: [], status: "error", error };
        c.scan.current += 1;
        touchCatalog(s, tabId);
      });
    }
  } finally { scanning.delete(tabId); }
}
async function startScan(tabId, retryOnly, replace = false) {
  const existing = catalog(await state(), tabId);
  if (existing.scan?.status === "running" && !replace) throw new Error("已有扫描正在进行。");
  let snapshot;
  if (!retryOnly) snapshot = await page(tabId, "snapshot");
  else {
    const context = { ...await page(existing.course.tabId, "context"), tabId: existing.course.tabId };
    if (context.status !== "ready" || !ReplayCore.sameSource(existing.course, context)) {
      throw new Error("页面课程已变化，请先同步当前课程，不能重试上一门课程。");
    }
  }
  await ensureAlarm();
  await mutate((s) => {
    const c = catalog(s, tabId);
    if (c.scan?.status === "running" && !replace) throw new Error("已有扫描正在进行。");
    const records = retryOnly ? c.records.filter((r) => r.status === "error") : snapshot.records;
    if (retryOnly && !records.length) throw new Error("没有需要扫描的录像。");
    if (!retryOnly) {
      c.course = { ...snapshot, records: undefined, tabId };
      c.records = records.map((r) => ({ ...r, files: [], status: "pending" }));
    }
    c.scan = {
      id: crypto.randomUUID(), tabId,
      status: "running", current: 0, total: records.length, pending: records, startedAt: Date.now(),
    };
    touchCatalog(s, tabId);
  });
  void scanLoop(tabId).catch(console.error);
  return { ok: true };
}
async function syncSource(tabId) {
  const source = { ...await page(tabId, "context"), tabId };
  if (source.status !== "ready") return { ok: true, source };
  if (!ReplayCore.sameSource(catalog(await state(), tabId).course, source)) await startScan(tabId, false, true);
  return { ok: true, source };
}
async function verifySource(message) {
  const data = catalog(await state(), message.source?.tabId);
  if (!ReplayCore.sameSource(data.course, message.source) || data.scan?.id !== message.scanId) {
    throw new Error("录像列表已更新，请等待当前页面同步后重新选择。");
  }
  const source = { ...await page(data.course.tabId, "context"), tabId: data.course.tabId };
  if (source.status !== "ready" || !ReplayCore.sameSource(data.course, source)) {
    throw new Error("页面课程已变化，已阻止使用旧列表，请等待当前课程同步。");
  }
}
function applyDownload(task, item) {
  task.status = item.state === "in_progress" ? "active" : item.state === "complete" ? "complete" : "error";
  task.error = item.error || "";
  task.received = item.bytesReceived || 0;
  task.total = item.totalBytes > 0 ? item.totalBytes : task.bytes;
  task.browserPaused = Boolean(item.paused);
}
async function reconcile() {
  const data = await state();
  const watched = data.tasks.filter((task) => task.downloadId != null &&
    ["active", "starting"].includes(task.status)).map((task) => ({ key: task.key, id: task.downloadId }));
  if (!watched.length) return;
  const updates = await Promise.all(watched.map(async (task) => {
    try { return { ...task, item: (await chrome.downloads.search({ id: task.id }))[0] }; }
    catch { return task; }
  }));
  await mutate((s) => {
    for (const update of updates) {
      const task = s.tasks.find((t) => t.key === update.key && t.downloadId === update.id);
      if (!task || !["active", "starting"].includes(task.status)) continue;
      if (update.item) applyDownload(task, update.item);
      else { task.status = "error"; task.error = "下载记录已丢失，请重试"; }
    }
  });
}
async function recoverStarting() {
  const data = await state();
  // A worker can stop after the browser accepted a download but before its ID was saved.
  const stranded = data.tasks.filter((t) => t.status === "starting" && t.downloadId == null);
  for (const task of stranded) {
    if (task.retryDownloadId != null) {
      await mutate((s) => {
        const current = s.tasks.find((t) => t.key === task.key);
        if (current?.status === "starting" && current.downloadId == null) current.status = "queued";
      });
      continue;
    }
    const matches = await chrome.downloads.search({
      url: task.url, startedAfter: new Date(task.startedAt - 1000).toISOString(),
    });
    await mutate((s) => {
      const current = s.tasks.find((t) => t.key === task.key);
      if (!current || current.status !== "starting" || current.downloadId != null) return;
      const match = matches.sort((a, b) => b.id - a.id)[0];
      if (match) { current.downloadId = match.id; applyDownload(current, match); }
      else current.status = "queued";
    });
  }
}
async function retryAttempt(task) {
  if (task.retryDownloadId == null) return null;
  const read = async () => {
    const [item] = await chrome.downloads.search({ id: task.retryDownloadId });
    if (item && (item.url !== task.url ||
      (item.byExtensionId && item.byExtensionId !== chrome.runtime.id))) {
      throw new Error("旧下载记录与当前任务不一致，已停止重试以保护文件。");
    }
    return item;
  };
  let item = await read();
  if (!item || ["complete", "in_progress"].includes(item.state)) return item || null;
  if (item.state !== "interrupted") throw new Error("无法确认旧下载状态，请查看浏览器下载记录。");
  if (item.canResume) {
    try { await chrome.downloads.resume(item.id); } catch {}
    item = await read();
    if (item && ["complete", "in_progress"].includes(item.state)) return item;
  }
  if (!item) return null;
  // Erasing an interrupted item lets the browser discard its own partial file.
  // Never removeFile(): that API deletes completed files, not failed fragments.
  let erased = await chrome.downloads.erase({
    id: item.id, state: "interrupted", url: task.url,
  });
  if (!erased.includes(item.id)) {
    item = await read();
    if (!item || ["complete", "in_progress"].includes(item.state)) return item || null;
    // Some Chromium builds filter "interrupted" as cancelled only. Recheck the
    // exact item before the ID-only fallback; erase never deletes complete files.
    if (item.state === "interrupted") {
      erased = await chrome.downloads.erase({ id: item.id, url: task.url });
      if (erased.includes(item.id)) return null;
      item = await read();
    }
    if (item && !["complete", "in_progress"].includes(item.state)) {
      throw new Error("旧下载残留未能清理，未创建新下载，请重试或查看浏览器下载记录。");
    }
    return item || null;
  }
  return null;
}
async function pump() {
  if (pumping) return;
  const currentState = await state();
  if (currentState.paused || !currentState.tasks.some((t) => t.status === "queued")) return;
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const task = await mutate((s) => {
        const active = s.tasks.filter((t) => ["active", "starting"].includes(t.status)).length;
        if (s.paused || active >= s.concurrency) return null;
        const next = s.tasks.find((t) => t.status === "queued");
        if (!next) return null;
        next.status = "starting"; next.startedAt = Date.now();
        return { ...next };
      });
      if (!task) break;
      try {
        const previous = await retryAttempt(task);
        if (previous) {
          await mutate((s) => {
            const current = s.tasks.find((t) => t.key === task.key);
            if (current) {
              current.downloadId = previous.id; delete current.retryDownloadId;
              applyDownload(current, previous);
            }
          });
          continue;
        }
        await mutate((s) => {
          const current = s.tasks.find((t) => t.key === task.key);
          if (current) {
            delete current.retryDownloadId;
            current.received = 0; current.browserPaused = false; current.error = "";
          }
        });
        const downloadId = await chrome.downloads.download({
          url: task.url, filename: task.filename, conflictAction: "uniquify", saveAs: false,
        });
        await mutate((s) => {
          const current = s.tasks.find((t) => t.key === task.key);
          if (current) { current.downloadId = downloadId; current.status = "active"; }
        });
        // Catch files that completed or failed before their ID was recorded.
        await reconcile();
      } catch (error) {
        await mutate((s) => {
          const current = s.tasks.find((t) => t.key === task.key);
          if (current) { current.status = "error"; current.error = error.message; }
        });
      }
    }
  } finally { pumping = false; }
}
async function queueDownloads(message) {
  await verifySource(message);
  await ensureAlarm();
  let added = 0, skipped = 0;
  await mutate((s) => {
    const c = catalog(s, message.source?.tabId);
    if (!ReplayCore.sameSource(c.course, message.source) || c.scan?.id !== message.scanId) {
      throw new Error("录像列表已更新，请重新选择后下载。");
    }
    const files = ReplayCore.selectedFiles(c.records, message.ids || [], message.views || []);
    if (!files.length) throw new Error("选中课程没有所选视角的可用文件。");
    for (const file of files) {
      if (s.tasks.some((t) => t.key === file.key || t.url === file.url)) { skipped++; continue; }
      s.tasks.push({ ...file, status: "queued", received: 0, total: file.bytes }); added++;
    }
  });
  void pump().catch(console.error);
  return { ok: true, added, skipped };
}
async function retryDownloads() {
  await mutate((s) => {
    s.tasks.filter((t) => t.status === "error").forEach((t) => {
      t.retryDownloadId = t.downloadId ?? t.retryDownloadId ?? null;
      t.status = "queued"; t.error = ""; t.downloadId = null;
    });
  });
  await ensureAlarm();
  void pump().catch(console.error);
  return { ok: true };
}
async function openManager(sourceTab) {
  const base = chrome.runtime.getURL("popup.html");
  const isCoursePage = /^https?:\/\/class\.cumt\.edu\.cn\//.test(sourceTab?.url || "");
  const url = isCoursePage ? `${base}?sourceTab=${sourceTab.id}` : base;
  const tabs = await chrome.tabs.query({ url: `${base}*` });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { url, active: true });
  else await chrome.tabs.create({ url });
}
async function installPanel(tabId, force = false) {
  if (!force) {
    try {
      const ready = await chrome.tabs.sendMessage(tabId, { type: "class-replay-panel-ready" });
      if (ready?.version === chrome.runtime.getManifest().version) return;
    } catch {}
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try { globalThis.__classReplayFloatingPanel?.dispose(); } catch {}
      delete globalThis.__classReplayFloatingPanel;
    },
  });
  await chrome.scripting.executeScript({
    target: { tabId }, files: ["vendor/lucide.min.js", "floating-panel.js"],
  });
}
async function installExistingPanels() {
  const tabs = await chrome.tabs.query({ url: ["http://class.cumt.edu.cn/*", "https://class.cumt.edu.cn/*"] });
  await Promise.all(tabs.map((tab) => installPanel(tab.id, true).catch(console.error)));
}
chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (/^https?:\/\/class\.cumt\.edu\.cn\//.test(tab?.url || "")) {
      await installPanel(tab.id);
      const result = await chrome.tabs.sendMessage(tab.id, { type: "toggle-class-replay-panel" });
      if (result?.ok) return;
    }
    await openManager(tab);
  })().catch(console.error);
});
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state && !delta.error && !delta.paused) return;
  void (async () => {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (item) await mutate((s) => {
      const task = s.tasks.find((t) => t.downloadId === delta.id);
      if (task) applyDownload(task, item);
    });
    await pump();
  })().catch(console.error);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void recover().catch(console.error);
  if (alarm.name === updates.alarm) void updates.check().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm().then(recover).catch(console.error);
  void updates.start().catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm(); void installExistingPanels().catch(console.error);
  void updates.start().catch(console.error);
});
async function recover() {
  if (!pumping) await recoverStarting();
  await reconcile();
  resumeScans(await state());
  await pump();
  const data = await state();
  if (!Object.values(data.catalogs || {}).some((c) => c.scan?.status === "running") &&
    !data.tasks.some((t) => ["queued", "starting", "active"].includes(t.status))) {
    await chrome.alarms.clear(ALARM);
  }
}
function resumeScans(data) {
  for (const [tabId, value] of Object.entries(data.catalogs || {})) {
    if (value.scan?.status === "running") void scanLoop(Number(tabId)).catch(console.error);
  }
}
async function handle(message, sender) {
  const embedded = new URL(sender.url).searchParams.get("embedded") === "1";
  if (embedded) {
    if (!sender.tab?.id || !sender.frameId ||
      !/^https?:\/\/class\.cumt\.edu\.cn\//.test(sender.tab.url || "")) {
      throw new Error("浮窗未关联课堂页面，请在课堂页面重新展开。");
    }
    if (["scan", "sync-source", "get-state", "retry-scan", "stop-scan"].includes(message.type)) {
      message = { ...message, tabId: sender.tab.id };
    }
    if (["queue", "export-links"].includes(message.type) && message.source?.tabId !== sender.tab.id) {
      throw new Error("浮窗只能处理所在页面的录像。");
    }
  }
  switch (message.type) {
    case "panel-context":
      if (!embedded) throw new Error("当前界面不是页面浮窗。");
      return { ok: true, tabId: sender.tab.id };
    case "open-manager":
      await openManager(embedded ? sender.tab : undefined);
      return { ok: true };
    case "get-state": {
      await reconcile();
      const s = await state();
      void pump().catch(console.error); resumeScans(s);
      const c = message.tabId ? catalog(s, message.tabId) : s;
      return { ok: true, state: structuredClone({ ...s,
        course: c.course, records: c.records, scan: c.scan, catalogs: undefined,
        updates: await updates.getState() }) };
    }
    case "check-updates": return { ok: true, updates: await updates.check(message.manual === true) };
    case "download-update": return { ok: true, updates: await updates.download() };
    case "scan": return startScan(message.tabId, false);
    case "sync-source": return syncSource(message.tabId);
    case "retry-scan": return startScan(message.tabId || (await state()).course?.tabId, true);
    case "stop-scan":
      await mutate((s) => {
        const tabId = message.tabId || s.course?.tabId;
        const c = catalog(s, tabId);
        if (c.scan?.status === "running") c.scan.status = "stopped";
        touchCatalog(s, tabId);
      });
      return { ok: true };
    case "queue": return queueDownloads(message);
    case "export-links": {
      await verifySource(message);
      const s = catalog(await state(), message.source?.tabId);
      if (!ReplayCore.sameSource(s.course, message.source) || s.scan?.id !== message.scanId) {
        throw new Error("录像列表已更新，请重新选择后导出。");
      }
      const files = ReplayCore.selectedFiles(s.records, message.ids || [], message.views || []);
      if (!files.length) throw new Error("当前选择没有可导出的录像。");
      return { ok: true, urls: files.map((f) => f.url), courseName: s.course.courseName };
    }
    case "pause-queue":
      await mutate((s) => { s.paused = Boolean(message.paused); });
      void pump().catch(console.error); return { ok: true };
    case "concurrency":
      await mutate((s) => { s.concurrency = Math.max(1, Math.min(4, Number(message.value) || 2)); });
      void pump().catch(console.error); return { ok: true };
    case "retry-downloads": return retryDownloads();
    case "clear-finished":
      await mutate((s) => { s.tasks = s.tasks.filter((t) => t.status !== "complete"); });
      return { ok: true };
    case "clear-waiting":
      await mutate((s) => { s.tasks = s.tasks.filter((t) => t.status !== "queued"); });
      return { ok: true };
    default: throw new Error("未知操作");
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id ||
    sender.url?.split("?")[0] !== chrome.runtime.getURL("popup.html")) return;
  handle(message, sender).then(respond).catch((error) => respond({ ok: false, error: error.message }));
  return true;
});
void updates.start().catch(console.error);
