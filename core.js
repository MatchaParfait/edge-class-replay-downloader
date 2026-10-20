(function (root) {
  const VIEWS = {
    courseware: { field: "vgaViewFiles", label: "课件" },
    teacher: { field: "teacherViewFiles", label: "教师" },
  };
  function httpUrl(value, base) {
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  function safeName(value, fallback = "未命名") {
    let name = String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 80).replace(/[. ]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name || fallback;
  }
  function normalizeDetail(detail) {
    if (!detail?.id) throw new Error("录像详情缺少 ID");
    const files = [], seen = new Set();
    for (const [view, config] of Object.entries(VIEWS)) {
      const source = Array.isArray(detail[config.field]) ? [...detail[config.field]] : [];
      source.sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || ""))
        || Number(a.serialNum || 0) - Number(b.serialNum || 0) || String(a.id).localeCompare(String(b.id)));
      source.forEach((file, index) => {
        const base = httpUrl(file.outerIp || detail.outerIp || file.innerIp || detail.innerIp);
        const path = file.videoStorePath;
        const url = typeof path === "string" && path
          ? httpUrl(/^https?:\/\//i.test(path) ? path : (base ? base + path : "")) : "";
        if (!url || !/\.mp4$/i.test(new URL(url).pathname)) {
          throw new Error(`${config.label}录像文件地址无效，已停止提取该节课以避免漏段。`);
        }
        if (seen.has(`${view}:${url}`)) return;
        seen.add(`${view}:${url}`);
        files.push({
          key: `${detail.id}:${view}:${file.id || index}`,
          recordingId: detail.id, fileId: String(file.id || index), view,
          url, part: index + 1, bytes: Math.max(0, Number(file.videoFileSize) || 0),
          duration: Math.max(0, Number(file.fileLength) || 0), startTime: file.startTime || detail.startTime,
        });
      });
    }
    return { ...detail, teacherViewFiles: undefined, vgaViewFiles: undefined, files };
  }
  function filename(record, file) {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(record.startTime || "")?.[0] || "日期未知";
    const time = (record.startTime || "").slice(11, 16).replace(":", "");
    const end = (record.endTime || "").slice(11, 16).replace(":", "");
    const week = record.week ? `第${safeName(record.week)}周` : "周次未知";
    const name = `${date}_${time || "未知"}-${end || "未知"}_${VIEWS[file.view].label}_第${String(file.part).padStart(2, "0")}段_${safeName(file.fileId)}`;
    return `课堂回放/${safeName(record.courseName)}/${week}/${safeName(name, "录像")}.mp4`;
  }
  function selectedFiles(records, ids, views) {
    const selected = new Set(ids), wanted = new Set(views.filter((view) => VIEWS[view]));
    return records.filter((r) => selected.has(r.id)).flatMap((record) =>
      (record.files || []).filter((file) => wanted.has(file.view))
        .map((file) => ({ ...file, filename: filename(record, file), courseName: record.courseName,
          title: `${(record.startTime || "").slice(0, 16)} ${VIEWS[file.view].label} 第${file.part}段` })));
  }
  function formatBytes(value) {
    if (!value) return "0 B";
    const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / (1024 ** unit)).toFixed(unit > 0 ? 1 : 0)} ${["B", "KB", "MB", "GB"][unit]}`;
  }
  function sameSource(first, second) {
    return Boolean(first?.sourceKey && second?.sourceKey &&
      first.sourceKey === second.sourceKey && first.revision === second.revision &&
      first.tabId === second.tabId);
  }
  const api = { VIEWS, httpUrl, safeName, normalizeDetail, filename, selectedFiles, formatBytes, sameSource };
  root.ReplayCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
