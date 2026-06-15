/** 屏蔽 WebView 内置快捷键，避免暴露浏览器底层行为 */
function shouldBlockBrowserShortcut(event: KeyboardEvent): boolean {
  const key = event.key;
  const ctrl = event.ctrlKey || event.metaKey;

  if (key === "F5" || key === "F12") return true;
  if (ctrl && (key === "r" || key === "R")) return true;
  if (ctrl && key === "F5") return true;
  if (ctrl && (key === "u" || key === "U")) return true;
  if (ctrl && event.shiftKey && ["I", "i", "J", "j", "C", "c"].includes(key)) {
    return true;
  }

  return false;
}

export function initBlockBrowserShortcuts(): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if (!shouldBlockBrowserShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
}
