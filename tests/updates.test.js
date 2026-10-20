const test = require("node:test");
const assert = require("node:assert/strict");
const Updates = require("../updates.js");

const repository = "https://github.com/MatchaParfait/edge-class-replay-downloader/releases";
const hour = 60 * 60 * 1000;
function release(version = "2.2.4", changes = {}) {
  const filename = Updates.packageName(version);
  return { tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [{ name: filename, state: "uploaded", size: 100,
      browser_download_url: `${repository}/download/v${version}/${filename}` }], ...changes };
}
function harness(stored = {}, installed = "2.2.3") {
  const calls = [], downloads = [], alarms = new Map(), items = [];
  let time = 1000000, version = installed, reply = { status: 200, body: release() }, gate;
  const chrome = {
    runtime: { getManifest: () => ({ version }) },
    storage: { local: {
      async get(key) { return structuredClone({ [key]: stored[key] }); },
      async set(value) { Object.assign(stored, structuredClone(value)); },
    } },
    alarms: {
      async get(name) { return alarms.get(name); },
      async create(name, value) { alarms.set(name, value); },
    },
    downloads: {
      async search() { return structuredClone(items); },
      async download(options) {
        downloads.push(options);
        return downloads.length;
      },
    },
  };
  const updater = Updates.create(chrome, { now: () => time, fetch: async (url, options) => {
    calls.push({ url, options });
    if (gate) await gate;
    if (reply instanceof Error) throw reply;
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300,
      headers: new Headers(reply.headers), async json() { return structuredClone(reply.body); } };
  } });
  return { updater, stored, calls, downloads, alarms, items,
    advance: duration => { time += duration; },
    respond: value => { reply = value; },
    install: value => { version = value; },
    block: value => { gate = value; } };
}

