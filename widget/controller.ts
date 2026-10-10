/** Owns activity for one mounted panel. Invalidations retire all earlier results. */
export class PanelController {
  private active = false;
  private visible = false;
  private epoch = 0;
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private read: (signal: AbortSignal) => Promise<unknown>, private apply: (value: unknown) => void) {}
  start(visible: boolean) { this.active = true; this.setVisible(visible); }
  setVisible(visible: boolean) {
    if (!this.active) return;
    this.visible = visible;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    if (!visible) { this.invalidate(); return; }
    this.timer = setInterval(() => { void this.refresh(); }, 60000);
    void this.refresh();
  }
  invalidate() { this.epoch++; this.abort?.abort(); }
  async refresh() {
    if (!this.active || !this.visible || this.pending) return;
    const epoch = this.epoch, abort = new AbortController(); this.abort = abort;
    const pending = (async () => {
      try { const value = await this.read(abort.signal); if (this.active && this.visible && epoch === this.epoch) this.apply(value); }
      catch { if (this.active && this.visible && epoch === this.epoch) this.apply({ transportError: true }); }
    })();
    this.pending = pending;
    try { await pending; } finally {
      if (this.pending === pending) {
        this.pending = null; this.abort = null;
        if (this.active && this.visible && epoch !== this.epoch) void this.refresh();
      }
    }
  }
  stop() {
    this.active = false; this.visible = false; this.invalidate();
    if (this.timer) clearInterval(this.timer); this.timer = null;
  }
}
