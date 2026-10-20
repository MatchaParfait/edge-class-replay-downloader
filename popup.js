const $ = (id) => document.getElementById(id);
const core = ReplayCore;
const PREFS_KEY = "classReplayV2UI";
const embedded = new URL(location.href).searchParams.get("embedded") === "1";
document.documentElement.classList.toggle("embedded", embedded);
let parentTabId;
let data = { records: [], tasks: [] };
let selected = new Set();
let knownRecords = new Set();
let prefs = { views: ["courseware"], tabId: null };
let lastScanId;
let lastSourceKey;
let sourceState = { status: "checking" };
let tabSignature = "";
const requestedTab = Number(new URL(location.href).searchParams.get("sourceTab")) || null;
let recordSignature = "";
let taskSignature = "";
let refreshing = false;
let noticeTimer;
let checkingUpdate = false;
let downloadingUpdate = false;

function icons() { globalThis.lucide?.createIcons(); }
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").style.background = error ? "#8c3040" : "";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("notice").textContent = ""; }, error ? 15000 : 6000);
}
async function request(type, args = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...args });
  if (!result?.ok) throw new Error(result?.error || "插件后台没有响应，请重新加载扩展。");
  return result;
}
function views() {
  return ["courseware", "teacher"].filter((v) => $(`view-${v}`).checked);
}
async function savePrefs() {
  prefs = { ...prefs, views: views(), selected: [...selected], scanId: lastScanId,
    tabId: Number($("source-tab").value) || null };
  await chrome.storage.local.set({ [PREFS_KEY]: prefs });
}
async function tabs() {
  if (embedded) {
    if (!$("source-tab").value) {
      $("source-tab").replaceChildren(new Option("当前页面", String(parentTabId)));
      $("source-tab").disabled = true;
    }
    return;
  }
  const items = await chrome.tabs.query({ url: ["http://class.cumt.edu.cn/*", "https://class.cumt.edu.cn/*"] });
  const current = Number($("source-tab").value) || requestedTab || prefs.tabId || data.course?.tabId;
  items.sort((a, b) => Number(b.url.includes("teacherVideoResource")) - Number(a.url.includes("teacherVideoResource")));
  const signature = JSON.stringify(items.map((t) => [t.id, t.url, t.title]));
  if (signature === tabSignature) return;
  tabSignature = signature;
  $("source-tab").replaceChildren();
  for (const tab of items) {
    const option = document.createElement("option");
    option.value = tab.id;
    option.textContent = `${tab.url.includes("videoDetail") ? "播放页 · 仅当前一节" : "课程列表"} · ${tab.title || "云课堂"} · 标签 ${tab.id}`;
    $("source-tab").append(option);
  }
  if (!items.length) $("source-tab").append(new Option("未找到课堂页面", ""));
  else if (items.some((t) => t.id === current)) $("source-tab").value = String(current);
  $("scan").disabled = data.scan?.status === "running" || !items.length;
}
function freshSource() { return sourceState.status === "ready" && core.sameSource(data.course, sourceState); }
function filtered() {
  if (!freshSource()) return [];
  const week = $("week-filter").value;
  const query = $("search").value.trim().toLowerCase();
  return data.records.filter((r) => (!week || r.week === week) &&
    (!query || `${r.startTime} ${r.endTime} ${r.courseName}`.toLowerCase().includes(query)));
}
function visibleSelectedIds() { return filtered().filter((r) => selected.has(r.id)).map((r) => r.id); }
function chosenFiles() { return core.selectedFiles(data.records, visibleSelectedIds(), views()); }
function updateSelection() {
  const rows = filtered();
  const checked = rows.filter((r) => selected.has(r.id)).length;
  $("select-all").checked = rows.length > 0 && checked === rows.length;
  $("select-all").indeterminate = checked > 0 && checked < rows.length;
  $("select-all").disabled = rows.length === 0;
  $("selection-count").textContent = `${rows.length} 节课 · 当前已选 ${checked} 节`;
  const files = chosenFiles();
  $("selected-files").textContent = `${files.length} 个文件`;
  $("selected-size").textContent = core.formatBytes(files.reduce((sum, f) => sum + f.bytes, 0));
  $("download").disabled = !files.length;
  $("export").disabled = !files.length;
}
function makeCell(text, className) {
  const td = document.createElement("td");
  td.textContent = text || "";
  if (className) td.className = className;
  return td;
}
function renderRecords(force = false) {
  const signature = JSON.stringify([freshSource(), data.records, $("week-filter").value, $("search").value]);
  if (!force && signature === recordSignature) { updateSelection(); return; }
  recordSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const record of filtered()) {
    const row = document.createElement("tr");
    const check = document.createElement("input");
    check.type = "checkbox"; check.checked = selected.has(record.id);
    check.setAttribute("aria-label", `选择 ${record.startTime || record.title}`);
    check.addEventListener("change", () => {
      check.checked ? selected.add(record.id) : selected.delete(record.id);
      updateSelection(); void savePrefs();
    });
    const checkCell = makeCell(); checkCell.append(check); row.append(checkCell);
    const infoCell = makeCell();
    const cell = document.createElement("div"); cell.className = "record-cell";
    const thumbnail = core.httpUrl(record.thumbnail);
    if (thumbnail) {
      const img = document.createElement("img");
      img.src = thumbnail; img.alt = ""; img.loading = "lazy";
      img.addEventListener("error", () => { img.hidden = true; }, { once: true });
      cell.append(img);
    }
    const info = document.createElement("div"); info.className = "record-info";
    const link = document.createElement("a");
    link.href = `http://class.cumt.edu.cn/TeachingCenterStudentWeb/index.html#/fullpage/videoDetail.htm?id=${encodeURIComponent(record.id)}`;
    link.target = "_blank"; link.rel = "noopener";
    link.textContent = `${(record.startTime || "").slice(0, 16)}–${(record.endTime || "").slice(11, 16)}`;
    const title = document.createElement("small");
    title.textContent = record.className || record.courseName;
    info.append(link, title); cell.append(info); infoCell.append(cell); row.append(infoCell);
    row.append(makeCell(record.week ? `第${record.week}周` : "—"));
    for (const view of ["courseware", "teacher"]) {
      const files = (record.files || []).filter((f) => f.view === view);
      const td = makeCell(files.length ? `${files.length} 段` : record.status === "ready" ? "无此视角" : "—", "file-count");
      if (files.length) {
        const size = document.createElement("small");
        size.textContent = core.formatBytes(files.reduce((sum, f) => sum + f.bytes, 0));
        td.append(size);
      } else td.classList.add("missing");
      row.append(td);
    }
    const status = makeCell(record.status === "ready" ? "已提取" : record.status === "error" ? "提取失败" : "待提取", record.status);
    if (record.error) { status.title = record.error; status.textContent = record.error; }
    row.append(status); fragment.append(row);
  }
  $("records").replaceChildren(fragment);
  $("empty").hidden = filtered().length > 0;
  $("empty").textContent = !freshSource() ? "等待当前课程同步" : data.records.length ? "没有匹配的录像" : "当前课程暂无录像";
  updateSelection();
}
function renderTasks() {
  const signature = JSON.stringify(data.tasks);
  const counts = {};
  for (const task of data.tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  $("retry-downloads").disabled = !counts.error;
  $("clear-waiting").disabled = !counts.queued;
  $("clear-finished").disabled = !counts.complete;
  if (signature === taskSignature) return;
  taskSignature = signature;
  $("queue-count").textContent = data.tasks.length;
  $("queue-summary").textContent = data.tasks.length
    ? `等待 ${counts.queued || 0} · 下载中 ${(counts.active || 0) + (counts.starting || 0)} · 完成 ${counts.complete || 0} · 失败 ${counts.error || 0}`
    : "暂无下载任务";
  const labels = { queued: "等待下载", starting: "正在连接", active: "下载中", complete: "已完成", error: "下载失败" };
  const fragment = document.createDocumentFragment();
  for (const task of [...data.tasks].reverse()) {
    const li = document.createElement("li"); li.className = "task";
    const info = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = `${task.courseName} · ${task.title}`;
    const small = document.createElement("small"); small.textContent = task.filename;
    info.append(title, small);
    const status = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = task.browserPaused ? "浏览器已暂停" : labels[task.status] || task.status;
    text.className = task.status === "error" ? "error" : task.status === "complete" ? "ready" : "";
    const bytes = document.createElement("small");
    bytes.textContent = `${core.formatBytes(task.received || 0)} / ${core.formatBytes(task.total || task.bytes || 0)}`;
    status.append(text, bytes);
    if (task.error) {
      const err = document.createElement("small"); err.className = "task-error";
      err.textContent = task.error; status.append(err);
    }
    const progress = document.createElement("progress");
    progress.max = task.total || task.bytes || 1;
    progress.value = task.status === "complete" ? progress.max : task.received || 0;
    progress.setAttribute("aria-label", `${task.title} 下载进度`);
    status.append(progress);
    const button = document.createElement("button"); button.className = "icon-button";
    button.title = task.status === "complete" ? "在文件夹中显示" : "查看浏览器下载记录";
    button.setAttribute("aria-label", button.title);
    const icon = document.createElement("i"); icon.dataset.lucide = task.status === "complete" ? "folder-open" : "external-link";
    button.append(icon);
    button.addEventListener("click", () => {
      if (task.status === "complete" && task.downloadId != null) chrome.downloads.show(task.downloadId);
      else chrome.tabs.create({ url: "edge://downloads" });
    });
    li.append(info, status, button); fragment.append(li);
  }
  $("tasks").replaceChildren(fragment);
  icons();
}
function renderUpdates() {
  const update = data.updates || {};
  const checking = checkingUpdate || update.checking;
  $("current-version").textContent = `v${update.currentVersion || chrome.runtime.getManifest().version}`;
  $("check-updates").disabled = Boolean(checking);
  $("check-updates").querySelector("span").textContent = checking ? "检查中" : "检查更新";
  $("update-banner").hidden = !update.available;
  $("update-title").textContent = update.available ? `发现新版本 v${update.latestVersion}` : "";
  $("download-update").disabled = downloadingUpdate || !update.downloadUrl;
  $("update-status").textContent = checking ? "正在检查更新"
    : update.error || (update.available ? "有新版本可用"
    : update.noRelease ? "暂无已发布版本"
    : update.checkedAt ? "已是最新版本" : "尚未检查更新");
  $("update-status").className = update.error ? "error" : "";
  $("update-status").title = update.checkedAt
    ? `最近成功检查：${new Date(update.checkedAt).toLocaleString("zh-CN")}` : "";
}
function render() {
  const scan = data.scan, running = scan?.status === "running";
  const fresh = freshSource();
  $("source-status").textContent = sourceState.status === "ready"
    ? `当前页面：${sourceState.courseName} · ${sourceState.count} 节录像`
    : sourceState.status === "loading" ? `当前页面：${sourceState.courseName} · 正在切换课程`
    : sourceState.error || "正在读取课程页面";
  $("source-status").className = sourceState.status === "error" ? "error" : "";
  $("course-name").textContent = sourceState.courseName || "未连接课程页面";
  if (embedded) $("scan-label").textContent = "重新识别";
  $("scan-status").textContent = fresh && scan
    ? `${data.course?.term || ""} · ${data.course?.scope === "recording" ? "当前一节" : "当前课程全部周次"} · ${running ? "正在提取" : scan.status === "stopped" ? "已停止" : "扫描完成"} ${scan.current}/${scan.total} · 失败 ${data.records.filter(r => r.status === "error").length}`
    : "等待当前课程同步";
  $("scan").disabled = running || sourceState.status !== "ready" || !$("source-tab").value;
  $("stop-scan").hidden = !running || !fresh;
  $("retry-scan").hidden = !fresh || running || !data.records.some((r) => r.status === "error");
  $("scan-progress").hidden = !running || !fresh;
  $("scan-progress").max = scan?.total || 1; $("scan-progress").value = scan?.current || 0;
  $("concurrency").value = String(data.concurrency || 2);
  const pauseIcon = $("pause-queue").querySelector("svg, i"), wantedIcon = data.paused ? "play" : "pause";
  if (pauseIcon?.getAttribute("data-lucide") !== wantedIcon) {
    const icon = document.createElement("i"); icon.dataset.lucide = wantedIcon;
    pauseIcon?.replaceWith(icon);
  }
  $("pause-queue").querySelector("span").textContent = data.paused ? "继续排队" : "暂停排队";
  const weeks = [...new Set(data.records.map((r) => r.week).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  if (JSON.stringify(weeks) !== $("week-filter").dataset.weeks) {
    const value = $("week-filter").value;
    $("week-filter").replaceChildren(new Option("全部周次", ""), ...weeks.map(w => new Option(`第${w}周`, w)));
    $("week-filter").value = weeks.includes(value) ? value : "";
    $("week-filter").dataset.weeks = JSON.stringify(weeks);
  }
  renderRecords(); renderTasks(); renderUpdates(); icons();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await tabs();
    const tabId = Number($("source-tab").value);
    try {
      sourceState = tabId ? (await request("sync-source", { tabId })).source
        : { status: "error", error: "未找到已登录的课堂页面" };
    } catch (error) { sourceState = { status: "error", error: error.message }; }
    data = (await request("get-state", { tabId })).state;
    if (data.course?.sourceKey !== lastSourceKey) {
      $("week-filter").value = "";
      $("search").value = "";
      lastSourceKey = data.course?.sourceKey;
    }
    const scanId = data.scan?.id;
    if (scanId !== lastScanId) {
      selected = prefs.scanId === scanId ? new Set(prefs.selected || []) : new Set(data.records.map(r => r.id));
      knownRecords = new Set(data.records.map(r => r.id));
      lastScanId = scanId;
    }
    for (const record of data.records) {
      if (!knownRecords.has(record.id)) { selected.add(record.id); knownRecords.add(record.id); }
    }
    const option = $("source-tab").selectedOptions[0];
    if (option && sourceState.courseName) {
      option.textContent = `${sourceState.scope === "recording" ? "播放页 · 仅当前一节" : "课程列表"} · ${sourceState.courseName}`;
    }
    render();
  } catch (error) {
    sourceState = { status: "error", error: error.message };
    render(); notice(error.message, true);
  }
  finally { refreshing = false; }
}
function command(id, action) {
  $(id).addEventListener("click", async () => {
    $(id).disabled = true;
    try { await action(); await refresh(); }
    catch (error) { notice(error.message, true); }
    finally { $(id).disabled = false; render(); }
  });
}
command("scan", async () => {
  if (!$("source-tab").value) throw new Error("请先打开已登录的课堂实录页面。");
  await request("scan", { tabId: Number($("source-tab").value) }); await savePrefs();
});
command("stop-scan", () => request("stop-scan", { tabId: Number($("source-tab").value) }));
command("retry-scan", () => request("retry-scan", { tabId: Number($("source-tab").value) }));
command("refresh-tabs", tabs);
command("download", async () => {
  const result = await request("queue", { ids: visibleSelectedIds(), views: views(),
    source: data.course, scanId: data.scan?.id });
  notice(`已加入 ${result.added} 个文件，跳过 ${result.skipped} 个已有任务。`);
});
command("retry-downloads", () => request("retry-downloads"));
command("clear-finished", () => request("clear-finished"));
command("clear-waiting", () => request("clear-waiting"));
command("pause-queue", () => request("pause-queue", { paused: !data.paused }));
$("select-all").addEventListener("click", (event) => {
  const checked = event.currentTarget.checked;
  for (const r of filtered()) checked ? selected.add(r.id) : selected.delete(r.id);
  renderRecords(true); void savePrefs();
});
for (const view of ["courseware", "teacher"]) $(`view-${view}`).addEventListener("change", () => { updateSelection(); void savePrefs(); });
$("source-tab").addEventListener("change", () => {
  sourceState = { status: "checking" };
  render(); void savePrefs(); void refresh();
});
$("week-filter").addEventListener("change", () => renderRecords(true));
$("search").addEventListener("input", () => renderRecords(true));
$("concurrency").addEventListener("change", async () => {
  try { await request("concurrency", { value: Number($("concurrency").value) }); await refresh(); }
  catch (error) { notice(error.message, true); }
});
$("download-settings").addEventListener("click", () => chrome.tabs.create({ url: "edge://settings/downloads" }));
$("browser-downloads").addEventListener("click", () => chrome.tabs.create({ url: "edge://downloads" }));
$("check-updates").addEventListener("click", async () => {
  checkingUpdate = true; renderUpdates();
  try { data.updates = (await request("check-updates", { manual: true })).updates; }
  catch (error) { notice(error.message, true); }
  finally { checkingUpdate = false; renderUpdates(); }
});
$("download-update").addEventListener("click", async () => {
  downloadingUpdate = true; renderUpdates();
  try {
    data.updates = (await request("download-update")).updates;
    notice("新版已交给 Edge 下载。完成后请解压并覆盖原插件文件夹，再到扩展管理页重新加载。");
  } catch (error) { notice(error.message, true); }
  finally { downloadingUpdate = false; renderUpdates(); }
});
$("release-notes").addEventListener("click", () => {
  if (data.updates?.releaseUrl) void chrome.tabs.create({ url: data.updates.releaseUrl });
});
function closePanel() {
  const origin = location.ancestorOrigins?.[0];
  if (!embedded || !/^https?:\/\/class\.cumt\.edu\.cn$/.test(origin || "")) return;
  window.parent.postMessage({
    type: "class-replay-panel-close",
    channel: new URL(location.href).searchParams.get("channel"),
  }, origin);
}
$("close-panel").addEventListener("click", closePanel);
command("open-manager", () => request("open-manager"));
document.addEventListener("keydown", (event) => {
  if (embedded && event.key === "Escape") { event.preventDefault(); closePanel(); }
});
$("export").addEventListener("click", async () => {
  try {
    const result = await request("export-links", { ids: visibleSelectedIds(), views: views(),
      source: data.course, scanId: data.scan?.id });
    const url = URL.createObjectURL(new Blob([result.urls.join("\r\n") + "\r\n"], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${core.safeName(result.courseName)}-视频链接.txt`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { notice(error.message, true); await refresh(); }
});
async function init() {
  if (embedded) {
    parentTabId = (await request("panel-context")).tabId;
    $("open-manager").hidden = false;
    $("close-panel").hidden = false;
  }
  prefs = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] || prefs;
  for (const view of ["courseware", "teacher"]) $(`view-${view}`).checked = prefs.views.includes(view);
  await refresh(); icons();
  void request("check-updates").then(result => {
    data.updates = result.updates; renderUpdates();
  }).catch(error => notice(error.message, true));
  setInterval(() => { if (!document.hidden) void refresh(); }, 1500);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { sourceState = { status: "checking" }; render(); void refresh(); }
  });
  window.addEventListener("focus", () => {
    void refresh();
  });
}
void init().catch((error) => notice(error.message, true));
