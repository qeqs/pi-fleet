import { describe, it, expect } from "vitest";
import { RestartPolicy, RESTART_DELAYS_MS, RESTART_WINDOW_MS } from "../src/restart.ts";

describe("RestartPolicy", () => {
  it("waits longer after each crash", () => {
    const policy = new RestartPolicy();
    expect(RESTART_DELAYS_MS.map((_, i) => policy.next(i))).toEqual(RESTART_DELAYS_MS);
  });

  it("gives up on a crash loop", () => {
    const policy = new RestartPolicy();
    for (let i = 0; i < RESTART_DELAYS_MS.length; i++) policy.next(i);
    expect(policy.next(RESTART_DELAYS_MS.length)).toBeNull();
  });

  it("forgives crashes that are long past", () => {
    const policy = new RestartPolicy();
    for (let i = 0; i < RESTART_DELAYS_MS.length; i++) policy.next(i);
    expect(policy.next(RESTART_WINDOW_MS + 100)).toBe(RESTART_DELAYS_MS[0]);
  });
});
