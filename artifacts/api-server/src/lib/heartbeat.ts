import { ne, sql } from "drizzle-orm";
import { db, heartbeatTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Daily database liveness beat.
 *
 * Free hosted Postgres pauses a project that sees no activity (Supabase free:
 * ~1 week). Ordinary scan traffic normally covers that, but only while the web
 * service is awake — a free host can stop or restart the service at any time, and
 * a scan that fails to connect to its mailbox performs no database write at all.
 * This gives the database one unconditional mutation per day that depends on
 * nothing external.
 *
 * The table holds exactly one row: today's date. Writing today's row and deleting
 * every other row in the same transaction means the beat is always a real
 * mutation (INSERT or DELETE, not a no-op) while the table never grows.
 */

/** `YYYY-MM-DD` in UTC, so the day does not shift with the host's timezone. */
export function utcDayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface HeartbeatResult {
  day: string;
  /** True when today's row did not exist yet, i.e. this is the day's first beat. */
  inserted: boolean;
  /** How many previous-day rows were removed. */
  removed: number;
}

/**
 * Write today's date and erase any other day's.
 *
 * Runs in a transaction so an observer never sees a moment with no row at all,
 * and so a crash between the two statements cannot leave yesterday's date behind
 * as the only row.
 */
export async function beat(now: Date = new Date()): Promise<HeartbeatResult> {
  const day = utcDayString(now);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(heartbeatTable)
      .values({ day, writtenAt: now, touchedAt: now })
      // Same-day repeat beats bump touchedAt, so the row visibly pulses rather
      // than looking stale until midnight.
      .onConflictDoUpdate({
        target: heartbeatTable.day,
        set: { touchedAt: now },
      })
      .returning({
        day: heartbeatTable.day,
        // xmax = 0 identifies a fresh INSERT rather than an UPDATE, which is how
        // "first beat of the day" is distinguished without a second query.
        isInsert: sql<boolean>`(xmax = 0)`,
      });

    // Yesterday's date vanishes as today's is written.
    const removed = await tx
      .delete(heartbeatTable)
      .where(ne(heartbeatTable.day, day))
      .returning({ day: heartbeatTable.day });

    return {
      day,
      inserted: inserted[0]?.isInsert ?? false,
      removed: removed.length,
    };
  });
}

/** The date currently recorded, or null before the first beat. */
export async function currentBeat(): Promise<string | null> {
  const rows = await db
    .select({ day: heartbeatTable.day })
    .from(heartbeatTable)
    .limit(1);
  return rows[0]?.day ?? null;
}

/**
 * Run a beat, logging rather than throwing.
 *
 * Called from the scheduler tick, which must not be aborted by a transient
 * database error — the next tick will retry a minute or two later.
 */
export async function beatSafely(now: Date = new Date()): Promise<void> {
  try {
    const result = await beat(now);
    if (result.inserted || result.removed > 0) {
      logger.info(
        { day: result.day, removedPreviousDays: result.removed },
        "Heartbeat: wrote today's date",
      );
    } else {
      logger.debug({ day: result.day }, "Heartbeat touched");
    }
  } catch (err) {
    logger.error({ err }, "Heartbeat failed");
  }
}
