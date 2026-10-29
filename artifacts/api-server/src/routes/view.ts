import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  matchedMessagesTable,
  inboxMessagesTable,
  emailAccountsTable,
} from "@workspace/db";
import { authState } from "./auth";
import { verifyViewToken } from "../lib/auth";
import { serializeDetail } from "../lib/message-detail";
import { GetViewMessageParams } from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * One stored message, by signed link.
 *
 * Telegram alerts carry a link here so the reader can open the exact web view
 * of a critical match without a session. The token is an HMAC over the message
 * id and an expiry, signed with the app's session key material, so it cannot
 * be forged, cannot be enumerated, expires on its own, and dies with a
 * password change like every session does. It grants access to this one
 * message and nothing else.
 */
router.get("/view/:token", async (req, res) => {
  const { token } = GetViewMessageParams.parse({ token: req.params["token"] });

  if (!authState.enabled) {
    res.status(503).json({
      error: "AuthNotConfigured",
      message: authState.reason,
    });
    return;
  }

  const verdict = verifyViewToken(
    token,
    authState.config.sessionSecret,
    authState.config.passwordHash,
  );
  if (!verdict.valid) {
    // 404, not 401: the link is either expired or was never real, and there
    // is nothing to re-authenticate against — a fresh link must come from a
    // new Telegram alert.
    res.status(404).json({
      error: "NotFound",
      message:
        "This link is invalid or has expired. Open the message in Email " +
        "Watcher instead.",
    });
    return;
  }

  if (verdict.kind === "matched") {
    const [row] = await db
      .select({
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
        bodyText: matchedMessagesTable.bodyText,
        bodyHtml: matchedMessagesTable.bodyHtml,
        bodyTruncated: matchedMessagesTable.bodyTruncated,
        receivedAt: matchedMessagesTable.receivedAt,
        createdAt: matchedMessagesTable.createdAt,
        matchedKeywords: matchedMessagesTable.matchedKeywords,
        forwarded: matchedMessagesTable.forwarded,
        forwardError: matchedMessagesTable.forwardError,
        accountDeletedAt: emailAccountsTable.deletedAt,
      })
      .from(matchedMessagesTable)
      .leftJoin(
        emailAccountsTable,
        eq(emailAccountsTable.id, matchedMessagesTable.accountId),
      )
      .where(eq(matchedMessagesTable.id, verdict.id))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "NotFound", message: "Message not found" });
      return;
    }

    res.json(serializeDetail(row));
    return;
  }

  const [row] = await db
    .select({
      id: inboxMessagesTable.id,
      accountId: inboxMessagesTable.accountId,
      accountLabel: inboxMessagesTable.accountLabelSnapshot,
      accountEmail: inboxMessagesTable.accountEmailSnapshot,
      accountDeletedAt: emailAccountsTable.deletedAt,
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
    })
    .from(inboxMessagesTable)
    .leftJoin(
      emailAccountsTable,
      eq(emailAccountsTable.id, inboxMessagesTable.accountId),
    )
    .where(eq(inboxMessagesTable.id, verdict.id))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "NotFound", message: "Message not found" });
    return;
  }

  res.json(serializeDetail(row));
});

export default router;
