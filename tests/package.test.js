const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { build, files } = require("../scripts/package-release.cjs");
const manifest = require("../manifest.json");

test("release ZIP contains every runtime dependency but no profiles, tests or secrets",
  { skip: process.platform !== "win32" }, async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "replay-package-test-"));
    try {
      const result = await build(output);
      assert.equal(result.version, manifest.version);
      const read = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
        "$zip=[IO.Compression.ZipFile]::OpenRead($env:REPLAY_TEST_ZIP); " +
        "try { $zip.Entries | ForEach-Object { $_.FullName.Replace('\\','/') } | ConvertTo-Json -Compress } " +
        "finally { $zip.Dispose() }"], {
        encoding: "utf8", timeout: 30000, env: { ...process.env, REPLAY_TEST_ZIP: result.path },
      });
      assert.equal(read.status, 0, read.stderr);
      assert.deepEqual(JSON.parse(read.stdout).filter(name => !name.endsWith("/")).sort(), [...files].sort());
      assert.ok((await fs.stat(result.path)).size > 0);
      assert.ok(files.includes("updates.js"));
      assert.ok(!files.some(name => /(?:test|profile|\.env|\.git\/)/i.test(name)));
    } finally {
      const resolved = await fs.realpath(output);
      assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith("replay-package-test-"));
      await fs.rm(resolved, { recursive: true });
    }
  });
