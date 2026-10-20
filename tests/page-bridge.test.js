const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function fixture() {
  const list = {
    loading: false, currentTermInfoId: "2026-2027-1",
    weekList: { courseId: "course-a", courseName: "Writing", classIds: "class-a" },
    videoInfoData: [{ id: "a-1", courseId: "course-a", courseName: "Writing", classId: "class-a" }],
  };
  let activeName = "Writing";
  const element = { __vue__: list, getClientRects: () => [1],
    querySelector: () => ({ textContent: activeName }) };
  const context = vm.createContext({
    location: { protocol: "http:", hostname: "class.cumt.edu.cn", href: "http://class.cumt.edu.cn/" },
    document: { querySelectorAll: (selector) => selector === ".teacher-video-resource" ? [element] : [] },
    URL, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../page-bridge.js"), "utf8"), context);
  return { list, page: (action) => context.classReplayPage(action), choose(name) { activeName = name; } };
}
test("page snapshot reads the currently selected course each time", async () => {
  const h = fixture();
  const first = await h.page("snapshot");
  assert.equal(first.courseName, "Writing");
  h.choose("Database");
  h.list.weekList = { courseId: "course-b", courseName: "Database", classIds: "class-b" };
  assert.equal((await h.page("context")).status, "loading", "Old list must not masquerade as the selected course");
  await assert.rejects(() => h.page("snapshot"), /课程正在切换/);
  h.list.videoInfoData = [{ id: "b-1", courseId: "course-b", courseName: "Database", classId: "class-b" }];
  const second = await h.page("snapshot");
  assert.equal(second.courseName, "Database");
  assert.equal(second.records[0].id, "b-1");
  assert.notEqual(second.sourceKey, first.sourceKey);
});
test("the same course detects updated recordings and handles an empty course", async () => {
  const h = fixture();
  const first = await h.page("context");
  h.list.videoInfoData.push({ id: "a-2", courseId: "course-a", classId: "class-a" });
  const next = await h.page("context");
  assert.equal(next.sourceKey, first.sourceKey);
  assert.notEqual(next.revision, first.revision);
  h.list.videoInfoData = [];
  const empty = await h.page("snapshot");
  assert.equal(empty.records.length, 0); assert.equal(empty.status, "ready");
});
test("the selected course label and loading state take precedence over stale model data", async () => {
  const h = fixture();
  h.choose("Database");
  assert.equal((await h.page("context")).status, "loading");
  h.choose("Writing"); h.list.loading = true;
  await assert.rejects(() => h.page("snapshot"));
});
