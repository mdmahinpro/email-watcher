/**
 * Serialization shared by `/messages/{id}` and `/inbox/{id}`.
 *
 * The two tables carry the same captured-email shape, so the wire conversion
 * lives here rather than being written twice and drifting. The queries themselves
 * stay in their own route files: Drizzle's column types are table-specific, and a
 * generic "any table" select costs more in casts than it saves in duplication.
 *
 * Bodies are deliberately absent from the list endpoints — a page of 50 archived
 * newsletters would be megabytes of HTML nobody has asked to read yet — so they
 * are fetched one message at a time through these detail routes.
 */

export interface DetailRow {
  id: number;
  accountId: number;
  accountLabel: string;
  accountEmail: string;
  /** From the joined account row; null means the account still exists. */
  accountDeletedAt: Date | null;
  messageUid: string;
  /** IMAP folder the message was read from, such as INBOX or Junk. */
  folder: string;
  messageId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyTruncated: boolean;
  receivedAt: Date;
  createdAt: Date;
}

/** Convert a loaded row into the MessageDetail wire shape. */
export function serializeDetail<T extends DetailRow>(
  row: T,
): Record<string, unknown> {
  const { accountDeletedAt, receivedAt, createdAt, messageId, bodyText, bodyHtml, ...rest } =
    row;
  return {
    ...rest,
    messageId: messageId ?? null,
    bodyText: bodyText ?? null,
    bodyHtml: bodyHtml ?? null,
    // The internal timestamp is not part of the API contract; only the fact.
    accountDeleted: accountDeletedAt !== null,
    receivedAt: receivedAt.toISOString(),
    createdAt: createdAt.toISOString(),
  };
}
