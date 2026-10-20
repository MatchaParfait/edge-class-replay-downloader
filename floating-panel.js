(() => {
  const KEY = "__classReplayFloatingPanel";
  const VERSION = chrome.runtime.getManifest().version;
  if (globalThis[KEY]?.version === VERSION) return;
  globalThis[KEY]?.dispose();
  document.getElementById("class-replay-downloader-root")?.remove();

  const host = document.createElement("div");
  host.id = "class-replay-downloader-root";
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { color-scheme: light; font-family: "Microsoft YaHei", system-ui, sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    #launcher {
      position: fixed; right: 14px; top: 42%; width: 44px; height: 44px;
      display: flex; align-items: center; justify-content: center; padding: 0;
      color: #fff; background: #14786c; border: 1px solid #0e665c;
      border-radius: 6px; box-shadow: 0 3px 12px #183a302b; cursor: pointer;
      pointer-events: auto;
    }
    #launcher:hover { background: #10665c; }
    #launcher:focus-visible { outline: 3px solid #40b29e; outline-offset: 3px; }
    #launcher svg { width: 22px; height: 22px; }
    #drawer {
      position: fixed; top: 12px; right: 12px; bottom: 12px;
      width: min(740px, calc(100vw - 24px)); overflow: hidden;
      border: 1px solid #cbd4d3; border-radius: 8px; background: #f5f7f7;
      box-shadow: -8px 4px 32px #183a3026; pointer-events: auto;
      animation: replay-slide-in 180ms ease-out;
    }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #f5f7f7; }
    @keyframes replay-slide-in {
      from { transform: translateX(36px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @media (max-width: 600px) {
      #launcher { right: 8px; width: 40px; height: 40px; }
      #drawer { inset: 8px; width: auto; }
    }
    @media (prefers-reduced-motion: reduce) { #drawer { animation: none; } }
  `;
  const launcher = document.createElement("button");
  launcher.id = "launcher";
  launcher.type = "button";
  launcher.title = "CUMT课堂回放批量下载";
  launcher.setAttribute("aria-label", "展开CUMT课堂回放批量下载");
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "drawer");
  launcher.append(lucide.createElement(lucide.icons.Download, { "aria-hidden": "true" }));
  const drawer = document.createElement("section");
  drawer.id = "drawer";
  drawer.hidden = true;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "CUMT课堂回放批量下载");
  shadow.append(style, launcher, drawer);
  document.documentElement.append(host);
  let iframe;
  let channel;

  function supported() {
    return /(?:teacherVideoResource|videoDetail)\.htm(?:\?|$)/i.test(location.hash.slice(1));
  }
  function close() {
    drawer.hidden = true;
    // Removing the frame suspends its polling, without touching persisted background jobs.
    iframe?.remove();
    iframe = null;
    channel = null;
    launcher.hidden = !supported();
    launcher.setAttribute("aria-expanded", "false");
  }
  function open() {
    if (!supported()) return false;
    if (!iframe) {
      channel = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0")).join("");
      iframe = document.createElement("iframe");
      iframe.title = "CUMT课堂回放批量下载";
      iframe.src = chrome.runtime.getURL(`popup.html?embedded=1&channel=${channel}`);
      iframe.referrerPolicy = "no-referrer";
      drawer.append(iframe);
    }
    drawer.hidden = false;
    launcher.hidden = true;
    launcher.setAttribute("aria-expanded", "true");
    iframe.focus();
    return true;
  }
  function toggle() {
    if (drawer.hidden) return open();
    close();
    launcher.focus({ preventScroll: true });
    return true;
  }
  function routeChanged() {
    if (!supported()) close();
    launcher.hidden = !supported() || !drawer.hidden;
  }
  function onMessage(event) {
    if (event.origin !== `chrome-extension://${chrome.runtime.id}` ||
      event.source !== iframe?.contentWindow || event.data?.channel !== channel) return;
    if (event.data.type === "class-replay-panel-close") {
      close(); launcher.focus({ preventScroll: true });
    }
  }
  function onKey(event) {
    if (event.key === "Escape" && !drawer.hidden) {
      event.preventDefault(); close(); launcher.focus({ preventScroll: true });
    }
  }
  function onRuntimeMessage(message, sender, respond) {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === "class-replay-panel-ready") {
      respond({ version: VERSION }); return;
    }
    if (message.type !== "toggle-class-replay-panel") return;
    respond({ ok: toggle(), error: supported() ? undefined : "请先进入课堂实录或视频播放页。" });
  }
  launcher.addEventListener("click", toggle);
  window.addEventListener("hashchange", routeChanged);
  window.addEventListener("message", onMessage);
  document.addEventListener("keydown", onKey);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  routeChanged();
  globalThis[KEY] = {
    version: VERSION,
    dispose() {
      close(); host.remove();
      window.removeEventListener("hashchange", routeChanged);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("keydown", onKey);
      try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
    },
  };
})();
