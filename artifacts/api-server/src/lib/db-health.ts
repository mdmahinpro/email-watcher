import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Bounded database connectivity probe.
 *
 * A health endpoint must answer faster than its caller's timeout. Render aborts a
 * health check at 5 seconds, while the connection pool waits 15 for a socket, so
 * an unbounded probe never returns at all — the request is cut, the check counts
 * as failed, and the deploy is rolled back even though the process is fine.
 */

const PROBE_TIMEOUT_MS = 2_000;

export type DatabaseState = "ok" | "unreachable";

export interface DatabaseProbe {
  state: DatabaseState;
  /** Round-trip time in ms when reachable. */
  latencyMs?: number;
  /** Failure reason when unreachable, for the log and the response body. */
  error?: string;
}

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

export async function probeDatabase(
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<DatabaseProbe> {
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
