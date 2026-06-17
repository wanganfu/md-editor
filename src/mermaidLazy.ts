import mermaid from "mermaid";

type MermaidLazyOptions = {
  getIsDark: () => boolean;
};

export class MermaidLazyRenderer {
  private observer: IntersectionObserver | null = null;
  private observed = new Set<HTMLElement>();
  private pendingNodes = new Set<HTMLElement>();
  private idleScheduled = false;
  private runChain: Promise<void> = Promise.resolve();
  private themeKey: string | null = null;
  private readonly getIsDark: () => boolean;

  constructor(options: MermaidLazyOptions) {
    this.getIsDark = options.getIsDark;
  }

  private updateTheme(): void {
    const isDark = this.getIsDark();
    const themeKey = isDark ? "dark" : "light";
    if (this.themeKey === themeKey) return;

    this.themeKey = themeKey;
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? "dark" : "default",
      securityLevel: "loose",
    });
  }

  private ensureObserver(): IntersectionObserver {
    if (this.observer) return this.observer;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const node = entry.target as HTMLElement;
          this.observer?.unobserve(node);
          this.observed.delete(node);
          this.enqueueNode(node);
        }
      },
      { rootMargin: "200px 0px", threshold: 0.01 }
    );

    return this.observer;
  }

  private enqueueNode(node: HTMLElement): void {
    if (
      node.hasAttribute("data-processed") &&
      node.getAttribute("data-mermaid-theme") === this.themeKey
    ) {
      return;
    }
    this.pendingNodes.add(node);
    this.scheduleIdleRun();
  }

  private scheduleIdleRun(): void {
    if (this.idleScheduled) return;
    this.idleScheduled = true;

    const run = () => {
      this.idleScheduled = false;
      void this.flushPending();
    };

    if ("requestIdleCallback" in window) {
      requestIdleCallback(run, { timeout: 600 });
    } else {
      setTimeout(run, 120);
    }
  }

  private async flushPending(): Promise<void> {
    if (this.pendingNodes.size === 0) return;

    this.updateTheme();
    const themeKey = this.themeKey ?? "light";
    const nodes = [...this.pendingNodes];
    this.pendingNodes.clear();

    nodes.forEach((node) => {
      node.removeAttribute("data-processed");
      node.removeAttribute("data-mermaid-theme");
    });

    this.runChain = this.runChain
      .then(async () => {
        try {
          await mermaid.run({ nodes, suppressErrors: true });
          nodes.forEach((node) => {
            node.setAttribute("data-mermaid-theme", themeKey);
          });
        } catch (error) {
          console.error("Mermaid 渲染失败:", error);
        }
      })
      .catch((error) => {
        console.error("Mermaid 预览队列失败:", error);
      });

    await this.runChain;
  }

  observe(container: HTMLElement, force = false): void {
    const observer = this.ensureObserver();
    const nodes = container.querySelectorAll<HTMLElement>(".mermaid");

    nodes.forEach((node) => {
      if (
        !force &&
        node.hasAttribute("data-processed") &&
        node.getAttribute("data-mermaid-theme") === this.themeKey
      ) {
        return;
      }

      if (force) {
        node.removeAttribute("data-processed");
        node.removeAttribute("data-mermaid-theme");
      }

      if (this.observed.has(node)) return;
      this.observed.add(node);
      observer.observe(node);
    });

    this.scheduleIdleRun();
  }

  /** Force render all mermaid nodes (e.g. theme change). */
  runAll(container: HTMLElement): void {
    this.disconnect();
    const nodes = container.querySelectorAll<HTMLElement>(".mermaid");
    nodes.forEach((node) => {
      node.removeAttribute("data-processed");
      node.removeAttribute("data-mermaid-theme");
      this.pendingNodes.add(node);
    });
    this.scheduleIdleRun();
  }

  disconnect(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.observed.clear();
    this.pendingNodes.clear();
  }

  destroy(): void {
    this.disconnect();
    this.runChain = Promise.resolve();
  }
}
