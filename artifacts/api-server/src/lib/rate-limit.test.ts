import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows attempts up to the limit", () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });

    expect(limiter.hit("ip", 0).allowed).toBe(true);
    expect(limiter.hit("ip", 1).allowed).toBe(true);
    expect(limiter.hit("ip", 2).allowed).toBe(true);
  });

  it("blocks the attempt that exceeds the limit", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });

    limiter.hit("ip", 0);
    limiter.hit("ip", 0);
    const blocked = limiter.hit("ip", 0);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("reports the remaining budget", () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });

    expect(limiter.hit("ip", 0).remaining).toBe(2);
    expect(limiter.hit("ip", 0).remaining).toBe(1);
    expect(limiter.hit("ip", 0).remaining).toBe(0);
  });

  it("tracks each key independently", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });

    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("a", 0).allowed).toBe(false);
    // A second client must not inherit the first client's exhausted budget.
    expect(limiter.hit("b", 0).allowed).toBe(true);
  });

  it("starts a fresh window once the old one elapses", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });

    expect(limiter.hit("ip", 0).allowed).toBe(true);
    expect(limiter.hit("ip", 500).allowed).toBe(false);
    expect(limiter.hit("ip", 1000).allowed).toBe(true);
  });

  it("rounds retryAfter up to at least one second", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });

    limiter.hit("ip", 0);
    // 1ms left in the window: a Retry-After of 0 would invite an instant retry.
    const blocked = limiter.hit("ip", 999);
    expect(blocked.retryAfterSeconds).toBe(1);
  });

  it("clears a key on reset, so a successful login unblocks the client", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });

    limiter.hit("ip", 0);
    limiter.hit("ip", 0);
    expect(limiter.hit("ip", 0).allowed).toBe(false);

    limiter.reset("ip");
    expect(limiter.hit("ip", 0).allowed).toBe(true);
  });

  it("keeps blocking for the rest of the window after the limit is hit", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 10_000 });

    limiter.hit("ip", 0);
    for (const t of [1, 100, 5_000, 9_999]) {
      expect(limiter.hit("ip", t).allowed).toBe(false);
    }
    expect(limiter.hit("ip", 10_000).allowed).toBe(true);
  });

  it("does not grow without bound as keys expire", () => {
    const limiter = new RateLimiter({ max: 5, windowMs: 100 });

    // Many distinct keys across many windows; expired buckets must be evicted.
    for (let i = 0; i < 500; i++) {
      limiter.hit(`ip-${i}`, i * 200);
    }

    // Reaching into the private map is deliberate: the eviction behaviour is the
    // thing under test, and it has no public surface.
    const buckets = (limiter as unknown as { buckets: Map<string, unknown> })
      .buckets;
    expect(buckets.size).toBeLessThanOrEqual(2);
  });
});
