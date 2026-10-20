const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

// Inspect the standard MP4 handler boxes using small HTTP ranges, without downloading the lesson.
async function range(url, start, end) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 206, "The server must support byte ranges");
  return Buffer.from(await response.arrayBuffer());
}
async function tracks(url) {
  let offset = 0;
  for (let i = 0; i < 15; i++) {
    const header = await range(url, offset, offset + 15);
    const type = header.toString("ascii", 4, 8);
    const shortSize = header.readUInt32BE();
    const size = shortSize === 1 ? Number(header.readBigUInt64BE(8)) : shortSize;
    if (!size || !Number.isSafeInteger(size)) throw new Error("Unsupported MP4 box size");
    if (type === "moov") {
      assert.ok(size < 10 * 1024 * 1024, "Metadata must remain bounded");
      const moov = await range(url, offset, offset + size - 1);
      const handlers = [];
      function visit(buffer, start, end) {
        for (let pos = start; pos + 8 <= end;) {
          const length = buffer.readUInt32BE(pos);
          if (length < 8 || pos + length > end) break;
          const name = buffer.toString("ascii", pos + 4, pos + 8);
          if (name === "hdlr" && length >= 24) handlers.push(buffer.toString("ascii", pos + 16, pos + 20));
          if (["moov", "trak", "mdia"].includes(name)) visit(buffer, pos + 8, pos + length);
          pos += length;
        }
      }
      visit(moov, 0, moov.length);
      return { handlers, metadataBytes: size };
    }
    offset += size;
  }
  throw new Error("MP4 metadata not found");
}
(async () => {
  const state = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../edge-class-replay-downloader-qa/scan-results.json"), "utf8"));
  for (const file of state.records[0].files) {
    const result = await tracks(file.url);
    assert.ok(result.handlers.includes("vide"));
    console.log(JSON.stringify({ view: file.view, ...result }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
