import {
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * A one-row-per-day liveness marker.
 *
 * Hosted free-tier databases pause after a period with no queries (Supabase free
 * pauses a project after ~1 week of inactivity). A scan already queries every
 * couple of minutes, but that only holds while the web service is awake — and on
 * a free host the service can be stopped or restarted at any time. This table
 * gives the database an unconditional daily write that does not depend on any
 * mailbox being reachable or any mail arriving.
 *
 * The date string is the primary key, so the table holds exactly one row: today's.
 * Yesterday's row is deleted as today's is written, which keeps the write an
 * actual mutation (an idempotent no-op UPDATE would not necessarily count as
 * activity) while the table never grows.
 */
export const heartbeatTable = pgTable("heartbeat", {
  /** `YYYY-MM-DD` in UTC. Primary key, so one row per day at most. */
  day: text("day").primaryKey(),
  /** When today's row was first written. */
  writtenAt: timestamp("written_at").notNull().defaultNow(),
  /** Bumped every time the beat runs on the same day, as a visible pulse. */
  touchedAt: timestamp("touched_at").notNull().defaultNow(),
});

export type Heartbeat = typeof heartbeatTable.$inferSelect;
export type InsertHeartbeat = typeof heartbeatTable.$inferInsert;
