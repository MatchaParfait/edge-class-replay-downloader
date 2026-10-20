const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Updates = require("../updates.js");

const root = path.resolve(__dirname, "..");
const files = [
  "manifest.json", "background.js", "core.js", "page-bridge.js", "updates.js",
  "floating-panel.js", "popup.html", "popup.js", "popup.css",
  "vendor/lucide.min.js", "vendor/LICENSE", "README.md",
  "docs/images/course-panel.png", "docs/images/download-queue.png",
];
async function build(output = path.join(root, "dist")) {
  if (process.platform !== "win32") throw new Error("This release packager requires Windows PowerShell.");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  const filename = Updates.packageName(manifest.version);
  const runtime = await fs.readFile(path.join(root, "background.js"), "utf8");
  const html = await fs.readFile(path.join(root, "popup.html"), "utf8");
  const references = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(item => item.js),
    ...[...runtime.matchAll(/importScripts\(([^)]+)\)/g)]
      .flatMap(match => [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1])),
    ...[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(item => item[1]),
  ];
  for (const reference of references) {
    if (!files.includes(reference)) throw new Error(`Runtime dependency missing from allowlist: ${reference}`);
  }
  await fs.mkdir(output, { recursive: true });
  const stage = await fs.mkdtemp(path.join(output, ".package-"));
  const target = path.resolve(output, filename);
  try {
    for (const file of files) {
      const destination = path.join(stage, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(root, file), destination);
    }
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; " +
      "$files=Get-ChildItem -LiteralPath $env:REPLAY_PACKAGE_STAGE; " +
      "Compress-Archive -LiteralPath $files.FullName -DestinationPath $env:REPLAY_PACKAGE_TARGET -Force"], {
      encoding: "utf8", timeout: 60000,
      env: { ...process.env, REPLAY_PACKAGE_STAGE: stage, REPLAY_PACKAGE_TARGET: target },
    });
    if (result.status !== 0) throw new Error(result.stderr || "Release archive failed");
    return { path: target, version: manifest.version, files: [...files] };
  } finally {
    const resolved = await fs.realpath(stage);
    if (path.dirname(resolved) !== await fs.realpath(output) || !path.basename(resolved).startsWith(".package-")) {
      throw new Error("Unsafe staging cleanup path");
    }
    await fs.rm(resolved, { recursive: true });
  }
}
if (require.main === module) build().then(result => {
  console.log(`Built ${result.path} (${result.files.length} files)`);
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { build, files };
