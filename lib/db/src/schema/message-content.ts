import { text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Columns shared by `matched_messages` and `inbox_messages`.
 *
 * The two tables are separate resources with different volume profiles, but a
 * captured email has the same shape either way, so the column set is defined once
 * to keep them from drifting.
 */

/**
 * Upper bounds on stored body size.
 *
 * A single email with inline base64 images can run to several megabytes. An
 * `all`-capture mailbox archives everything, so an uncapped body column would
 * exhaust a free-tier database (Supabase free is 500 MB) within a few hundred
 * messages. These caps keep a worst-case message under ~640 KB while leaving
 * ordinary mail untouched — a long newsletter is a few tens of KB of text.
 *
 * When a body is cut, `bodyTruncated` is set so the UI can say so rather than
 * silently showing a fragment.
 */
export const BODY_LIMITS = {
  text: 128 * 1024,
  html: 512 * 1024,
} as const;

/** Preview length stored on the row for list views. */
export const SNIPPET_LENGTH = 320;

export function messageContentColumns() {
  return {
    messageUid: text("message_uid").notNull(),
    /**
     * IMAP folder the message was read from, such as `INBOX` or `Junk`.
     *
     * Review invitations and reward mails are routinely filtered into the junk
     * folder, so scans read the junk folders too. The folder is recorded so a
     * message found in Junk can be told apart from an inbox one, and so exports
     * say where the mail actually was.
     *
     * Rows captured before this column existed default to INBOX, which was the
     * only folder the scanner read at the time.
     */
    folder: text("folder").notNull().default("INBOX"),
    /** RFC 5322 Message-ID, when the source message carried one. */
    messageId: text("message_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    /** Short preview for list rows, so a list query never reads the body. */
    snippet: text("snippet").notNull(),
    /**
     * Full plain-text body, up to BODY_LIMITS.text.
     *
     * Nullable because rows captured before this column existed have no body, and
     * because a message can genuinely be HTML-only.
     */
    bodyText: text("body_text"),
    /** Full HTML body, up to BODY_LIMITS.html. Rendered sandboxed, never inline. */
    bodyHtml: text("body_html"),
    /** True when either body hit its cap and was cut. */
    bodyTruncated: boolean("body_truncated").notNull().default(false),
    receivedAt: timestamp("received_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  };
}
