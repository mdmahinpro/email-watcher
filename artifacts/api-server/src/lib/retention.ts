import { and, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  inboxMessagesTable,
  matchedMessagesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { getSettings } from "./settings";

/**
 * Storage retention.
 *
 * Nothing else in this app deletes mail, so an archive-everything mailbox grows
 * without bound. With full bodies stored, a message costs ~13 KB on average, so a
 * 500 MB free-tier database (Supabase free) holds roughly 38,000 messages — a
 * year at 100/day, but only a couple of months at 500/day. Left alone the
 * database eventually fills and inserts start failing.
 *
 * Two independent knobs, because the two costs are very different:
 *
 * - **Body retention** drops `body_text`/`body_html` from old rows while keeping
 *   the row, its snippet, and its metadata. A row without a body is ~1 KB, so
 *   this recovers ~92% of the space while leaving the history searchable and
 *   attributable. This is the one to reach for first.
 * - **Row retention** deletes old rows outright. Only needed when even the ~1 KB
 *   metadata rows become too many.
 *
 * Both are opt-in: 0 means "keep forever", which stays the default so an upgrade
 * never silently destroys data.
 */

export interface RetentionOutcome {
  bodiesCleared: number;
  rowsDeleted: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * Apply the configured retention policy.
 *
 * Body clearing runs before row deletion so that when both are configured, the
 * work is not wasted on rows about to be removed anyway (row retention is always
 * the longer window in practice, but the ordering makes the cheap operation
 * unconditional).
 */
export async function applyRetention(
  now: Date = new Date(),
): Promise<RetentionOutcome> {
  const settings = await getSettings();
  const outcome: RetentionOutcome = { bodiesCleared: 0, rowsDeleted: 0 };

  const bodyDays = settings.retainBodiesDays ?? 0;
  const rowDays = settings.retainMessagesDays ?? 0;

  if (bodyDays > 0) {
    const before = cutoff(now, bodyDays);

    // Only touch rows that still have a body, so a repeat run is a no-op rather
    // than rewriting every historical row every time.
    const hasBody = or(
      isNotNull(inboxMessagesTable.bodyText),
      isNotNull(inboxMessagesTable.bodyHtml),
    );
    const clearedInbox = await db
      .update(inboxMessagesTable)
      .set({ bodyText: null, bodyHtml: null })
      .where(and(lt(inboxMessagesTable.receivedAt, before), hasBody))
      .returning({ id: inboxMessagesTable.id });

    const hasMatchedBody = or(
      isNotNull(matchedMessagesTable.bodyText),
      isNotNull(matchedMessagesTable.bodyHtml),
    );
    const clearedMatched = await db
      .update(matchedMessagesTable)
      .set({ bodyText: null, bodyHtml: null })
      .where(and(lt(matchedMessagesTable.receivedAt, before), hasMatchedBody))
      .returning({ id: matchedMessagesTable.id });

    outcome.bodiesCleared = clearedInbox.length + clearedMatched.length;
  }

  if (rowDays > 0) {
    const before = cutoff(now, rowDays);

    const deletedInbox = await db
      .delete(inboxMessagesTable)
      .where(lt(inboxMessagesTable.receivedAt, before))
      .returning({ id: inboxMessagesTable.id });

    const deletedMatched = await db
      .delete(matchedMessagesTable)
      .where(lt(matchedMessagesTable.receivedAt, before))
      .returning({ id: matchedMessagesTable.id });

    outcome.rowsDeleted = deletedInbox.length + deletedMatched.length;
  }

  if (outcome.bodiesCleared > 0 || outcome.rowsDeleted > 0) {
    logger.info(
      { ...outcome, bodyDays, rowDays },
      "Retention applied",
    );
  }

  return outcome;
}

/** Run retention, logging rather than throwing, for use from the scheduler. */
export async function applyRetentionSafely(
  now: Date = new Date(),
): Promise<void> {
  try {
    await applyRetention(now);
  } catch (err) {
    logger.error({ err }, "Retention failed");
  }
}

/**
 * Current database size, so the UI can warn before a free-tier ceiling is hit.
 *
 * `pg_database_size` is cheap (a catalog lookup, not a scan).
 */
export async function databaseSizeBytes(): Promise<number | null> {
  try {
    const result = await db.execute(
      sql`select pg_database_size(current_database())::bigint as bytes`,
    );
    const raw = (result.rows[0] as { bytes?: string | number } | undefined)
      ?.bytes;
    // bigint arrives as a string from node-postgres to avoid precision loss.
    const bytes = typeof raw === "string" ? Number(raw) : raw;
    return typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null;
  } catch (err) {
    // A pooled connection may lack permission for this on some hosts; the size
    // display is informational, so degrade rather than fail the request.
    logger.warn({ err }, "Could not read database size");
    return null;
  }
}
