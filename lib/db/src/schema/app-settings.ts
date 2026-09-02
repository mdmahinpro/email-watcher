import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const appSettingsTable = pgTable(
  "app_settings",
  {
    id: serial("id").primaryKey(),
    keywords: jsonb("keywords").$type<string[]>().notNull(),
    forwardToEmail: text("forward_to_email"),
    pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(120),
    forwardingEnabled: boolean("forwarding_enabled").notNull().default(true),
    /**
     * Drop stored message bodies older than this many days, keeping the row and
     * its snippet. A row without a body is ~1 KB versus ~13 KB with one, so this
     * recovers most of the space while leaving history searchable.
     *
     * 0 means keep forever, which is the default so an upgrade never silently
     * destroys data.
     */
    retainBodiesDays: integer("retain_bodies_days").notNull().default(0),
    /**
     * Delete messages older than this many days outright. 0 means keep forever.
     * Only needed when even the metadata rows become too many.
     */
    retainMessagesDays: integer("retain_messages_days").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  // Note: this only restates the primary key's uniqueness. The single-row
  // invariant is enforced in application code, which always reads and writes
  // the row with the lowest id.
  (t) => [uniqueIndex("app_settings_singleton_idx").on(t.id)],
);

export type AppSettings = typeof appSettingsTable.$inferSelect;
export type InsertAppSettings = typeof appSettingsTable.$inferInsert;
