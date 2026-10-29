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
    /**
     * The short list that is worth interrupting you for.
     *
     * Regular keywords only list a match in the app; a critical match also
     * pushes a Telegram message with the whole email and a link to its exact
     * web view. Kept separate so the notification list can stay small and
     * high-signal while the regular list stays broad.
     */
    criticalKeywords: jsonb("critical_keywords")
      .$type<string[]>()
      .notNull()
      .default([]),
    forwardToEmail: text("forward_to_email"),
    pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(120),
    forwardingEnabled: boolean("forwarding_enabled").notNull().default(true),
    /**
     * Push a Telegram message for every critical-keyword match.
     *
     * Off by default: nothing is sent until the bot token and chat id are
     * configured and this is switched on.
     */
    telegramEnabled: boolean("telegram_enabled").notNull().default(false),
    /** Bot token from @BotFather. Stored in the database, never echoed back. */
    telegramBotToken: text("telegram_bot_token"),
    /** The chat that receives the alerts, from @userinfobot or a forwarded message. */
    telegramChatId: text("telegram_chat_id"),
    /**
     * The public address of this app (https://email-watcher.example.com), used
     * to build the "open in Email Watcher" link in Telegram alerts. Falls back
     * to RENDER_EXTERNAL_URL when unset.
     */
    appUrl: text("app_url"),
    /**
     * Drop stored message bodies older than this many days, keeping the row
     * and its snippet. A row without a body is ~1 KB versus ~13 KB with one, so this
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
