import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import type { WarmupConfig, WarmupExecutionLog, WarmupPhase } from "@shared/types";
import type { WarmupRepository } from "@main/db/repositories/WarmupRepository";

// Tabs opened in the workspace
const WORKSPACE_TABS: Array<{ name: string; url: string }> = [
  { name: "home", url: "https://www.facebook.com/" },
  { name: "notifications", url: "https://www.facebook.com/notifications" },
  { name: "reels", url: "https://www.facebook.com/reels/" },
  { name: "marketplace", url: "https://www.facebook.com/marketplace/" },
];

// Random integer in [min, max]
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WarmupEngineEvents = {
  onLog: (log: Omit<WarmupExecutionLog, "id" | "createdAt">) => void;
  onAborted: () => boolean;
};

export class WarmupEngine {
  private readonly runId = randomUUID();
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private startedAt = 0;

  constructor(
    private readonly accountId: string,
    private readonly config: WarmupConfig,
    private readonly repo: WarmupRepository,
    private readonly events: WarmupEngineEvents,
    private readonly launchContext: () => Promise<BrowserContext>,
    private readonly facebookBaseUrl = "https://www.facebook.com/"
  ) {}

  // ─── Public entry point ───────────────────────────────────────────────────

  async run(): Promise<void> {
    this.startedAt = Date.now();
    try {
      await this.initialize();
      if (this.events.onAborted()) return;
      await this.openWorkspace();
      if (this.events.onAborted()) return;
      await this.runMainLoop();
    } finally {
      await this.finish();
    }
  }

  // ─── Phase: INITIALIZE ───────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const t = Date.now();
    this.log("INITIALIZE", "browser_launch", "Launching persistent browser context");
    try {
      this.context = await this.launchContext();
      const page = this.context.pages()[0] ?? await this.context.newPage();
      await page.goto(this.facebookBaseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const url = page.url().toLowerCase();
      if (url.includes("login") || url.includes("checkpoint")) {
        this.log("INITIALIZE", "health_check_failed", `Unexpected page: ${url}`, false);
        throw new Error("Account requires login or checkpoint resolution.");
      }
      this.log("INITIALIZE", "health_check_ok", "Page healthy", true, Date.now() - t);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log("INITIALIZE", "launch_error", msg, false, Date.now() - t);
      throw error;
    }
  }

  // ─── Phase: OPEN_WORKSPACE ───────────────────────────────────────────────

  private async openWorkspace(): Promise<void> {
    if (!this.context) return;
    this.log("OPEN_WORKSPACE", "open_tabs", `Opening ${WORKSPACE_TABS.length} workspace tabs`);

    // Re-use the existing page as first tab
    const firstPage = this.context.pages()[0];
    this.pages = firstPage ? [firstPage] : [];

    for (let i = 0; i < WORKSPACE_TABS.length; i++) {
      const tab = WORKSPACE_TABS[i]!;
      if (i === 0 && this.pages.length > 0) {
        // Reuse first page
        const t = Date.now();
        await this.pages[0]!.goto(tab.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        this.log("OPEN_WORKSPACE", "tab_opened", tab.name, true, Date.now() - t);
      } else {
        const t = Date.now();
        const page = await this.context.newPage();
        await page.goto(tab.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        this.pages.push(page);
        this.log("OPEN_WORKSPACE", "tab_opened", tab.name, true, Date.now() - t);
      }
      // Dwell briefly between tab opens
      await sleep(rand(800, 2000));
    }

    // Open 2 group tabs if any assigned groups are available (URLs passed via config extension)
    const groupUrls: string[] = (this.config as WarmupConfig & { groupUrls?: string[] }).groupUrls ?? [];
    const chosen = groupUrls.slice(0, 2);
    for (const gUrl of chosen) {
      if (this.events.onAborted()) return;
      const t = Date.now();
      const page = await this.context.newPage();
      await page.goto(gUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      this.pages.push(page);
      this.log("OPEN_WORKSPACE", "group_tab_opened", gUrl, true, Date.now() - t);
      await sleep(rand(800, 2000));
    }
  }

  // ─── Phase: MAIN_LOOP ────────────────────────────────────────────────────

  private async runMainLoop(): Promise<void> {
    const durationMs = this.config.durationMinutes * 60 * 1000;
    const endAt = this.startedAt + durationMs;
    let iteration = 0;

    while (Date.now() < endAt) {
      if (this.events.onAborted()) break;
      if (this.pages.length === 0) break;

      iteration++;
      // Pick a random tab
      const idx = rand(0, this.pages.length - 1);
      const page = this.pages[idx]!;

      const t = Date.now();
      try {
        await this.performTabAction(page, idx);
        this.log("MAIN_LOOP", "tab_action", `iter=${iteration} tab=${idx}`, true, Date.now() - t);
      } catch {
        this.log("MAIN_LOOP", "tab_action_error", `iter=${iteration} tab=${idx}`, false, Date.now() - t);
      }

      // Dwell between actions: 8–25 seconds with jitter
      const dwellMs = rand(8_000, 25_000);
      const remaining = endAt - Date.now();
      await sleep(Math.min(dwellMs, Math.max(0, remaining)));
    }
  }

  private async performTabAction(page: Page, tabIdx: number): Promise<void> {
    // Switch to tab by bringing it to front
    await page.bringToFront();
    await sleep(rand(300, 800));

    // Scroll down by random amount
    const scrollPx = rand(200, 800);
    await page.evaluate((px) => window.scrollBy({ top: px, behavior: "smooth" }), scrollPx);
    await sleep(rand(1500, 4000));

    // Occasionally scroll back up
    if (Math.random() < 0.3) {
      await page.evaluate((px) => window.scrollBy({ top: -px, behavior: "smooth" }), rand(100, 400));
      await sleep(rand(1000, 2500));
    }

    // Reels: scroll through feed if on reels tab
    if (tabIdx === 2 && this.config.enableReels) {
      await page.keyboard.press("ArrowDown");
      await sleep(rand(2000, 5000));
    }

    // Light hover over first image/video element visible
    try {
      const mediaEl = await page.$("img[src*='fbcdn'], video");
      if (mediaEl) {
        await mediaEl.hover({ timeout: 3000 });
        await sleep(rand(500, 1500));
      }
    } catch { /* best-effort */ }
  }

  // ─── Phase: FINISH ───────────────────────────────────────────────────────

  private async finish(): Promise<void> {
    const t = Date.now();
    // Navigate first tab back to home and dwell
    if (this.context && this.pages.length > 0) {
      try {
        const home = this.pages[0]!;
        await home.bringToFront();
        await home.goto(this.facebookBaseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        this.log("FINISH", "navigate_home", "Returned to home page");
        await sleep(30_000); // Dwell 30s
      } catch { /* best-effort during finish */ }
    }

    // Flush duration to DB
    const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
    this.repo.addDuration(this.accountId, elapsedSeconds);

    // Close browser
    try {
      await this.context?.close();
    } catch { /* best-effort */ }
    this.context = null;
    this.pages = [];

    this.log("FINISH", "browser_closed", `Session complete. Elapsed: ${Math.round(elapsedSeconds)}s`, true, Date.now() - t);
  }

  // ─── Internal helper ─────────────────────────────────────────────────────

  private log(
    phase: WarmupPhase,
    action: string,
    detail?: string,
    ok = true,
    durationMs?: number
  ): void {
    this.events.onLog({
      accountId: this.accountId,
      runId: this.runId,
      phase,
      action,
      detail,
      durationMs,
      ok,
    });
  }
}
