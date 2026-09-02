import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  inboxMessagesTable,
  emailAccountsTable,
} from "@workspace/db";
import {
  DeleteInboxMessageParams,
  GetInboxMessageParams,
  ListInboxMessagesQueryParams,
} from "@workspace/api-zod";
import { serializeDetail } from "../lib/message-detail";

const router: IRouter = Router();

/**
 * The unfiltered mailbox archive.
 *
 * Deliberately a separate resource from `/messages`. That endpoint is the
 * keyword triage queue — a row there means "this needs attention" and drives
 * forwarding and keyword stats. This one is a complete record of what arrived in
 * mailboxes whose capture mode is `all`, which is a different question at a very
 * different volume, so the two are never mixed.
 */
router.get("/inbox", async (req, res) => {
  const params = ListInboxMessagesQueryParams.parse({
    accountId: req.query["accountId"]
      ? Number(req.query["accountId"])
      : undefined,
    provider: req.query["provider"],
    search: req.query["search"],
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
    offset: req.query["offset"] ? Number(req.query["offset"]) : undefined,
  });

  const filters = [];
  if (params.accountId !== undefined) {
    filters.push(eq(inboxMessagesTable.accountId, params.accountId));
  }
  if (params.provider !== undefined) {
    filters.push(eq(emailAccountsTable.provider, params.provider));
  }

  const search = params.search?.trim();
  if (search) {
    // Ad-hoc lookup across the fields a person would scan by eye. `ilike` with
    // a leading wildcard cannot use a btree index, but this is an interactive
    // filter over a bounded page, not a hot path.
    const needle = `%${search}%`;
    const clause = or(
      ilike(inboxMessagesTable.subject, needle),
      ilike(inboxMessagesTable.fromAddress, needle),
      ilike(inboxMessagesTable.snippet, needle),
    );
    if (clause) filters.push(clause);
  }

  const rows = await db
    .select({
      id: inboxMessagesTable.id,
      accountId: inboxMessagesTable.accountId,
      // Attribution comes from the per-message snapshot, not the live account
      // row, so it survives renames and account removal.
      accountLabel: inboxMessagesTable.accountLabelSnapshot,
      accountEmail: inboxMessagesTable.accountEmailSnapshot,
      accountDeletedAt: emailAccountsTable.deletedAt,
      messageUid: inboxMessagesTable.messageUid,
      messageId: inboxMessagesTable.messageId,
      fromAddress: inboxMessagesTable.fromAddress,
      toAddress: inboxMessagesTable.toAddress,
      subject: inboxMessagesTable.subject,
      // Bodies are excluded here on purpose: a page of 50 archived newsletters
      // would be megabytes of HTML nobody has asked to read. GET /inbox/:id
      // serves the full message.
      snippet: inboxMessagesTable.snippet,
      receivedAt: inboxMessagesTable.receivedAt,
      createdAt: inboxMessagesTable.createdAt,
    })
    .from(inboxMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, inboxMessagesTable.accountId),
    )
    .where(filters.length > 0 ? and(...filters) : sql`true`)
    .orderBy(desc(inboxMessagesTable.receivedAt), desc(inboxMessagesTable.id))
    .limit(params.limit)
    .offset(params.offset);

  res.json(
    rows.map(({ accountDeletedAt, ...r }) => ({
      ...r,
      messageId: r.messageId ?? null,
      accountDeleted: accountDeletedAt !== null,
      receivedAt: r.receivedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

/** One archived message with its full body. */
router.get("/inbox/:id", async (req, res) => {
  const { id } = GetInboxMessageParams.parse({ id: Number(req.params["id"]) });

  const [row] = await db
    .select({
      id: inboxMessagesTable.id,
      accountId: inboxMessagesTable.accountId,
      accountLabel: inboxMessagesTable.accountLabelSnapshot,
      accountEmail: inboxMessagesTable.accountEmailSnapshot,
      accountDeletedAt: emailAccountsTable.deletedAt,
      messageUid: inboxMessagesTable.messageUid,
      messageId: inboxMessagesTable.messageId,
      fromAddress: inboxMessagesTable.fromAddress,
      toAddress: inboxMessagesTable.toAddress,
      subject: inboxMessagesTable.subject,
      snippet: inboxMessagesTable.snippet,
      bodyText: inboxMessagesTable.bodyText,
      bodyHtml: inboxMessagesTable.bodyHtml,
      bodyTruncated: inboxMessagesTable.bodyTruncated,
      receivedAt: inboxMessagesTable.receivedAt,
      createdAt: inboxMessagesTable.createdAt,
    })
    .from(inboxMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, inboxMessagesTable.accountId),
    )
    .where(eq(inboxMessagesTable.id, id))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "NotFound", message: "Message not found" });
    return;
  }

  res.json(serializeDetail(row));
});

router.delete("/inbox/:id", async (req, res) => {
  const { id } = DeleteInboxMessageParams.parse({
    id: Number(req.params["id"]),
  });
  await db.delete(inboxMessagesTable).where(eq(inboxMessagesTable.id, id));
  res.status(204).end();
});

export default router;
