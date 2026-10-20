// Runs in MAIN so the site's existing authenticated client signs its own requests.
async function classReplayPage(action, recordingId) {
  if (!/^https?:$/.test(location.protocol) || location.hostname !== "class.cumt.edu.cn") {
    throw new Error("请先打开并登录课堂实录页面。");
  }
  const visible = (selector) => [...document.querySelectorAll(selector)]
    .find((element) => element.getClientRects().length);
  const listElement = visible(".teacher-video-resource");
  const list = listElement?.__vue__;
  const player = visible(".course-video-detail")?.__vue__;
  const vm = list || player;
  if (!vm) throw new Error("未找到课程数据，请进入课堂实录并选择课程，等待列表加载。");
  const summary = (item) => ({
    id: item.id, courseId: item.courseId, courseName: item.courseName,
    className: item.className, week: String(item.week || ""),
    startTime: item.startTime, endTime: item.endTime, title: item.videoInfoName,
    thumbnail: item.thumbnailPath && item.outerIp ? item.outerIp + item.thumbnailPath : "",
  });
  if (action === "snapshot" || action === "context") {
    const records = list ? list.videoInfoData : [player.videoDetailObj];
    const chosen = list ? list.weekList : player.videoDetailObj;
    if (!chosen?.courseId) throw new Error("请在课堂实录页面选择课程，等待列表加载。");
    const scope = list ? "course" : "recording";
    const term = list?.currentTermInfoId || `${chosen.schoolYear || ""}-${chosen.term || ""}`;
    const classIds = String(chosen.classIds || chosen.classId || "").split(",").filter(Boolean).sort();
    const activeName = listElement?.querySelector(".course-name.active")?.textContent.trim();
    const busy = Boolean(list?.loading) || !Array.isArray(records) ||
      Boolean(activeName && activeName !== chosen.courseName) ||
      (records || []).some((r) => r?.courseId !== chosen.courseId ||
        (classIds.length && !classIds.includes(r.classId)));
    const unique = [...new Map((Array.isArray(records) ? records : [])
      .filter((r) => r?.id).map((r) => [r.id, summary(r)])).values()];
    const context = {
      courseName: chosen.courseName || "课堂回放", courseId: chosen.courseId,
      term, scope, status: busy ? "loading" : "ready", count: busy ? 0 : unique.length,
      sourceKey: JSON.stringify([scope, chosen.courseId, classIds, term, list ? "" : chosen.id]),
      revision: busy ? "" : JSON.stringify(unique.map((r) => r.id).sort()),
    };
    if (action === "context") return context;
    if (busy) throw new Error("课程正在切换或录像列表尚未同步，请稍后再扫描。");
    return { ...context,
      records: unique.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime))) };
  }
  if (action !== "detail" || !/^[a-z0-9-]+$/i.test(recordingId || "")) throw new Error("无效的录像请求。");
  if (typeof vm.$Utils?.commonAjax !== "function" || typeof vm.$md5 !== "function") {
    throw new Error("平台接口已变化，无法使用当前登录会话读取录像。");
  }
  const api = new URL(vm.$staticConfig().teachingApi, location.href);
  if (api.origin !== location.origin) throw new Error("平台接口地址不在当前站点。");
  let timer;
  try {
    const detail = await Promise.race([
      vm.$Utils.commonAjax({
        url: `${api.href.replace(/\/$/, "")}/v1/videoinfo/${recordingId}`, type: "get",
        data: { validCode: vm.$md5(`id=${recordingId}&signKey=123123`) },
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("录像详情请求超时，请重试。")), 20000);
      }),
    ]);
    if (!detail || detail.id !== recordingId) throw new Error("详情接口未返回预期录像，请检查登录状态。");
    const fields = ["id", "videoStorePath", "outerIp", "innerIp", "thumbnailPath",
      "videoFileSize", "fileLength", "recordDeviceName", "startTime", "endTime", "serialNum"];
    const pickFiles = (files) => (Array.isArray(files) ? files : []).map((file) =>
      Object.fromEntries(fields.map((key) => [key, file[key]])));
    return { ...summary(detail),
      teacherViewFiles: pickFiles(detail.teacherViewFiles), vgaViewFiles: pickFiles(detail.vgaViewFiles) };
  } catch (error) {
    const status = error?.response?.status;
    throw new Error(status ? `平台接口返回 ${status}，请检查登录及访问权限。` : error.message || "读取录像失败");
  } finally { clearTimeout(timer); }
}
