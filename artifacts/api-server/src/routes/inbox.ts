import { Router, type IRouter } from "express";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import {
  db,
  inboxMessagesTable,
  emailAccountsTable,
} from "@workspace/db";
import {
  DeleteInboxMessageParams,
  GetInboxMessageParams,
  ListInboxMessagesQueryParams,
  ExportInboxMessagesBody,
  DeleteInboxMessagesBulkBody,
} from "@workspace/api-zod";
import { serializeDetail, type DetailRow } from "../lib/message-detail";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Upper bound on one export; see the /messages/export counterpart.
 */
const EXPORT_MAX_ROWS = 2000;

interface InboxFilters {
  accountId?: number;
  provider?: "generic" | "hostinger";
  search?: string;
  receivedFrom?: Date;
  receivedTo?: Date;
}

/** Shared filter construction for the list and export endpoints. */
function buildInboxFilters(f: InboxFilters) {
  const filters = [];
  if (f.accountId !== undefined) {
    filters.push(eq(inboxMessagesTable.accountId, f.accountId));
  }
  if (f.provider !== undefined) {
    filters.push(eq(emailAccountsTable.provider, f.provider));
  }
  if (f.receivedFrom) {
    filters.push(gte(inboxMessagesTable.receivedAt, f.receivedFrom));
  }
  if (f.receivedTo) {
    filters.push(lte(inboxMessagesTable.receivedAt, f.receivedTo));
  }
  const search = f.search?.trim();
  if (search) {
    // Ad-hoc lookup across the fields a person would scan by eye. `ilike` with
    // a leading wildcard cannot use a btree index, but this is an interactive
    // filter over a bounded page, not a hot path. The plain-text body is
    // included: the snippet is only 320 characters, and searching "the whole
    // email" is what a person expects the box to do.
    const needle = `%${search}%`;
    const clause = or(
      ilike(inboxMessagesTable.subject, needle),
      ilike(inboxMessagesTable.fromAddress, needle),
      ilike(inboxMessagesTable.toAddress, needle),
      ilike(inboxMessagesTable.snippet, needle),
      ilike(inboxMessagesTable.bodyText, needle),
    );
    if (clause) filters.push(clause);
  }
  return filters;
}

/** Parse an ISO date query parameter; undefined when absent, null when invalid. */
function parseDateParam(value: unknown): Date | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

const INBOX_DETAIL_COLUMNS = {
  id: inboxMessagesTable.id,
  accountId: inboxMessagesTable.accountId,
  accountLabel: inboxMessagesTable.accountLabelSnapshot,
  accountEmail: inboxMessagesTable.accountEmailSnapshot,
  messageUid: inboxMessagesTable.messageUid,
  folder: inboxMessagesTable.folder,
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
} as const;

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
    receivedFrom: req.query["receivedFrom"],
    receivedTo: req.query["receivedTo"],
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
    offset: req.query["offset"] ? Number(req.query["offset"]) : undefined,
  });

  const receivedFrom = parseDateParam(params.receivedFrom);
  const receivedTo = parseDateParam(params.receivedTo);
  if (params.receivedFrom !== undefined && receivedFrom === null) {
    res
      .status(400)
      .json({ error: "ValidationError", message: "receivedFrom is not a valid date" });
    return;
  }
  if (params.receivedTo !== undefined && receivedTo === null) {
    res
      .status(400)
      .json({ error: "ValidationError", message: "receivedTo is not a valid date" });
    return;
  }

  const filters = buildInboxFilters({
    accountId: params.accountId,
    provider: params.provider,
    search: params.search,
    receivedFrom: receivedFrom ?? undefined,
    receivedTo: receivedTo ?? undefined,
  });

  const rows = await db
    .select({
      ...INBOX_DETAIL_COLUMNS,
      // Bodies are excluded here on purpose: a page of 50 archived newsletters
      // would be megabytes of HTML nobody has asked to read. GET /inbox/:id
      // serves the full message.
      accountDeletedAt: emailAccountsTable.deletedAt,
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
      ...INBOX_DETAIL_COLUMNS,
      accountDeletedAt: emailAccountsTable.deletedAt,
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

  res.json(serializeDetail(row satisfies DetailRow & { accountDeletedAt: Date | null }));
});

/**
 * Export archived messages to JSON, with the full email body included.
 *
 * `ids` selects exactly what the user ticked; otherwise the same filters as
 * the list endpoint apply, so "search, then export every match" works in one
 * click across any number of pages.
 */
router.post("/inbox/export", async (req, res) => {
  const body = ExportInboxMessagesBody.parse(req.body);

  const receivedFrom = parseDateParam(body.receivedFrom);
  const receivedTo = parseDateParam(body.receivedTo);
  if (body.receivedFrom !== undefined && receivedFrom === null) {
    res
      .status(400)
      .json({ error: "ValidationError", message: "receivedFrom is not a valid date" });
    return;
  }
  if (body.receivedTo !== undefined && receivedTo === null) {
    res
      .status(400)
      .json({ error: "ValidationError", message: "receivedTo is not a valid date" });
    return;
  }

  const byIds = Array.isArray(body.ids) && body.ids.length > 0;
  const filters = byIds
    ? [inArray(inboxMessagesTable.id, [...new Set(body.ids)])]
    : buildInboxFilters({
        accountId: body.accountId,
        provider: body.provider,
        search: body.search,
        receivedFrom: receivedFrom ?? undefined,
        receivedTo: receivedTo ?? undefined,
      });

  const rows = await db
    .select({
      ...INBOX_DETAIL_COLUMNS,
      accountDeletedAt: emailAccountsTable.deletedAt,
    })
    .from(inboxMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, inboxMessagesTable.accountId),
    )
    .where(filters.length > 0 ? and(...filters) : sql`true`)
    .orderBy(desc(inboxMessagesTable.receivedAt), desc(inboxMessagesTable.id))
    .limit(EXPORT_MAX_ROWS + 1);

  const truncated = rows.length > EXPORT_MAX_ROWS;
  const exportRows = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="inbox-${stamp}.json"`,
  );
  res.setHeader("X-Export-Count", String(exportRows.length));
  if (truncated) res.setHeader("X-Export-Truncated", "true");
  if (truncated) {
    logger.warn({ requested: body }, "Inbox export truncated at cap");
  }

  res.json(
    exportRows.map((row) =>
      serializeDetail(row satisfies DetailRow & { accountDeletedAt: Date | null }),
    ),
  );
});

router.delete("/inbox/:id", async (req, res) => {
  const { id } = DeleteInboxMessageParams.parse({
    id: Number(req.params["id"]),
  });
  await db.delete(inboxMessagesTable).where(eq(inboxMessagesTable.id, id));
  res.status(204).end();
});

/**
 * Delete several archived messages at once.
 *
 * POST rather than DELETE with a body, matching /messages/delete-bulk; ids
 * that matched nothing are reported as notFound.
 */
router.post("/inbox/delete-bulk", async (req, res) => {
  const body = DeleteInboxMessagesBulkBody.parse(req.body);

  const ids = [...new Set(body.ids)];
  const removed = await db
    .delete(inboxMessagesTable)
    .where(inArray(inboxMessagesTable.id, ids))
    .returning({ id: inboxMessagesTable.id });

  const deleted = removed.map((r) => r.id);
  const deletedSet = new Set(deleted);
  const notFound = ids.filter((id) => !deletedSet.has(id));

  logger.info(
    { deleted: deleted.length, notFound: notFound.length },
    "Bulk inbox message delete complete",
  );

  res.json({ deleted, notFound });
});

export default router;
