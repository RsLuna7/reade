type Job = { priority: () => number; execute: () => void; signal: AbortSignal };

/** Per-document queue: visible pages first; one expensive page job at a time. */
export class PdfRenderQueue {
  private pending: Job[] = [];
  private running = false;
  private scheduled = false;

  run(work: () => Promise<void>, priority: () => number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      const abort = () => {
        if (!started) {
          this.pending = this.pending.filter((entry) => entry !== job);
          reject(new DOMException("PDF render cancelled", "AbortError"));
        }
      };
      const job: Job = { priority, signal, execute: () => {
        started = true;
        signal.removeEventListener("abort", abort);
        let abortRunning!: () => void;
        const cancelled = new Promise<void>((_, fail) => {
          abortRunning = () => fail(new DOMException("PDF render cancelled", "AbortError"));
          signal.addEventListener("abort", abortRunning, { once: true });
        });
        Promise.race([Promise.resolve().then(work), cancelled]).then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", abortRunning);
          this.running = false;
          this.schedule();
        });
      } };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      this.pending.push(job);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.running || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.running) return;
      this.pending.sort((a, b) => a.priority() - b.priority());
      const job = this.pending.shift();
      if (!job) return;
      this.running = true;
      job.execute();
    });
  }
}

/** Keep both the replacement and visible canvas bounded even for huge PDF pages. */
export function pdfRasterPixelRatio(width: number, height: number, devicePixelRatio: number): number {
  return Math.min(Math.max(1, devicePixelRatio || 1), 2,
    Math.sqrt((8 * 1024 * 1024) / (width * height)), 8192 / Math.max(width, height));
}
