/**
 * Fixed-window rate limiter for login attempts.
 *
 * A single-password gate is only as strong as the number of guesses an attacker
 * gets, so unlimited POSTs to /auth/login would reduce the password to a
 * throughput problem. In-memory is the right scope here: there is one server
 * process, and losing the counters on restart is acceptable because a restart is
 * not something a remote attacker can trigger.
 */

export interface RateLimitConfig {
  /** Attempts allowed per window, per key. */
  max: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. Suitable for a Retry-After header. */
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: RateLimitConfig) {}

  /** Record an attempt for `key` and report whether it is allowed. */
  hit(key: string, now: number = Date.now()): RateLimitResult {
    this.evictExpired(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.config.windowMs });
      return {
        allowed: true,
        remaining: this.config.max - 1,
        retryAfterSeconds: 0,
      };
    }

    bucket.count++;
    const allowed = bucket.count <= this.config.max;
    return {
      allowed,
      remaining: Math.max(0, this.config.max - bucket.count),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  /** Clear a key's counter, e.g. after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Drop finished windows so the map cannot grow without bound. Called on every
   * hit; the map only ever holds keys seen within one window, so this stays
   * cheap even under a distributed attempt spread.
   */
  private evictExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
