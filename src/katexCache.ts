import katex from "katex";

const KATEX_OPTIONS = {
  throwOnError: false,
  strict: "ignore" as const,
  trust: true,
};

const cache = new Map<string, string>();

export function renderKatexCached(
  formula: string,
  displayMode: boolean
): string {
  const key = `${displayMode ? "d" : "i"}:${formula}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const html = katex.renderToString(formula.trim(), {
    ...KATEX_OPTIONS,
    displayMode,
  });
  cache.set(key, html);
  return html;
}

export function clearKatexCache(): void {
  cache.clear();
}

export function getKatexCacheSize(): number {
  return cache.size;
}
