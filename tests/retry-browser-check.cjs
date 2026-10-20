const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { createHash } = require("node:crypto");
const output = path.resolve(__dirname, "../../edge-class-replay-downloader-qa");
const extension = path.resolve(__dirname, "..");
const edge = process.env.REPLAY_EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const digest = data => createHash("sha256").update(data).digest("hex");
const payload = Buffer.alloc(1024 * 1024, 42);
const modes = new Map();
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ path: req.url, range: req.headers.range || "", mode: modes.get(req.url) });
  const start = Number(req.headers.range?.match(/^bytes=(\d+)-/)?.[1] || 0);
  const headers = { "Content-Type": "text/plain", "Content-Length": payload.length - start,
    "Accept-Ranges": "bytes", ETag: '"retry-qa-v1"' };
  if (req.headers.range) headers["Content-Range"] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
  res.writeHead(req.headers.range ? 206 : 200, headers);
  if (modes.get(req.url) === "good") res.end(payload.subarray(start));
  else {
    res.write(payload.subarray(start, start + 32768));
    setTimeout(() => res.destroy(), 100);
  }
});
async function waitFor(read, predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
(async () => {
  let context;
  try {
    await fs.mkdir(output, { recursive: true });
    const profile = await fs.mkdtemp(path.join(output, "retry-edge-profile-"));
    const downloadDir = path.join(profile, "downloads");
    await fs.mkdir(path.join(profile, "Default"), { recursive: true });
    await fs.mkdir(downloadDir, { recursive: true });
    await fs.writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false },
    }));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, {
      executablePath: edge, headless: true, acceptDownloads: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers().find(worker => worker.url().endsWith("/background.js")) ||
      await context.waitForEvent("serviceworker", { timeout: 20000 });
    const id = new URL(worker.url()).host;
    const manager = await context.newPage();
    const session = await context.newCDPSession(manager);
    await session.send("Browser.setDownloadBehavior", { behavior: "default" });
    await manager.goto(`chrome-extension://${id}/popup.html`);
    const read = key => worker.evaluate(async key => {
      const data = await state();
      const task = structuredClone(data.tasks.find(task => task.key === key));
      const item = task?.downloadId == null ? null :
        (await chrome.downloads.search({ id: task.downloadId }))[0];
      return { task, item };
    }, key);
    const retry = async () => {
      const results = await manager.evaluate(async () =>
        Promise.all([chrome.runtime.sendMessage({ type: "retry-downloads" }),
          chrome.runtime.sendMessage({ type: "retry-downloads" })]));
      assert.ok(results.every(result => result.ok), JSON.stringify(results));
    };
    async function broken(key) {
      const route = `/${key}.txt`;
      modes.set(route, "broken");
      await worker.evaluate(async ({ key, url }) => {
        await mutate(data => {
          data.tasks.push({ key, url, filename: `retry-qa/${key}.txt`, bytes: 1048576,
            total: 1048576, received: 0, status: "queued", title: key, courseName: "Retry QA" });
        });
        void pump();
      }, { key, url: origin + route });
      const failed = await waitFor(() => read(key),
        result => result.task?.status === "error" && result.item?.canResume, `${key} did not interrupt resumably`);
      const files = await fs.readdir(downloadDir, { recursive: true });
      assert.ok(files.some(file => file.endsWith(".crdownload")), "A real partial file is required");
      console.log(`${key}: interrupted with real partial file, ID ${failed.item.id}`);
      return failed;
    }
    const resume = await broken("resume");
    modes.set("/resume.txt", "good");
    await retry();
    let resumed;
    try {
      resumed = await waitFor(() => read("resume"), result => result.task?.status === "complete", "Resume did not finish", 15000);
    } catch (error) {
      console.error("Requests", requests);
      throw error;
    }
    if (resumed.item.id !== resume.item.id) {
      assert.deepEqual(await manager.evaluate(async id => chrome.downloads.search({ id }), resume.item.id), []);
    }
    assert.equal(digest(await fs.readFile(resumed.item.filename)), digest(payload));
    console.log(`Browser resume or clean fallback passed, same ID: ${resumed.item.id === resume.item.id}`);

    const restart = await broken("restart");
    modes.set("/restart.txt", "good");
    // Exercise the fallback with a real partial file and real erase/download APIs.
    await worker.evaluate(id => {
      globalThis.qaResume = chrome.downloads.resume;
      chrome.downloads.resume = async downloadId => {
        if (downloadId === id) throw new Error("QA: browser refused resume");
        return globalThis.qaResume(downloadId);
      };
    }, restart.item.id);
    await retry();
    const restarted = await waitFor(() => read("restart"), result => result.task?.status === "complete", "Restart did not finish");
    await worker.evaluate(() => { chrome.downloads.resume = globalThis.qaResume; delete globalThis.qaResume; });
    assert.notEqual(restarted.item.id, restart.item.id);
    assert.deepEqual(await manager.evaluate(async id => chrome.downloads.search({ id }), restart.item.id), []);
    assert.equal(digest(await fs.readFile(restarted.item.filename)), digest(payload));
    const files = (await fs.readdir(downloadDir, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => entry.name).sort();
    assert.deepEqual(files, ["restart.txt", "resume.txt"]);
    console.log("Fallback removed the old partial before creating one completed file");

    const before = requests.length;
    await worker.evaluate(async () => {
      await mutate(data => { data.tasks.find(task => task.key === "restart").status = "error"; });
    });
    await retry();
    await waitFor(() => read("restart"), result => result.task?.status === "complete", "Completed item was not adopted");
    assert.equal(requests.length, before, "Completed files must not be requested again");
    assert.equal(digest(await fs.readFile(restarted.item.filename)), digest(payload));
    const result = { browser: await context.browser().version(), profile, downloadDir,
      resumedSameId: resumed.item.id === resume.item.id, oldRestartId: restart.item.id, newRestartId: restarted.item.id,
      files,
      completedFilePreserved: true, testFileBytes: payload.length, requests };
    await fs.writeFile(path.join(output, "retry-results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (context) await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
