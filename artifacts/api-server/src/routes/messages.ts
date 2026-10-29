import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gt, gte, ilike, inArray, lte, or } from "drizzle-orm";
import {
  db,
  matchedMessagesTable,
  inboxMessagesTable,
  emailAccountsTable,
} from "@workspace/db";
import {
  DeleteMessageParams,
  GetMessageParams,
  ListMessagesQueryParams,
  ExportMessagesBody,
  DeleteMessagesBulkBody,
} from "@workspace/api-zod";
import { serializeDetail } from "../lib/message-detail";
import { buildKeywordHaystack, findKeywordMatches } from "../lib/scan-planner";
import { getSettings } from "../lib/settings";
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

/** Batch size for the archive re-check pass. */
const RECHECK_BATCH_ROWS = 500;

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

/**
 * Re-run keyword matching over the unfiltered archive.
 *
 * The archive (`inbox_messages`) holds every message from `all`-capture
 * mailboxes. When keywords change — or when a message was captured by the old
 * matcher, which missed keywords hidden in HTML entities and link targets —
 * this pass re-tests every archived message with the current keywords and
 * surfaces the hits in the Messages queue. Rows already matched are left
 * alone (the insert is a no-op on conflict), so it is safe to run repeatedly.
 *
 * Matched rows found here are never forwarded: forwarding is a live-scan
 * behaviour over a keyword-triage mailbox, and replaying archived mail would
 * send duplicates of anything already relayed.
 */
router.post("/messages/recheck-archive", async (_req, res) => {
  const settings = await getSettings();
  const keywords = settings.keywords ?? [];

  let scanned = 0;
  let inserted = 0;
  let lastId = 0;

  for (;;) {
    const rows = await db
      .select()
      .from(inboxMessagesTable)
      .where(gt(inboxMessagesTable.id, lastId))
      .orderBy(asc(inboxMessagesTable.id))
      .limit(RECHECK_BATCH_ROWS);
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      scanned++;
      const hits = findKeywordMatches(
        buildKeywordHaystack({
          subject: row.subject,
          from: row.fromAddress,
          to: row.toAddress,
          text: row.bodyText ?? "",
          html: row.bodyHtml ?? "",
        }),
        keywords,
      );
      if (hits.length === 0) continue;

      const result = await db
        .insert(matchedMessagesTable)
        .values({
          accountId: row.accountId,
          accountLabelSnapshot: row.accountLabelSnapshot,
          accountEmailSnapshot: row.accountEmailSnapshot,
          messageUid: row.messageUid,
          folder: row.folder,
          messageId: row.messageId,
          fromAddress: row.fromAddress,
          toAddress: row.toAddress,
          subject: row.subject,
          snippet: row.snippet,
          bodyText: row.bodyText,
          bodyHtml: row.bodyHtml,
          bodyTruncated: row.bodyTruncated,
          receivedAt: row.receivedAt,
          matchedKeywords: hits,
          forwarded: false,
          forwardError: null,
        })
        .onConflictDoNothing()
        .returning({ id: matchedMessagesTable.id });
      if (result[0]?.id !== undefined) inserted++;
    }
  }

  logger.info(
    { scanned, inserted, keywords: keywords.length },
    "Archive keyword re-check complete",
  );

  res.json({
    scanned,
    inserted,
    message:
      `Re-checked ${scanned} archived messages with the current keywords; ` +
      `${inserted} new match${inserted === 1 ? "" : "es"} surfaced in Messages.`,
  });
});

export default router;
