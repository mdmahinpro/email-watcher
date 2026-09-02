import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { emailAccountsTable } from "./email-accounts";
import { messageContentColumns } from "./message-content";

export const matchedMessagesTable = pgTable(
  "matched_messages",
  {
    id: serial("id").primaryKey(),
    /**
     * Accounts are soft-deleted (`email_accounts.deleted_at`), so this reference
     * stays valid for the lifetime of the message. `restrict` is a backstop: a
     * hard DELETE that would orphan history is refused at the database level
     * rather than silently nulling the link.
     */
    accountId: integer("account_id")
      .notNull()
      .references(() => emailAccountsTable.id, { onDelete: "restrict" }),
    /**
     * Account label and address as they were when the message was captured.
     *
     * The live account row can be renamed, re-pointed at another mailbox, or
     * soft-deleted. History must keep showing where a message actually came
     * from, so these are snapshotted at capture time and never updated.
     */
    accountLabelSnapshot: text("account_label_snapshot").notNull(),
    accountEmailSnapshot: text("account_email_snapshot").notNull(),
    ...messageContentColumns(),
    matchedKeywords: jsonb("matched_keywords").$type<string[]>().notNull(),
    forwarded: boolean("forwarded").notNull().default(false),
    forwardError: text("forward_error"),
  },
  (t) => [
    uniqueIndex("matched_messages_account_uid_idx").on(t.accountId, t.messageUid),
    // Listings are ordered by receivedAt desc, optionally filtered by account.
    index("matched_messages_received_at_idx").on(t.receivedAt),
    index("matched_messages_account_received_idx").on(t.accountId, t.receivedAt),
  ],
);

export type MatchedMessage = typeof matchedMessagesTable.$inferSelect;
export type InsertMatchedMessage = typeof matchedMessagesTable.$inferInsert;
