import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Bounded database connectivity probe.
 *
 * A health endpoint must answer faster than its caller's timeout. Render aborts a
 * health check at 5 seconds, while the connection pool waits longer for a socket,
 * so an unbounded probe never returns at all — the request is cut, the check
 * counts as failed, and the deploy is rolled back even though the process is fine.
 */

/**
 * Probe budget. A cold connection to a cross-region managed Postgres costs
 * roughly 2s (TCP + TLS + SCRAM is ~8 round trips), so anything tighter reports a
 * perfectly reachable database as down. Kept under Render's 5s health-check abort.
 */
const PROBE_TIMEOUT_MS = Number(
  process.env["DB_PROBE_TIMEOUT_MS"] ?? 4_000,
);

/**
 * How long a probe result is reused.
 *
 * This is not merely an optimisation. `Promise.race` abandons the losing promise
 * but cannot cancel it: the underlying connection attempt keeps running until the
 * pool's own timeout. A health check every 10 seconds therefore accumulated
 * abandoned attempts until they saturated the pool, and real queries then failed
 * waiting for a free client. Caching plus in-flight sharing means at most one
 * probe connection exists at a time.
 */
const PROBE_CACHE_MS = 30_000;

export type DatabaseState = "ok" | "unreachable";

export interface DatabaseProbe {
  state: DatabaseState;
  /** Round-trip time in ms when reachable. */
  latencyMs?: number;
  /** Failure reason when unreachable, for the log and the response body. */
  error?: string;
  /** Age of the reused result in ms, absent when freshly measured. */
  cachedForMs?: number;
}

let cached: { at: number; result: DatabaseProbe } | null = null;
let inFlight: Promise<DatabaseProbe> | null = null;

/** Reject after `ms`, so a hung socket cannot hold the probe open. */
function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Database probe timed out after ${ms}ms`)),
      ms,
    );
    // Do not keep the event loop alive for this timer.
    t.unref?.();
  });
}

async function runProbe(timeoutMs: number): Promise<DatabaseProbe> {
  const started = Date.now();
  try {
    await Promise.race([db.execute(sql`select 1`), timeout(timeoutMs)]);
    return { state: "ok", latencyMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Debug level: on a free host with a paused database this fires on every
    // probe, and an error-level line per ping buries everything else.
    logger.debug({ err }, "Database probe failed");
    return { state: "unreachable", error: message };
  }
}

export async function probeDatabase(
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<DatabaseProbe> {
  const now = Date.now();

  if (cached && now - cached.at < PROBE_CACHE_MS) {
    return { ...cached.result, cachedForMs: now - cached.at };
  }

  // Coalesce concurrent callers onto one attempt rather than opening several.
  inFlight ??= runProbe(timeoutMs).then((result) => {
    cached = { at: Date.now(), result };
    inFlight = null;
    return result;
  });

  return inFlight;
}

/** Drop the cached result, so the next call measures afresh. */
export function resetProbeCache(): void {
  cached = null;
  inFlight = null;
}
