import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  matchedMessagesTable,
  emailAccountsTable,
} from "@workspace/db";
import {
  DeleteMessageParams,
  GetMessageParams,
  ListMessagesQueryParams,
} from "@workspace/api-zod";
import { serializeDetail } from "../lib/message-detail";

const router: IRouter = Router();

router.get("/messages", async (req, res) => {
  const params = ListMessagesQueryParams.parse({
    accountId: req.query["accountId"]
      ? Number(req.query["accountId"])
      : undefined,
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
    offset: req.query["offset"] ? Number(req.query["offset"]) : undefined,
  });

  // Attribution comes from the per-message snapshot, not the live account row,
  // so history is stable across renames, mailbox changes, and account removal.
  // The join only supplies whether the origin account still exists.
  //
  // Bodies are excluded on purpose: they can be hundreds of KB each, and a list
  // of 100 would be megabytes nobody has asked to read. GET /messages/:id serves
  // the full message.
  const baseSelect = db
    .select({
      id: matchedMessagesTable.id,
      accountId: matchedMessagesTable.accountId,
      accountLabel: matchedMessagesTable.accountLabelSnapshot,
      accountEmail: matchedMessagesTable.accountEmailSnapshot,
      accountDeletedAt: emailAccountsTable.deletedAt,
      messageUid: matchedMessagesTable.messageUid,
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
    })
    .from(matchedMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, matchedMessagesTable.accountId),
    );

  const rows = await (params.accountId
    ? baseSelect
        .where(eq(matchedMessagesTable.accountId, params.accountId))
        .orderBy(
          desc(matchedMessagesTable.receivedAt),
          desc(matchedMessagesTable.id),
        )
        .limit(params.limit)
        .offset(params.offset)
    : baseSelect
        .orderBy(
          desc(matchedMessagesTable.receivedAt),
          desc(matchedMessagesTable.id),
        )
        .limit(params.limit)
        .offset(params.offset));

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

router.delete("/messages/:id", async (req, res) => {
  const { id } = DeleteMessageParams.parse({ id: Number(req.params["id"]) });
  await db.delete(matchedMessagesTable).where(eq(matchedMessagesTable.id, id));
  res.status(204).end();
});

export default router;