test("compares numeric extension versions without string ordering or downgrades", () => {
  assert.equal(Updates.newer("2.10.0", "2.9.9"), true);
  assert.equal(Updates.newer("2.2.3.1", "2.2.3"), true);
  for (const candidate of ["2.2.3", "2.2.3.0", "2.2.2", "bad", "2.2", "2.2.3-beta", "65536.0.0"]) {
    assert.equal(Updates.newer(candidate, "2.2.3"), false, candidate);
  }
});
test("accepts only the named ZIP asset from this repository and derives release links", () => {
  const info = Updates.releaseInfo(release("2.2.4", { html_url: "https://evil.example" }));
  assert.equal(info.version, "2.2.4");
  assert.equal(info.releaseUrl, `${repository}/tag/v2.2.4`);
  assert.equal(info.downloadUrl, `${repository}/download/v2.2.4/${Updates.packageName("2.2.4")}`);
  for (const url of [
    "https://evil.example/update.zip",
    `https://github.com/another/repo/releases/download/v2.2.4/${info.filename}`,
    info.downloadUrl + "?redirect=evil",
  ]) {
    const data = release();
    data.assets[0].browser_download_url = url;
    assert.equal(Updates.releaseInfo(data).downloadUrl, "");
  }
});
test("ignores preview releases and rejects malformed tags or unready packages", () => {
  assert.equal(Updates.releaseInfo(release("2.2.4", { prerelease: true })), null);
  assert.equal(Updates.releaseInfo(release("2.2.4", { draft: true })), null);
  assert.throws(() => Updates.releaseInfo({ tag_name: "v2.2.4/evil" }), /格式无效/);
  const data = release();
  data.assets[0].state = "new";
  assert.equal(Updates.releaseInfo(data).downloadUrl, "");
  assert.equal(Updates.releaseInfo(release("2.2.4", { assets: null })).downloadUrl, "");
});
test("checks the public API without credentials or course data and never downloads automatically", async () => {
  const h = harness({ classReplayV2: { tasks: [{ courseName: "Private", url: "http://private/video" }] } });
  const result = await h.updater.start();
  assert.equal(result.available, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, Updates.endpoint);
  assert.equal(h.calls[0].options.credentials, "omit");
  assert.equal(h.calls[0].options.referrerPolicy, "no-referrer");
  assert.equal(h.calls[0].options.redirect, "error");
  assert.deepEqual(Object.keys(h.calls[0].options.headers), ["Accept"]);
  assert.equal(h.calls[0].options.body, undefined);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.stored.classReplayV2.tasks[0].courseName, "Private");
  assert.equal(h.alarms.get(h.updater.alarm).periodInMinutes, 360);
});
test("caches across worker restarts and checks again after six hours", async () => {
  const h = harness();
  await h.updater.check();
  await h.updater.check();
  assert.equal(h.calls.length, 1);
  const restored = harness(structuredClone(h.stored));
  assert.equal((await restored.updater.check()).cached, true);
  assert.equal(restored.calls.length, 0);
  h.advance(6 * hour);
  await h.updater.check();
  assert.equal(h.calls.length, 2);
});
test("manual checks bypass the normal interval but retain a one-minute cooldown", async () => {
  const h = harness();
  await h.updater.check();
  assert.equal((await h.updater.check(true)).cached, true);
  h.advance(60000);
  assert.equal((await h.updater.check(true)).cached, false);
  assert.equal(h.calls.length, 2);
});
test("concurrent checks share a single network request", async () => {
  const h = harness();
  let unblock;
  h.block(new Promise(resolve => { unblock = resolve; }));
  const checks = [h.updater.check(), h.updater.check(true), h.updater.check()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal((await h.updater.getState()).checking, true);
  unblock();
  const results = await Promise.all(checks);
  assert.ok(results.every(value => value.available && !value.checking));
});
test("current or newer installed versions do not trigger an update prompt", async () => {
  const h = harness({}, "2.2.4");
  assert.equal((await h.updater.check()).available, false);
  h.install("2.3.0");
  assert.equal((await h.updater.getState()).available, false);
  await assert.rejects(() => h.updater.download(), /没有可下载/);
  assert.equal(h.downloads.length, 0);
});
test("404 and empty stable releases are not reported as an up-to-date check", async () => {
  const h = harness();
  h.respond({ status: 404 });
  const result = await h.updater.check();
  assert.equal(result.noRelease, true);
  assert.equal(result.available, false);
  assert.equal(result.error, "");
  assert.ok(result.checkedAt);
});
test("network failures preserve the last known update and do not mark it installed", async () => {
  const h = harness();
  await h.updater.check();
  const checkedAt = h.stored.classReplayUpdates.checkedAt;
  h.advance(6 * hour);
  h.respond(new TypeError("Failed to fetch"));
  const result = await h.updater.check();
  assert.match(result.error, /无法连接/);
  assert.equal(result.available, true);
  assert.equal(result.currentVersion, "2.2.3");
  assert.equal(result.checkedAt, checkedAt);
  await h.updater.check();
  assert.equal(h.calls.length, 2);
  h.advance(hour);
  await h.updater.check();
  assert.equal(h.calls.length, 3);
});
test("rate limiting survives restart and cannot be bypassed with manual requests", async () => {
  const h = harness();
  h.respond({ status: 403, headers: { "retry-after": "7200" } });
  const result = await h.updater.check();
  assert.match(result.error, /限制检查频率/);
  h.advance(hour);
  assert.equal((await h.updater.check(true)).cached, true);
  assert.equal(h.calls.length, 1);
  const restored = harness(structuredClone(h.stored));
  restored.advance(hour);
  assert.equal((await restored.updater.check(true)).cached, true);
  assert.equal(restored.calls.length, 0);
  h.advance(hour);
  await h.updater.check(true);
  assert.equal(h.calls.length, 2);
});
test("HTTP errors and invalid JSON do not erase a previous valid release", async () => {
  const h = harness();
  await h.updater.check();
  for (const reply of [{ status: 503 }, { status: 200, body: { tag_name: "invalid" } }]) {
    h.advance(6 * hour);
    h.respond(reply);
    const result = await h.updater.check();
    assert.equal(result.available, true);
    assert.ok(result.error);
  }
});
test("download requires a newer version with a matching package and leaves video tasks untouched", async () => {
  const original = { tasks: [{ key: "video", status: "active" }], paused: false };
  const h = harness({ classReplayV2: structuredClone(original) });
  const result = await h.updater.download();
  assert.equal(result.downloadId, 1);
  assert.deepEqual(h.downloads[0], {
    url: `${repository}/download/v2.2.4/${Updates.packageName("2.2.4")}`,
    filename: `插件更新/${Updates.packageName("2.2.4")}`, conflictAction: "uniquify", saveAs: false,
  });
  assert.deepEqual(h.stored.classReplayV2, original);
  assert.equal((await h.updater.getState()).currentVersion, "2.2.3");
});
test("missing release packages retain the release page but block package downloads", async () => {
  const h = harness();
  h.respond({ status: 200, body: release("2.2.4", { assets: [] }) });
  const result = await h.updater.check();
  assert.equal(result.available, true);
  assert.equal(result.downloadUrl, "");
  assert.equal(result.releaseUrl, `${repository}/tag/v2.2.4`);
  await assert.rejects(() => h.updater.download(), /尚未提供安装包/);
  assert.equal(h.downloads.length, 0);
});
test("duplicate clicks adopt the in-progress package download", async () => {
  const h = harness();
  const info = await h.updater.check();
  h.items.push({ id: 42, state: "in_progress", url: info.downloadUrl });
  const results = await Promise.all([h.updater.download(), h.updater.download()]);
  assert.ok(results.every(value => value.downloadId === 42));
  assert.equal(h.downloads.length, 0);
});
test("persisted download links are revalidated against the fixed repository", async () => {
  const h = harness({ classReplayUpdates: {
    lastAttemptAt: 1000000, checkedAt: 1000000,
    release: { tag: "v2.2.4", version: "2.2.4", filename: Updates.packageName("2.2.4"),
      downloadUrl: "https://evil.example/update.zip" },
  } });
  assert.equal((await h.updater.getState()).downloadUrl, "");
  await assert.rejects(() => h.updater.download(), /尚未提供安装包/);
  assert.equal(h.downloads.length, 0);
});
