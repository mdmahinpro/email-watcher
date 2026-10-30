import { asc, gt, sql } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  emailAccountsTable,
  matchedMessagesTable,
  inboxMessagesTable,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Whole-database backup and restore, as one JSON document.
 *
 * The database lives outside this service — a managed Postgres (Supabase) whose
 * connection string sits in DATABASE_URL — so nothing here is durable by
 * accident and a self-service copy is the only way to hold your own archive.
 * The backup is a single JSON file with every row of every table, message
 * bodies included; the restore puts back whatever is missing without ever
 * deleting or overwriting live data.
 */

/** Bumped when the payload shape changes in a way restore must understand. */
export const BACKUP_VERSION = 1;

/** Rows read per query while streaming; keeps memory flat regardless of size. */
const STREAM_BATCH_ROWS = 200;

/** Rows written per INSERT during a restore. */
const RESTORE_CHUNK_ROWS = 100;

/**
 * Tables in dependency order: settings and accounts first, then the messages
 * that reference an account id.
 */
interface TableSpec {
  name: string;
  /** Drizzle table object; typed loosely because four different tables pass through. */
  fetch: (
    afterId: number,
  ) => Promise<Array<Record<string, unknown> & { id: number }>>;
  insert: (rows: Array<Record<string, unknown>>) => Promise<number>;
  /** Timestamp columns, which travel as ISO strings and must come back as Dates. */
  dateFields: string[];
  hasSequence: boolean;
}

function rowsFrom<T>(
  query: Promise<T[]>,
): Promise<Array<Record<string, unknown> & { id: number }>> {
  return query as unknown as Promise<Array<Record<string, unknown> & { id: number }>>;
}

const TABLES: TableSpec[] = [
  {
    name: "app_settings",
    fetch: (afterId) =>
      rowsFrom(
        db
          .select()
          .from(appSettingsTable)
          .where(gt(appSettingsTable.id, afterId))
          .orderBy(asc(appSettingsTable.id))
          .limit(STREAM_BATCH_ROWS),
      ),
    insert: async (rows) =>
      (
        await db
          .insert(appSettingsTable)
          .values(rows as Array<typeof appSettingsTable.$inferInsert>)
          .onConflictDoNothing()
          .returning({ id: appSettingsTable.id })
      ).length,
    dateFields: ["updatedAt"],
    hasSequence: true,
  },
  {
    name: "email_accounts",
    fetch: (afterId) =>
      rowsFrom(
        db
          .select()
          .from(emailAccountsTable)
          .where(gt(emailAccountsTable.id, afterId))
          .orderBy(asc(emailAccountsTable.id))
          .limit(STREAM_BATCH_ROWS),
      ),
    insert: async (rows) =>
      (
        await db
          .insert(emailAccountsTable)
          .values(rows as Array<typeof emailAccountsTable.$inferInsert>)
          .onConflictDoNothing()
          .returning({ id: emailAccountsTable.id })
      ).length,
    dateFields: ["lastCheckedAt", "deletedAt", "createdAt"],
    hasSequence: true,
  },
  {
    name: "matched_messages",
    fetch: (afterId) =>
      rowsFrom(
        db
          .select()
          .from(matchedMessagesTable)
          .where(gt(matchedMessagesTable.id, afterId))
          .orderBy(asc(matchedMessagesTable.id))
          .limit(STREAM_BATCH_ROWS),
      ),
    insert: async (rows) =>
      (
        await db
          .insert(matchedMessagesTable)
          .values(rows as Array<typeof matchedMessagesTable.$inferInsert>)
          .onConflictDoNothing()
          .returning({ id: matchedMessagesTable.id })
      ).length,
    dateFields: ["receivedAt", "createdAt"],
    hasSequence: true,
  },
  {
    name: "inbox_messages",
    fetch: (afterId) =>
      rowsFrom(
        db
          .select()
          .from(inboxMessagesTable)
          .where(gt(inboxMessagesTable.id, afterId))
          .orderBy(asc(inboxMessagesTable.id))
          .limit(STREAM_BATCH_ROWS),
      ),
    insert: async (rows) =>
      (
        await db
          .insert(inboxMessagesTable)
          .values(rows as Array<typeof inboxMessagesTable.$inferInsert>)
          .onConflictDoNothing()
          .returning({ id: inboxMessagesTable.id })
      ).length,
    dateFields: ["receivedAt", "createdAt"],
    hasSequence: true,
  },
];

/**
 * The backup document, produced as a stream of string chunks.
 *
 * Deliberately not one big JSON.stringify: a full archive with bodies can be
 * far larger than the 512 MB a free instance has, and building it in memory
 * would OOM the process mid-download. Rows are read and written in batches, so
 * peak memory is one batch regardless of archive size.
 */
