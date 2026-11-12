// In-memory sliding-window limit per IP. Best effort: each Function instance
// keeps its own counts, and they reset when the instance is recycled.

const HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_IPS = 5000;

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs = HOUR_MS,
    private now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_TRACKED_IPS) this.prune(t);
    return true;
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) {
      if (v.every((h) => t - h >= this.windowMs)) this.hits.delete(k);
    }
    if (this.hits.size > MAX_TRACKED_IPS) this.hits.clear();
  }
}
