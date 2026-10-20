const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");
const file = (id, extra = {}) => ({
  id, outerIp: "http://121.248.108.54:9091/",
  videoStorePath: `/20260909/task/${id}/${id}-1.mp4`,
  startTime: "2026-09-09 19:55:00", videoFileSize: 1024, serialNum: 1, ...extra,
});
const detail = (extra = {}) => ({
  id: "recording1", courseName: "科技论文写作", week: "1",
  startTime: "2026-09-09 19:55:00", endTime: "2026-09-09 20:45:00",
  teacherViewFiles: [file("teacher-real-id")],
  vgaViewFiles: [file("courseware-unrelated-id")],
  studentViewFiles: [file("student")], ...extra,
});
test("uses actual per-view paths and never collects the student view", () => {
  const record = core.normalizeDetail(detail());
  assert.equal(record.files.length, 2);
  assert.deepEqual(record.files.map(f => f.view), ["courseware", "teacher"]);
  assert.ok(record.files[0].url.includes("/courseware-unrelated-id/"));
  assert.ok(!record.files.some(f => f.url.includes("/student/")));
  assert.ok(record.files[0].url.includes(":9091//20260909/"));
});
test("preserves and orders every segment, deduplicates repeated URLs", () => {
  const second = file("part2", { startTime: "2026-09-09 20:20:00", serialNum: 2 });
  const first = file("part1");
  const record = core.normalizeDetail(detail({ vgaViewFiles: [second, first, first] }));
  assert.deepEqual(record.files.filter(f => f.view === "courseware").map(f => f.fileId), ["part1", "part2"]);
});
test("missing courseware never silently falls back to teacher", () => {
  const record = core.normalizeDetail(detail({ vgaViewFiles: null }));
  assert.equal(core.selectedFiles([record], [record.id], ["courseware"]).length, 0);
  assert.equal(core.selectedFiles([record], [record.id], ["teacher"]).length, 1);
});
test("filters selected lessons and views independently", () => {
  const a = core.normalizeDetail(detail()), b = core.normalizeDetail(detail({ id: "recording2" }));
  assert.equal(core.selectedFiles([a, b], ["recording1"], ["courseware"]).length, 1);
  assert.equal(core.selectedFiles([a, b], ["recording1"], ["courseware", "teacher"]).length, 2);
  assert.equal(core.selectedFiles([a, b], ["recording1"], []).length, 0);
});
test("rejects malformed media addresses rather than guessing", () => {
  assert.throws(() => core.normalizeDetail(detail({ vgaViewFiles: [file("x", { videoStorePath: "javascript:evil" })] })));
  assert.equal(core.httpUrl("javascript:evil"), "");
  assert.equal(core.httpUrl("http://user:pass@example.com/a.mp4"), "");
});
test("supports absolute paths, safe Windows filenames and course/week hierarchy", () => {
  const record = core.normalizeDetail(detail({ courseName: "../CON:bad?/" }));
  const target = core.filename(record, record.files[0]);
  assert.ok(target.startsWith("课堂回放/"));
  assert.ok(target.includes("/第1周/2026-09-09_1955-2045_课件_第01段_"));
  assert.ok(!target.includes(".."));
  assert.ok(!/[<>:"\\|?*]/.test(target));
  assert.equal(core.safeName("CON"), "_CON");
  assert.equal(core.safeName("..."), "未命名");
  const absolute = core.normalizeDetail(detail({ vgaViewFiles: [file("a", { videoStorePath: "https://media.example/a.mp4?token=keep" })] }));
  assert.equal(absolute.files[0].url, "https://media.example/a.mp4?token=keep");
});