export async function* backupChunks(): AsyncGenerator<string> {
  const exportedAt = new Date().toISOString();
  const counts: Record<string, number> = {};

  yield `{"version":${BACKUP_VERSION},"exportedAt":${JSON.stringify(exportedAt)},"tables":{`;

  for (let t = 0; t < TABLES.length; t++) {
    const spec = TABLES[t]!;
    if (t > 0) yield ",";
    yield `${JSON.stringify(spec.name)}:[`;

    let lastId = 0;
    let count = 0;
    let first = true;
    for (;;) {
      const batch = await spec.fetch(lastId);
      if (batch.length === 0) break;
      for (const row of batch) {
        if (!first) yield ",";
        first = false;
        yield JSON.stringify(row);
        lastId = row.id;
        count++;
      }
      if (batch.length < STREAM_BATCH_ROWS) break;
    }

    counts[spec.name] = count;
    yield "]";
    logger.info({ table: spec.name, rows: count }, "Backup table streamed");
  }

  yield `},"counts":${JSON.stringify(counts)}}`;
}

export interface RestoreResult {
  restored: Record<string, number>;
  message: string;
}

/**
 * Put back whatever the backup holds that the database lacks.
 *
 * Merge-only by design: inserts use `ON CONFLICT DO NOTHING`, so a restore can
 * never delete a message, overwrite a newer edit, or duplicate anything. That
 * makes it safe to run more than once, and safe on a live database — a fresh
 * deployment recovers everything, and a running one only gains rows it lost.
 *
 * Ids are preserved so an account id in a restored message still points at its
 * restored account; each table's sequence is then advanced past the highest
 * restored id so new inserts do not collide with history.
 */
export async function restoreBackup(payload: unknown): Promise<RestoreResult> {
  const doc = payload as {
    version?: unknown;
    tables?: Record<string, unknown>;
  };

  if (!doc || typeof doc !== "object" || !doc.tables || typeof doc.tables !== "object") {
    throw new RestoreError(
      "This file is not an Email Watcher backup: it has no tables section.",
    );
  }
  if (doc.version !== BACKUP_VERSION) {
    throw new RestoreError(
      `Unsupported backup version ${String(doc.version)}; this build understands ${BACKUP_VERSION}.`,
    );
  }

  const restored: Record<string, number> = {};

  for (const spec of TABLES) {
    const raw = (doc.tables as Record<string, unknown>)[spec.name];
    if (raw === undefined) {
      restored[spec.name] = 0;
      continue;
    }
    if (!Array.isArray(raw)) {
      throw new RestoreError(`The backup's "${spec.name}" section is not a list.`);
    }

    const rows = raw.map((row) => normalizeRow(row, spec));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += RESTORE_CHUNK_ROWS) {
      const chunk = rows.slice(i, i + RESTORE_CHUNK_ROWS);
      inserted += await spec.insert(chunk);
    }
    restored[spec.name] = inserted;

    if (spec.hasSequence && rows.length > 0) {
      // Advance the id sequence past everything restored. With is_called=false
      // the next value is exactly max+1 (and 1 for an empty table), so a later
      // insert can never collide with a restored id.
      await db.execute(sql`
        SELECT setval(
          pg_get_serial_sequence(${spec.name}, 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM ${sql.identifier(spec.name)}), 0) + 1, 1),
          false
        )
      `);
    }

    logger.info(
      { table: spec.name, provided: rows.length, inserted },
      "Restore table processed",
    );
  }

  const total = Object.values(restored).reduce((a, b) => a + b, 0);
  return {
    restored,
    message:
      total === 0
        ? "Nothing to restore — the database already holds everything in this backup."
        : `Restored ${total} row${total === 1 ? "" : "s"}. Existing data was kept; only missing rows were added.`,
  };
}

/** A restore the operator can fix by choosing a different file. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

/**
 * Coerce one row into something the insert accepts.
 *
 * Timestamps arrive as ISO strings and must be Dates; JSON columns arrive as
 * already-parsed values. Anything unexpected is passed through so Postgres can
 * reject it with a precise error rather than this layer guessing.
 */
function normalizeRow(row: unknown, spec: TableSpec): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new RestoreError(
      `The backup's "${spec.name}" section contains an entry that is not an object.`,
    );
  }
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of spec.dateFields) {
    const value = out[field];
    if (typeof value === "string") {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new RestoreError(
          `The backup's "${spec.name}.${field}" is not a valid date.`,
        );
      }
      out[field] = date;
    }
  }
  return out;
}
