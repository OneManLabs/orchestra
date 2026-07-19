/**
 * Bounds high-frequency state publications without delaying terminal updates.
 * Each key gets at most one trailing publication per interval, and that
 * publication always reads the newest state supplied for the key.
 */
export class LatestUpdateCoalescer {
  private readonly pending = new Map<string, { publish: () => void; timer: NodeJS.Timeout }>();

  constructor(private readonly intervalMs: number) {}

  schedule(key: string, publish: () => void): void {
    const current = this.pending.get(key);
    if (current) {
      current.publish = publish;
      return;
    }
    const update = { publish, timer: undefined as unknown as NodeJS.Timeout };
    update.timer = setTimeout(() => {
      this.pending.delete(key);
      update.publish();
    }, this.intervalMs);
    update.timer.unref();
    this.pending.set(key, update);
  }

  publishNow(key: string, publish: () => void): void {
    const current = this.pending.get(key);
    if (current) {
      clearTimeout(current.timer);
      this.pending.delete(key);
    }
    publish();
  }

  clear(): void {
    for (const update of this.pending.values()) clearTimeout(update.timer);
    this.pending.clear();
  }
}
