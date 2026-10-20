((root) => {
  const REPOSITORY = "MatchaParfait/edge-class-replay-downloader";
  const RELEASES = `https://github.com/${REPOSITORY}/releases`;
  const ENDPOINT = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
  const KEY = "classReplayUpdates";
  const ALARM = "class-replay-update-check";
  const INTERVAL = 6 * 60 * 60 * 1000;
  const RETRY = 60 * 60 * 1000;
  const COOLDOWN = 60 * 1000;

  function versionParts(version) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) return null;
    const parts = version.split(".").map(Number);
    return parts.every(part => Number.isInteger(part) && part >= 0 && part <= 65535)
      ? parts.concat(Array(4 - parts.length).fill(0)) : null;
  }
  function newer(candidate, current) {
    const a = versionParts(candidate), b = versionParts(current);
    if (!a || !b) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  }
  function packageName(version) { return `cumt-class-replay-downloader-v${version}.zip`; }
  function releaseInfo(release) {
    if (release?.draft || release?.prerelease) return null;
    const tag = release?.tag_name;
    const version = typeof tag === "string" ? tag.replace(/^v/, "") : "";
    if (!versionParts(version)) throw new Error("GitHub 发布版本格式无效，请查看发布页。");
    const filename = packageName(version);
    const url = `${RELEASES}/download/${encodeURIComponent(tag)}/${filename}`;
    const asset = (Array.isArray(release.assets) ? release.assets : []).find(item =>
      item.name === filename && item.state === "uploaded" && item.size > 0 &&
      item.browser_download_url === url);
    return { tag, version, filename, releaseUrl: `${RELEASES}/tag/${encodeURIComponent(tag)}`,
      downloadUrl: asset ? url : "" };
  }
  function create(chrome, options = {}) {
    const fetcher = options.fetch || globalThis.fetch;
    const now = options.now || Date.now;
    let cached, loading, checking, downloading;

    async function load() {
      if (!cached) {
        loading ||= chrome.storage.local.get(KEY).then(stored => {
          cached = stored[KEY] || {};
          return cached;
        });
        await loading;
      }
      return cached;
    }
    async function save() { await chrome.storage.local.set({ [KEY]: cached }); }
    async function getState() {
      const saved = await load();
      const currentVersion = chrome.runtime.getManifest().version;
      const release = saved.release;
      // Rebuild URLs from the fixed repository, including when reading persisted state.
      let safe;
      if (release?.tag) {
        try {
          safe = releaseInfo({ tag_name: release.tag, assets: release.downloadUrl ? [{
            name: release.filename, state: "uploaded", size: 1, browser_download_url: release.downloadUrl,
          }] : [] });
        } catch {}
      }
      return {
        currentVersion, latestVersion: safe?.version || "",
        available: Boolean(safe && newer(safe.version, currentVersion)),
        releaseUrl: safe?.releaseUrl || `${RELEASES}/latest`,
        downloadUrl: safe?.downloadUrl || "", filename: safe?.filename || "",
        checkedAt: saved.checkedAt || 0, lastAttemptAt: saved.lastAttemptAt || 0,
        noRelease: Boolean(saved.noRelease), error: saved.error || "",
        checking: Boolean(checking),
      };
    }
    async function check(manual = false) {
      if (checking) return checking;
      checking = (async () => {
        const saved = await load();
        const time = now();
        const interval = manual ? COOLDOWN : saved.error ? RETRY : INTERVAL;
        if ((saved.lastAttemptAt && time - saved.lastAttemptAt < interval) ||
          (saved.retryAt && time < saved.retryAt)) {
          return { ...await getState(), cached: true, checking: false };
        }
        saved.lastAttemptAt = time;
        await save();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetcher(ENDPOINT, {
            headers: { Accept: "application/vnd.github+json" },
            credentials: "omit", referrerPolicy: "no-referrer",
            cache: "no-store", redirect: "error", signal: controller.signal,
          });
          if (response.status === 403 || response.status === 429) {
            const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
            const wait = Number(response.headers.get("retry-after")) * 1000;
            saved.retryAt = Math.min(time + 24 * RETRY, Math.max(time + RETRY,
              Number.isFinite(reset) ? reset : 0, Number.isFinite(wait) ? time + wait : 0));
            throw new Error("GitHub 暂时限制检查频率，请稍后重试。");
          }
          if (response.status === 404) {
            saved.release = null; saved.noRelease = true;
          } else {
            if (!response.ok) throw new Error(`GitHub 暂时不可用（${response.status}），请稍后重试。`);
            saved.release = releaseInfo(await response.json());
            saved.noRelease = !saved.release;
          }
          saved.error = ""; saved.retryAt = 0; saved.checkedAt = now();
        } catch (error) {
          saved.error = error.message?.startsWith("GitHub")
            ? error.message : "无法连接 GitHub，请稍后重试。";
        } finally { clearTimeout(timer); }
        await save();
        return { ...await getState(), cached: false, checking: false };
      })().finally(() => { checking = null; });
      return checking;
    }
    async function start() {
      if (!await chrome.alarms.get(ALARM)) {
        await chrome.alarms.create(ALARM, { periodInMinutes: INTERVAL / 60000 });
      }
      return check();
    }
    async function download() {
      if (downloading) return downloading;
      downloading = (async () => {
        const info = await check();
        if (!info.available) throw new Error("没有可下载的新版本，请先检查更新。");
        if (!info.downloadUrl) throw new Error("新版尚未提供安装包，请打开更新说明。");
        const matches = await chrome.downloads.search({ url: info.downloadUrl, state: "in_progress" });
        const active = matches.find(item => item.url === info.downloadUrl && item.state === "in_progress");
        const downloadId = active?.id ?? await chrome.downloads.download({
          url: info.downloadUrl, filename: `插件更新/${info.filename}`,
          conflictAction: "uniquify", saveAs: false,
        });
        return { ...info, downloadId };
      })().finally(() => { downloading = null; });
      return downloading;
    }
    return { getState, check, start, download, alarm: ALARM };
  }
  const api = { create, newer, releaseInfo, packageName, endpoint: ENDPOINT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReplayUpdates = api;
})(globalThis);
