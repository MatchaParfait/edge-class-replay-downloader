const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
function harness() {
  const elements = new Map(), requests = [], opened = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, textContent: "", className: "", title: "", style: {},
      listeners: {}, span: { textContent: "" },
      querySelector() { return this.span; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    });
    return elements.get(id);
  };
  let reply = { ok: true, updates: {} };
  const context = vm.createContext({
    document: { getElementById: element, documentElement: { classList: { toggle() {} } } },
    ReplayCore: {}, location: { href: "chrome-extension://test/popup.html" },
    URL, Date, console, setTimeout() { return 1; }, clearTimeout() {},
    chrome: {
      runtime: { getManifest: () => ({ version: "2.2.3" }),
        async sendMessage(message) { requests.push(message); return reply; } },
      tabs: { async create(options) { opened.push(options); } },
    },
  });
  vm.runInContext(source.slice(0, source.indexOf("\nfunction render()")), context);
  const start = source.indexOf('$("check-updates").addEventListener');
  const end = source.indexOf("\nfunction closePanel()", start);
  vm.runInContext(source.slice(start, end), context);
  return {
    element, requests, opened,
    respond(value) { reply = value; },
    set(info) {
      context.info = info;
      vm.runInContext("data.updates = info; renderUpdates();", context);
    },
    click(id) { return element(id).listeners.click(); },
  };
}
test("update UI distinguishes current, checking, offline and no-release states", () => {
  const h = harness();
  for (const [info, text] of [
    [{ checkedAt: 10 }, "已是最新版本"],
    [{ noRelease: true, checkedAt: 10 }, "暂无已发布版本"],
    [{ error: "无法连接 GitHub" }, "无法连接 GitHub"],
    [{ checking: true }, "正在检查更新"],
  ]) {
    h.set(info);
    assert.equal(h.element("current-version").textContent, "v2.2.3");
    assert.equal(h.element("update-status").textContent, text);
    assert.equal(h.element("update-banner").hidden, true);
    assert.equal(h.element("check-updates").disabled, Boolean(info.checking));
  }
});
test("new-version banner requires a package before enabling Download", () => {
  const h = harness();
  h.set({ available: true, latestVersion: "2.2.4", downloadUrl: "" });
  assert.equal(h.element("update-banner").hidden, false);
  assert.equal(h.element("update-title").textContent, "发现新版本 v2.2.4");
  assert.equal(h.element("download-update").disabled, true);
  h.set({ available: true, latestVersion: "2.2.4", downloadUrl: "https://github.com/package.zip" });
  assert.equal(h.element("download-update").disabled, false);
});
test("manual button requests a fresh check and renders its result", async () => {
  const h = harness();
  h.respond({ ok: true, updates: { checkedAt: 10 } });
  await h.click("check-updates");
  assert.equal(h.requests[0].type, "check-updates");
  assert.equal(h.requests[0].manual, true);
  assert.equal(h.element("update-status").textContent, "已是最新版本");
  assert.equal(h.element("check-updates").disabled, false);
});
test("download button reports manual installation steps without claiming installation", async () => {
  const h = harness();
  h.respond({ ok: true, updates: { available: true, latestVersion: "2.2.4", downloadUrl: "https://github.com/package.zip" } });
  await h.click("download-update");
  assert.equal(h.requests[0].type, "download-update");
  assert.match(h.element("notice").textContent, /解压并覆盖原插件文件夹/);
  assert.match(h.element("notice").textContent, /重新加载/);
  assert.equal(h.element("current-version").textContent, "v2.2.3");
  assert.equal(h.element("download-update").disabled, false);
});
test("failed commands restore button state and release notes open separately", async () => {
  const h = harness();
  h.set({ available: true, downloadUrl: "https://github.com/package.zip",
    releaseUrl: "https://github.com/release" });
  h.respond({ ok: false, error: "测试错误" });
  await h.click("download-update");
  assert.equal(h.element("notice").textContent, "测试错误");
  assert.equal(h.element("download-update").disabled, false);
  await h.click("release-notes");
  assert.equal(h.opened[0].url, "https://github.com/release");
});
