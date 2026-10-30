import { Router, type IRouter } from "express";
import { and, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";
import {
  db,
  matchedMessagesTable,
  emailAccountsTable,
} from "@workspace/db";
import {
  DeleteMessageParams,
  GetMessageParams,
  ListMessagesQueryParams,
  ExportMessagesBody,
  DeleteMessagesBulkBody,
  ListMessageIdsBody,
} from "@workspace/api-zod";
import { serializeDetail } from "../lib/message-detail";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Upper bound on one export.
 *
 * Full bodies are included, so an unbounded export of a large archive could
 * exhaust memory on a small instance. The cap is generous for real use; the
 * truncated flag in the response headers says when it was hit.
 */
const EXPORT_MAX_ROWS = 2000;

interface MessageFilters {
  accountId?: number;
  search?: string;
  receivedFrom?: Date;
  receivedTo?: Date;
}

/**
 * Shared filter construction for the list and export endpoints, so an export
 * covers exactly what the page is showing.
 */
function buildMatchedFilters(f: MessageFilters) {
  const filters = [];
  if (f.accountId !== undefined) {
    filters.push(eq(matchedMessagesTable.accountId, f.accountId));
  }
  if (f.receivedFrom) {
    filters.push(gte(matchedMessagesTable.receivedAt, f.receivedFrom));
  }
  if (f.receivedTo) {
    filters.push(lte(matchedMessagesTable.receivedAt, f.receivedTo));
  }
  const search = f.search?.trim();
  if (search) {
    // Ad-hoc lookup across the fields a person would scan by eye. `ilike`
    // with a leading wildcard cannot use a btree index, but this is an
    // interactive filter over a bounded page, not a hot path. The body is
    // included: a keyword the subject does not carry is exactly the match
    // this queue exists to find.
    const needle = `%${search}%`;
    const clause = or(
      ilike(matchedMessagesTable.subject, needle),
      ilike(matchedMessagesTable.fromAddress, needle),
      ilike(matchedMessagesTable.toAddress, needle),
      ilike(matchedMessagesTable.snippet, needle),
      ilike(matchedMessagesTable.bodyText, needle),
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

const MATCHED_LIST_COLUMNS = {
  id: matchedMessagesTable.id,
  accountId: matchedMessagesTable.accountId,
  accountLabel: matchedMessagesTable.accountLabelSnapshot,
  accountEmail: matchedMessagesTable.accountEmailSnapshot,
  messageUid: matchedMessagesTable.messageUid,
  folder: matchedMessagesTable.folder,
  messageId: matchedMessagesTable.messageId,
  fromAddress: matchedMessagesTable.fromAddress,
  toAddress: matchedMessagesTable.toAddress,
  subject: matchedMessagesTable.subject,
  snippet: matchedMessagesTable.snippet,
  receivedAt: matchedMessagesTable.receivedAt,
  matchedKeywords: matchedMessagesTable.matchedKeywords,
  forwarded: matchedMessagesTable.forwarded,
  forwardError: matchedMessagesTable.forwardError,
  createdAt: matchedMessagesTable.createdAt,
} as const;

router.get("/messages", async (req, res) => {
  const params = ListMessagesQueryParams.parse({
    accountId: req.query["accountId"]
      ? Number(req.query["accountId"])
      : undefined,
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

  // Attribution comes from the per-message snapshot, not the live account row,
  // so history is stable across renames, mailbox changes, and account removal.
  // The join only supplies whether the origin account still exists.
  //
  // Bodies are excluded on purpose: they can be hundreds of KB each, and a list
  // of 100 would be megabytes nobody has asked to read. GET /messages/:id serves
  // the full message.
  const filters = buildMatchedFilters({
    accountId: params.accountId,
    search: params.search,
    receivedFrom: receivedFrom ?? undefined,
    receivedTo: receivedTo ?? undefined,
  });

  const rows = await db
    .select({
      ...MATCHED_LIST_COLUMNS,
      accountDeletedAt: emailAccountsTable.deletedAt,
    })
    .from(matchedMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, matchedMessagesTable.accountId),
    )
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(
      desc(matchedMessagesTable.receivedAt),
      desc(matchedMessagesTable.id),
    )
    .limit(params.limit)
    .offset(params.offset);

  res.json(
    rows.map(({ accountDeletedAt, ...r }) => ({
      ...r,
      messageId: r.messageId ?? null,
      accountDeleted: accountDeletedAt !== null,
      forwardError: r.forwardError ?? null,
      receivedAt: r.receivedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

/** One message with its full body. */
router.get("/messages/:id", async (req, res) => {
  const { id } = GetMessageParams.parse({ id: Number(req.params["id"]) });

  const [row] = await db
    .select({
      id: matchedMessagesTable.id,
      accountId: matchedMessagesTable.accountId,
      accountLabel: matchedMessagesTable.accountLabelSnapshot,
      accountEmail: matchedMessagesTable.accountEmailSnapshot,
      accountDeletedAt: emailAccountsTable.deletedAt,
      messageUid: matchedMessagesTable.messageUid,
      folder: matchedMessagesTable.folder,
      messageId: matchedMessagesTable.messageId,
      fromAddress: matchedMessagesTable.fromAddress,
      toAddress: matchedMessagesTable.toAddress,
      subject: matchedMessagesTable.subject,
      snippet: matchedMessagesTable.snippet,
      bodyText: matchedMessagesTable.bodyText,
      bodyHtml: matchedMessagesTable.bodyHtml,
      bodyTruncated: matchedMessagesTable.bodyTruncated,
      receivedAt: matchedMessagesTable.receivedAt,
      createdAt: matchedMessagesTable.createdAt,
      matchedKeywords: matchedMessagesTable.matchedKeywords,
      forwarded: matchedMessagesTable.forwarded,
      forwardError: matchedMessagesTable.forwardError,
    })
    .from(matchedMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, matchedMessagesTable.accountId),
    )
    .where(eq(matchedMessagesTable.id, id))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "NotFound", message: "Message not found" });
    return;
  }

  res.json({
    ...serializeDetail(row),
    forwardError: row.forwardError ?? null,
  });
});

/**
 * Export messages to JSON, with the full email body included.
 *
 * Two mutually exclusive selections: an explicit list of `ids` (what the user
 * ticked), or the same filters the list endpoint accepts (what the user
 * searched) — omitting both exports everything. Selection-by-filter is what
 * makes "search a keyword, export every match" one click regardless of how
 * many pages the matches span.
 */
router.post("/messages/export", async (req, res) => {
  const body = ExportMessagesBody.parse(req.body);

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
    ? [inArray(matchedMessagesTable.id, [...new Set(body.ids)])]
    : buildMatchedFilters({
        accountId: body.accountId,
        search: body.search,
        receivedFrom: receivedFrom ?? undefined,
        receivedTo: receivedTo ?? undefined,
      });

  // One extra row is fetched so truncation can be reported without a count
  // query; the response carries the first EXPORT_MAX_ROWS either way.
  const rows = await db
    .select({
      id: matchedMessagesTable.id,
      accountId: matchedMessagesTable.accountId,
      accountLabel: matchedMessagesTable.accountLabelSnapshot,
      accountEmail: matchedMessagesTable.accountEmailSnapshot,
      accountDeletedAt: emailAccountsTable.deletedAt,
      messageUid: matchedMessagesTable.messageUid,
      folder: matchedMessagesTable.folder,
      messageId: matchedMessagesTable.messageId,
      fromAddress: matchedMessagesTable.fromAddress,
      toAddress: matchedMessagesTable.toAddress,
      subject: matchedMessagesTable.subject,
      snippet: matchedMessagesTable.snippet,
      bodyText: matchedMessagesTable.bodyText,
      bodyHtml: matchedMessagesTable.bodyHtml,
      bodyTruncated: matchedMessagesTable.bodyTruncated,
      receivedAt: matchedMessagesTable.receivedAt,
      createdAt: matchedMessagesTable.createdAt,
      matchedKeywords: matchedMessagesTable.matchedKeywords,
      forwarded: matchedMessagesTable.forwarded,
      forwardError: matchedMessagesTable.forwardError,
    })
    .from(matchedMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, matchedMessagesTable.accountId),
    )
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(
      desc(matchedMessagesTable.receivedAt),
      desc(matchedMessagesTable.id),
    )
    .limit(EXPORT_MAX_ROWS + 1);

  const truncated = rows.length > EXPORT_MAX_ROWS;
  const exportRows = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="messages-${stamp}.json"`,
  );
  res.setHeader("X-Export-Count", String(exportRows.length));
  if (truncated) res.setHeader("X-Export-Truncated", "true");
  if (truncated) {
    logger.warn({ requested: body }, "Message export truncated at cap");
  }

  res.json(exportRows.map((row) => serializeDetail(row)));
});

/**
 * Ids of every message matching the current filters.
 *
 * Powers "select all matching" in the UI: a search can span many pages, and
 * ticking each page by hand is not a workflow. Returns ids, not rows — one
 * integer per match keeps the payload small even at the cap — newest first,
 * so the selection order matches what the pages showed.
 */
router.post("/messages/ids", async (req, res) => {
  const body = ListMessageIdsBody.parse(req.body);

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

  const filters = buildMatchedFilters({
    accountId: body.accountId,
    search: body.search,
    receivedFrom: receivedFrom ?? undefined,
    receivedTo: receivedTo ?? undefined,
  });

  // One extra row to detect truncation without a count query, mirroring the
  // export endpoint's approach.
  const rows = await db
    .select({ id: matchedMessagesTable.id })
    .from(matchedMessagesTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(
      desc(matchedMessagesTable.receivedAt),
      desc(matchedMessagesTable.id),
    )
    .limit(EXPORT_MAX_ROWS + 1);

  const truncated = rows.length > EXPORT_MAX_ROWS;
  const ids = (truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows).map((r) => r.id);
  if (truncated) {
    logger.warn({ requested: body }, "Id selection truncated at cap");
  }

  res.json({ ids, truncated });
});

router.delete("/messages/:id", async (req, res) => {
  const { id } = DeleteMessageParams.parse({ id: Number(req.params["id"]) });
  await db.delete(matchedMessagesTable).where(eq(matchedMessagesTable.id, id));
  res.status(204).end();
});

/**
 * Delete several messages at once.
 *
 * POST rather than DELETE with a body: request bodies on DELETE are widely
 * dropped by proxies and are not reliably readable. Ids that matched nothing
 * are reported as notFound rather than erroring, since the requested end
 * state holds either way.
 */
router.post("/messages/delete-bulk", async (req, res) => {
  const body = DeleteMessagesBulkBody.parse(req.body);

  const ids = [...new Set(body.ids)];
  const removed = await db
    .delete(matchedMessagesTable)
    .where(inArray(matchedMessagesTable.id, ids))
    .returning({ id: matchedMessagesTable.id });

  const deleted = removed.map((r) => r.id);
  const deletedSet = new Set(deleted);
  const notFound = ids.filter((id) => !deletedSet.has(id));

  logger.info(
    { deleted: deleted.length, notFound: notFound.length },
    "Bulk message delete complete",
  );

  res.json({ deleted, notFound });
});

export default router;
