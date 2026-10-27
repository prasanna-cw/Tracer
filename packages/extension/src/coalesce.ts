/**
 * Runs `task` once, `delayMs` after the last `trigger()` (a save-storm becomes one run, not one per file).
 * A `trigger()` that arrives while `task` is already running is not dropped: it schedules exactly one more
 * run right after the current one finishes, so a background refresh never answers with stale input.
 */
export class Coalesced {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private pendingWhileRunning = false;

  constructor(
    private readonly delayMs: number,
    private readonly task: () => PromiseLike<void>, // PromiseLike: also accepts vscode's Thenable (withProgress)
  ) {}

  trigger(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.delayMs);
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    if (this.running) {
      this.pendingWhileRunning = true;
      return;
    }
    this.running = true;
    try {
      await this.task();
    } finally {
      this.running = false;
      if (this.pendingWhileRunning) {
        this.pendingWhileRunning = false;
        this.trigger();
      }
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
