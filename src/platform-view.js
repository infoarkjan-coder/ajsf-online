/* AJSF platform view switch.
   Website is the safe default. The Android wrapper must open the app URL with ?platform=app.
   This only changes presentation; permissions, data access and business rules remain in their modules.
*/
(() => {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("platform");
  const isAndroidWebView = /;\s*wv\)|\bAJSFAndroid\b/i.test(navigator.userAgent);
  const platform = requested === "app" || (!requested && isAndroidWebView) ? "app" : "web";
  document.body.classList.remove("platform-web", "platform-app");
  document.body.classList.add("platform-" + platform);
  const dashboard = document.getElementById("dashboardCard");
  if (dashboard) {
    const label = document.createElement("div");
    label.className = "platform-view-label";
    label.textContent = platform === "app" ? "AJSF MOBILE APP" : "AJSF WEBSITE PORTAL";
    dashboard.prepend(label);
  }
  document.documentElement.dataset.ajsfPlatform = platform;
})();
