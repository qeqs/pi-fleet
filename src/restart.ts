/**
 * When to bring a crashed agent back. A quick restart covers a one-off crash; a crash
 * loop (a bad model name, say) must end, or it would spin forever with nobody noticing.
 */

/** Wait before each restart inside the window; once these run out, the agent stays down. */
export const RESTART_DELAYS_MS = [2000, 10000, 30000];
export const RESTART_WINDOW_MS = 10 * 60 * 1000;

export class RestartPolicy {
  private crashes: number[] = [];

  /** Record a crash. Returns how long to wait before restarting, or null to give up. */
  next(now = Date.now()): number | null {
    this.crashes = this.crashes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.crashes.length >= RESTART_DELAYS_MS.length) return null;
    this.crashes.push(now);
    return RESTART_DELAYS_MS[this.crashes.length - 1];
  }
}
