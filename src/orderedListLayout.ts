/** 按每个 ol 的最大序号位数设置 --md-ol-ch，缩进随位数变化 */
export function adjustOrderedListMarkers(root: HTMLElement): void {
  root.querySelectorAll("ol").forEach((ol) => {
    const start = parseInt(ol.getAttribute("start") || "1", 10);
    const itemCount = ol.querySelectorAll(":scope > li").length;
    if (itemCount === 0) return;

    const maxNum = start + itemCount - 1;
    const digits = Math.max(1, String(maxNum).length);
    ol.style.setProperty("--md-ol-ch", String(digits));
  });
}
