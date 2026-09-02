import {
  pgTable,
  serial,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { emailAccountsTable } from "./email-accounts";
import { messageContentColumns } from "./message-content";

/**
 * Every email seen in an unfiltered mailbox, regardless of keywords.
 *
 * Kept separate from `matched_messages` on purpose. `matched_messages` is a
 * keyword-triage queue: a row there means "this needs attention", and it feeds
 * forwarding and the keyword stats. This table is an archive of everything that
 * arrived, which is a different question with a different volume profile, so
 * mixing the two would drown the triage queue and distort every stat derived
 * from it.
 */
export const inboxMessagesTable = pgTable(
  "inbox_messages",
  {
    id: serial("id").primaryKey(),
    /**
     * Accounts are soft-deleted (`email_accounts.deleted_at`), so this reference
     * stays valid for the lifetime of the message. `restrict` is a backstop: a
     * hard DELETE that would orphan history is refused at the database level.
     */
    accountId: integer("account_id")
      .notNull()
      .references(() => emailAccountsTable.id, { onDelete: "restrict" }),
    /**
     * Account label and address as they were when the message was captured, so
     * renaming, re-pointing, or removing the account cannot rewrite history.
     */
    accountLabelSnapshot: text("account_label_snapshot").notNull(),
    accountEmailSnapshot: text("account_email_snapshot").notNull(),
    ...messageContentColumns(),
  },
  (t) => [
    uniqueIndex("inbox_messages_account_uid_idx").on(t.accountId, t.messageUid),
    // Listings are ordered by receivedAt desc, optionally filtered by account.
    index("inbox_messages_received_at_idx").on(t.receivedAt),
    index("inbox_messages_account_received_idx").on(t.accountId, t.receivedAt),
  ],
);

export type InboxMessage = typeof inboxMessagesTable.$inferSelect;
export type InsertInboxMessage = typeof inboxMessagesTable.$inferInsert;
