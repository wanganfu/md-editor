(function () {
  var KEY = "md-editor:settings-cache";
  try {
    var raw = localStorage.getItem(KEY);
    if (!raw) return;
    var settings = JSON.parse(raw);
    var root = document.documentElement;
    if (settings.theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    root.dataset.viewMode = settings.defaultViewMode || "split";
    root.dataset.sidebar = settings.defaultSidebarVisible ? "open" : "closed";
    root.lang = settings.language === "en" ? "en" : "zh-CN";
  } catch (_) {
    /* ignore corrupt cache */
  }
})();
