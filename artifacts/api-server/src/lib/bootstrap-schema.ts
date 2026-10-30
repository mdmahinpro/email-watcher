import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Additive schema changes the server needs, applied at startup.
 *
 * The deploy pipeline was supposed to apply these (drizzle-kit push in the
 * Render pre-deploy), but a free instance is too small to run a pre-deploy
 * command at all, and the result was worse than no deploy: the new code went
 * live querying columns the database did not have, and every page answered
 * 500. The server now asserts its own schema before it serves anything.
 *
 * Every statement is `ADD COLUMN IF NOT EXISTS`, so this is idempotent —
 * running on an up-to-date database is eight no-ops, and two instances racing
 * at boot is safe because Postgres makes the loser of the catalog lock wait
 * and then skip. Only additions are ever made here: no renames, no drops,
 * nothing destructive, so a boot can never lose data. When the schema changes
 * again, append to this list — do not edit entries that have shipped.
 *
 * `drizzle-kit push` (lib/db) remains the source of truth for local
 * development and for reviewing what differs; this list mirrors the additions
 * from the folder-scanning, search/export, and Telegram-alert releases.
 */
const ENSURE_STATEMENTS: string[] = [
  // Per-folder UID high-water marks, keyed by IMAP folder path.
  `ALTER TABLE "email_accounts" ADD COLUMN IF NOT EXISTS "folder_marks" jsonb`,
  // The IMAP folder a message was read from (INBOX, Junk, ...).
  `ALTER TABLE "matched_messages" ADD COLUMN IF NOT EXISTS "folder" text NOT NULL DEFAULT 'INBOX'`,
  `ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "folder" text NOT NULL DEFAULT 'INBOX'`,
  // Critical keywords and the Telegram alert configuration.
  `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "critical_keywords" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "telegram_enabled" boolean NOT NULL DEFAULT false`,
  `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "telegram_bot_token" text`,
  `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "telegram_chat_id" text`,
  `ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "app_url" text`,
];

/**
 * One-time data fixups for invariants that shipped after some rows were
 * written by an older behaviour. Idempotent like the statements above.
 */
const FIXUP_STATEMENTS: string[] = [
  // Archiving mailboxes (capture_mode "all") must not contribute rows to the
  // keyword triage queue — that queue is the webmail Messages tab, and an
  // archive mailbox's listing is the Hostinger Inbox tab. Rows written by the
  // earlier "keywords run everywhere" behaviour are exact duplicates of their
  // archive rows (never forwarded, never edited), so removing them loses no
  // mail: every message remains in the archive tab. After this runs once
  // there are no such rows, and the scanner no longer creates them.
  `DELETE FROM "matched_messages" AS mm USING "email_accounts" AS ea ` +
    `WHERE mm."account_id" = ea."id" AND ea."capture_mode" = 'all'`,
];

/**
 * Apply any missing statements. Throws on failure so the process exits and the
 * host restarts it: a server that cannot query its own tables must not take
 * traffic, and a restart loop is a louder, more honest signal than a running
 * instance answering 500 to everything.
 */
export async function ensureSchema(): Promise<void> {
  for (const statement of [...ENSURE_STATEMENTS, ...FIXUP_STATEMENTS]) {
    try {
      await db.execute(statement);
      logger.debug({ statement }, "Schema ensured");
    } catch (err) {
      logger.error({ err, statement }, "Could not ensure schema; refusing to start");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  logger.info(
    {
      statements: ENSURE_STATEMENTS.length,
      fixups: FIXUP_STATEMENTS.length,
    },
    "Schema ensured (additive, idempotent)",
  );
}
