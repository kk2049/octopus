// The edge serves this independently of Bot and its bundles. Probe only the
// fixed, credential-free login-readiness alias; never replay the original URL
// or any capability-bearing API while waiting. Navigation stays in this tab.
const status = document.getElementById("status");
const hint = document.getElementById("hint");
const retry = document.getElementById("retry");
const started = Date.now();
const english = !navigator.language.toLowerCase().startsWith("zh");
if (english) {
  document.documentElement.lang = "en";
  document.title = "Octopus · Connecting";
  status.textContent = "Service is starting";
  hint.textContent = "Please wait. This page will return automatically when the connection is restored.";
  retry.textContent = "Reconnect";
}
let timer;
let pending = false;
let stopped = false;
let controller;
let returnAvailable = false;
const stages = {
  restarting: ["后端正在更新，连接即将恢复", "The backend is updating; reconnecting soon"],
  health_gate: ["正在启动并检查新版本", "Starting and checking the new version"],
  rolling_back: ["新版本启动失败，正在恢复上一版本", "Startup failed; restoring the previous version"],
  rolled_back: ["已恢复上一版本，本次升级未完成", "Previous version restored; upgrade did not complete"],
  failed: ["部署失败", "Deployment failed"], succeeded: ["升级成功，正在返回", "Upgrade succeeded; returning"],
  confirm_wait: ["新版本已启动，正在等待使用确认", "New version started; awaiting confirmation"],
};
const beforeSwitch = ["requested", "claimed", "building"];
// The edge reports the latest deployment whether or not it caused this outage.
// A finished one explains only an outage that follows it closely (on the
// observer's own clock); an older record means an ordinary restart, which must
// not read as "upgrade succeeded" or "upgrade did not complete".
const finished = ["succeeded", "failed", "rolled_back"];
const finishedRecentMs = 120_000;
async function check() {
  if (pending || stopped) return;
  clearTimeout(timer);
  pending = true;
  retry.disabled = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  let deployment = null;
  try {
    try {
      const edge = await fetch("/__octopus/deploy", {
        cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
      });
      if (edge.ok) deployment = await edge.json();
    } catch { /* Older installations still have the fixed readiness probe. */ }
    if (stopped) return;
    const fresh = deployment && Math.abs(Date.now() - deployment.observed_at) < 8000;
    const current = fresh && (!finished.includes(deployment.status)
      || deployment.observed_at - Date.parse(deployment.updated_at) < finishedRecentMs);
    if (current && stages[deployment.status]) {
      status.textContent = stages[deployment.status][english ? 1 : 0];
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(deployment.created_at)) / 1000));
      hint.textContent = `D${deployment.id} · ${Number.isFinite(seconds) ? seconds : 0}s`;
      try { sessionStorage.setItem("octopus-deploy-observed", String(deployment.id)); } catch { /* optional */ }
    } else {
      status.textContent = english ? "Connecting to the service" : "正在连接服务";
      hint.textContent = english ? "The page will open when the connection is restored." : "连接恢复后会自动打开页面。";
    }
    const response = await fetch("/__octopus/ready", {
      cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
    });
    if (!stopped && response.status === 204) {
      if (current && ["rolled_back", "failed"].includes(deployment.status)) {
        returnAvailable = true;
        retry.textContent = english ? "Return to page" : "返回页面";
        hint.textContent = english ? "The upgrade did not complete. Return to Tickets for the reason." : "本次升级未完成。返回工单页可查看原因和实际版本。";
        stopped = true;
        return;
      }
      // HTTP listening is not deployment acceptance. Keep waiting until the
      // independent supervisor has completed this exact deployment.
      // Build preparation does not take the serving version offline. If a
      // navigation briefly failed during build, return as soon as it is ready.
      if (deployment && (!fresh || (current && !["idle", "succeeded", ...beforeSwitch].includes(deployment.status)))) return;
      stopped = true;
      // Keeps path, query, fragment and the browser's existing session.
      location.reload();
      return;
    }
  } catch {
    // An offline backend is expected during drain, startup and rollback.
  } finally {
    clearTimeout(timeout);
    pending = false;
    retry.disabled = false;
    if (!stopped) timer = setTimeout(check, 2000 + Math.random() * 500);
  }
  if (stopped) return;
  const slow = Date.now() - started >= 60_000;
  if (slow && !deployment) {
    status.textContent = english ? "Still waiting for the service" : "服务仍未就绪";
    hint.textContent = english
      ? "This is taking longer than usual. We will keep checking; you can also reconnect."
      : "等待时间有些长。我们会继续检查，你也可以点击重新连接。";
  }
}
retry.addEventListener("click", () => { if (returnAvailable) location.reload(); else check(); });
addEventListener("pagehide", () => {
  stopped = true;
  clearTimeout(timer);
  controller?.abort();
});
addEventListener("pageshow", (event) => {
  if (event.persisted) {
    stopped = false;
    check();
  }
});
check();
