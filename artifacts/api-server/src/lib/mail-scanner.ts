import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  emailAccountsTable,
  matchedMessagesTable,
  inboxMessagesTable,
  BODY_LIMITS,
  type EmailAccount,
} from "@workspace/db";
import { getSettings } from "./settings";
import { logger } from "./logger";
import {
  capBody,
  findKeywordMatches,
  makeSnippet,
  mapWithConcurrency,
  resolveScanTargets,
} from "./scan-planner";

/** Guard against an IMAP server that accepts the socket but never responds. */
const IMAP_TIMEOUTS = {
  greetingTimeout: 15_000,
  connectionTimeout: 20_000,
  socketTimeout: 120_000,
} as const;

/**
 * Bound every SMTP phase. Without these, a destination whose MX never answers
 * blocks the scan loop long enough for the idle IMAP socket to time out.
 */
const SMTP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
} as const;

/** How many accounts a background sweep scans at once. */
const SCAN_CONCURRENCY = 4;

/**
 * Scans in flight, keyed by account id.
 *
 * A manual `POST /accounts/:id/scan` can land while the scheduler is already
 * scanning the same account. Two scans then fetch the same UID range, and the
 * loser of the insert race sees every match as a conflict and silently skips
 * forwarding it. Sharing the in-flight promise makes the second caller observe
 * the first scan's result instead of duplicating the work.
 */
const inFlightScans = new Map<number, Promise<ScanOutcome>>();

function createImapClient(account: EmailAccount): ImapFlow {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.username, pass: account.password },
    logger: false,
    ...IMAP_TIMEOUTS,
  });

  // ImapFlow is an EventEmitter that emits 'error' asynchronously (for example
  // on socket timeout). Without a listener, Node turns that into an uncaught
  // exception and the whole server process exits. The in-flight command rejects
  // separately and is handled by the caller's try/catch, so this listener only
  // needs to keep the event from going unhandled.
  client.on("error", (err) => {
    logger.warn(
      { err, accountId: account.id, host: account.imapHost },
      "IMAP connection error",
    );
  });

  return client;
}

export async function testAccountConnection(
  account: EmailAccount,
): Promise<{ ok: boolean; message: string }> {
  const client = createImapClient(account);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = await client.status("INBOX", { messages: true });
      return {
        ok: true,
        message: `Connected. INBOX has ${status.messages ?? 0} messages.`,
      };
    } finally {
      lock.release();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg };
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}

export interface ScanOutcome {
  scanned: number;
  matched: number;
  archived: number;
  forwarded: number;
  message: string;
}

/** Advance the stored high-water mark and clear any previous failure. */
async function commitProgress(
  accountId: number,
  lastUidSeen: number,
): Promise<void> {
  await db
    .update(emailAccountsTable)
    .set({ lastUidSeen, lastCheckedAt: new Date(), lastError: null })
    .where(eq(emailAccountsTable.id, accountId));
}

/**
 * A stored match that still needs to be forwarded. Forwarding happens after the
 * IMAP connection is released, so a slow or unresponsive SMTP server cannot hold
 * the mailbox open until the IMAP socket times out.
 */
interface PendingForward {
  rowId: number;
  uid: number;
  subject: string;
  fromAddress: string;
  toAddress: string;
  receivedAt: Date;
  text: string;
  html: string;
  hits: string[];
}

function buildForwardBody(
  account: EmailAccount,
  item: PendingForward,
  forwardTo: string,
) {
  const header = [
    `Matched keywords: ${item.hits.join(", ")}`,
    `From: ${item.fromAddress}`,
    `Original To: ${item.toAddress}`,
    `Received: ${item.receivedAt.toISOString()}`,
  ].join("\n");

  return {
    from: account.emailAddress,
    to: forwardTo,
    subject: `[Watch:${account.label}] ${item.subject}`,
    text: `${header}\n\n---\n\n${item.text}`,
    html: item.html
      ? `<p><b>Matched keywords:</b> ${item.hits
          .map((h) => `<code>${h}</code>`)
          .join(", ")}<br/><b>From:</b> ${item.fromAddress}<br/><b>Original To:</b> ${item.toAddress}<br/><b>Received:</b> ${item.receivedAt.toISOString()}</p><hr/>${item.html}`
      : undefined,
  };
}

/**
 * Forward each stored match and record the outcome on its row.
 *
 * Runs with no IMAP connection held. A failure is recorded per message and does
 * not abort the remaining forwards.
 */
async function forwardPending(
  account: EmailAccount,
  pending: PendingForward[],
  forwardTo: string,
): Promise<number> {
  if (pending.length === 0) return 0;

  const transporter: Transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: account.username, pass: account.password },
    ...SMTP_TIMEOUTS,
  });

  let forwarded = 0;
  try {
    for (const item of pending) {
      let forwardError: string | null = null;
      try {
        await transporter.sendMail(buildForwardBody(account, item, forwardTo));
        forwarded++;
      } catch (err: unknown) {
        forwardError = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, accountId: account.id, uid: item.uid },
          "Failed to forward matched email",
        );
      }

      try {
        await db
          .update(matchedMessagesTable)
          .set({ forwarded: forwardError === null, forwardError })
          .where(eq(matchedMessagesTable.id, item.rowId));
      } catch (err) {
        logger.error(
          { err, accountId: account.id, messageId: item.rowId },
          "Failed to record forwarding outcome",
        );
      }
    }
  } finally {
    transporter.close();
  }

  return forwarded;
}

export async function scanAccount(
  account: EmailAccount,
): Promise<ScanOutcome> {
  const existing = inFlightScans.get(account.id);
  if (existing) {
    logger.info(
      { accountId: account.id },
      "Scan already in progress; awaiting the running scan",
    );
    return existing;
  }

  const run = runScan(account).finally(() => {
    inFlightScans.delete(account.id);
  });
  inFlightScans.set(account.id, run);
  return run;
}

async function runScan(account: EmailAccount): Promise<ScanOutcome> {
  const settings = await getSettings();
  const keywords = settings.keywords ?? [];
  const forwardTo = settings.forwardToEmail?.trim() ?? "";

  // An `all` mailbox archives everything and forwards nothing: relaying every
  // arriving message would be a mail loop waiting to happen, and the point of
  // that mode is a complete record rather than an attention queue.
  const archiveEverything = account.captureMode === "all";
  const forwardingActive =
    !archiveEverything && settings.forwardingEnabled && forwardTo.length > 0;

  const client = createImapClient(account);

  let scanned = 0;
  let matched = 0;
  let archived = 0;
  const pending: PendingForward[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const target = await resolveScanTargets(client, account.lastUidSeen);
      if (!target) {
        await commitProgress(account.id, account.lastUidSeen ?? 0);
        return {
          scanned: 0,
          matched: 0,
          archived: 0,
          forwarded: 0,
          message: "No new messages.",
        };
      }

      let highestUid = target.baseline;

      for await (const msg of client.fetch(
        target.uids,
        {
          uid: true,
          envelope: true,
          source: true,
          internalDate: true,
        },
        { uid: true },
      )) {
        scanned++;
        const uid = msg.uid;

        const sourceBuf = msg.source as Buffer | undefined;
        if (!sourceBuf) {
          // Leave the high-water mark behind this message so a later scan can
          // retry it instead of skipping it permanently.
          logger.warn(
            { accountId: account.id, uid },
            "Message had no source; will retry on next scan",
          );
          break;
        }

        const parsed = await simpleParser(sourceBuf);
        const subject = parsed.subject ?? "(no subject)";
        const text = parsed.text ?? "";
        const html = parsed.html ? parsed.html.toString() : "";
        const plainBody = text || html.replace(/<[^>]*>/g, " ");
        const fromAddress =
          parsed.from?.text ?? msg.envelope?.from?.[0]?.address ?? "";
        const toAddressRaw = parsed.to;
        const toAddress = Array.isArray(toAddressRaw)
          ? toAddressRaw.map((a) => a.text).join(", ")
          : (toAddressRaw?.text ??
            msg.envelope?.to?.[0]?.address ??
            account.emailAddress);

        const rawDate = parsed.date ?? msg.internalDate ?? new Date();
        const receivedAt =
          rawDate instanceof Date ? rawDate : new Date(rawDate);
        const snippet = makeSnippet(plainBody);

        // Store the full bodies, capped. An email with inline base64 images can
        // be megabytes, and an `all`-capture mailbox archives every one of them,
        // so an uncapped column would fill a free-tier database quickly.
        const storedText = capBody(text, BODY_LIMITS.text);
        const storedHtml = capBody(html, BODY_LIMITS.html);

        // Shared columns for whichever table this message lands in.
        const common = {
          accountId: account.id,
          // The snapshot is written once and never updated, so renaming,
          // re-pointing, or removing the account cannot rewrite where this
          // message came from.
          accountLabelSnapshot: account.label.slice(0, 500),
          accountEmailSnapshot: account.emailAddress.slice(0, 500),
          messageUid: String(uid),
          messageId: parsed.messageId ?? null,
          fromAddress: fromAddress.slice(0, 500),
          toAddress: String(toAddress).slice(0, 500),
          subject: subject.slice(0, 1000),
          snippet,
          bodyText: storedText.value || null,
          bodyHtml: storedHtml.value || null,
          bodyTruncated: storedText.truncated || storedHtml.truncated,
          receivedAt,
        };

        if (archiveEverything) {
          try {
            await db
              .insert(inboxMessagesTable)
              .values(common)
              // A rescan re-reads messages that are already stored (for example
              // after the UID mark is reset). Rather than skipping them
              // outright, backfill the body columns when they are still null —
              // that is how rows captured before bodies were recorded acquire
              // one. COALESCE means an existing body is never overwritten, so a
              // rescan cannot rewrite history.
              .onConflictDoUpdate({
                target: [
                  inboxMessagesTable.accountId,
                  inboxMessagesTable.messageUid,
                ],
                set: {
                  bodyText: sql`coalesce(${inboxMessagesTable.bodyText}, excluded.body_text)`,
                  bodyHtml: sql`coalesce(${inboxMessagesTable.bodyHtml}, excluded.body_html)`,
                  bodyTruncated: sql`${inboxMessagesTable.bodyTruncated} or excluded.body_truncated`,
                },
              });
            archived++;
          } catch (err) {
            logger.error(
              { err, accountId: account.id, uid },
              "Failed to archive message",
            );
            // Not persisted, so do not advance past it.
            break;
          }

          if (uid > highestUid) highestUid = uid;
          await commitProgress(account.id, highestUid);
          continue;
        }

        const haystack = `${subject}\n${fromAddress}\n${plainBody}`;
        const hits = findKeywordMatches(haystack, keywords);
        if (hits.length === 0) {
          if (uid > highestUid) highestUid = uid;
          continue;
        }

        matched++;

        let insertedId: number | undefined;
        try {
          // Forwarding is deferred, so the row starts as not-yet-forwarded.
          //
          // onConflictDoNothing (not DoUpdate) is deliberate: an absent returned
          // id is exactly the signal that this message was already stored by an
          // earlier scan and must not be forwarded again.
          const inserted = await db
            .insert(matchedMessagesTable)
            .values({
              ...common,
              matchedKeywords: hits,
              forwarded: false,
              forwardError: null,
            })
            .onConflictDoNothing()
            .returning({ id: matchedMessagesTable.id });
          insertedId = inserted[0]?.id;

          if (insertedId === undefined) {
            // Already stored. Backfill the body columns if they are still null,
            // which is how rows captured before bodies were recorded acquire
            // one. COALESCE never overwrites an existing body, and the
            // forwarding columns are untouched so nothing is re-sent.
            await db
              .update(matchedMessagesTable)
              .set({
                bodyText: sql`coalesce(${matchedMessagesTable.bodyText}, ${common.bodyText})`,
                bodyHtml: sql`coalesce(${matchedMessagesTable.bodyHtml}, ${common.bodyHtml})`,
                bodyTruncated: sql`${matchedMessagesTable.bodyTruncated} or ${common.bodyTruncated}`,
              })
              .where(
                and(
                  eq(matchedMessagesTable.accountId, account.id),
                  eq(matchedMessagesTable.messageUid, String(uid)),
                ),
              );
          }
        } catch (err) {
          logger.error(
            { err, accountId: account.id, uid },
            "Failed to insert matched message",
          );
          // The match is not persisted, so do not advance past it.
          break;
        }

        // No id means the row already existed, so it was handled by a previous
        // scan and must not be forwarded again.
        if (forwardingActive && insertedId !== undefined) {
          pending.push({
            rowId: insertedId,
            uid,
            subject,
            fromAddress,
            toAddress: String(toAddress),
            receivedAt,
            text,
            html,
            hits,
          });
        }

        if (uid > highestUid) highestUid = uid;
        // Commit incrementally: a crash mid-loop must not replay messages that
        // were already stored.
        await commitProgress(account.id, highestUid);
      }

      await commitProgress(account.id, highestUid);
    } finally {
      lock.release();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, accountId: account.id }, "Scan failed");
    await db
      .update(emailAccountsTable)
      .set({ lastCheckedAt: new Date(), lastError: msg })
      .where(eq(emailAccountsTable.id, account.id));
    return {
      scanned,
      matched,
      archived,
      forwarded: 0,
      message: `Scan failed: ${msg}`,
    };
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }

  // IMAP is released at this point, so slow SMTP cannot stall the mailbox.
  const forwarded = await forwardPending(account, pending, forwardTo);

  return {
    scanned,
    matched,
    archived,
    forwarded,
    message: archiveEverything
      ? `Scanned ${scanned}, archived ${archived}.`
      : `Scanned ${scanned}, matched ${matched}, forwarded ${forwarded}.`,
  };
}

export async function scanAllActiveAccounts(): Promise<void> {
  const accounts = await db
    .select()
    .from(emailAccountsTable)
    .where(
      and(
        eq(emailAccountsTable.active, true),
        // Soft-deleted accounts keep their history but must never be polled.
        isNull(emailAccountsTable.deletedAt),
      ),
    );

  // Accounts are independent, so scan them in parallel; one unresponsive mailbox
  // must not stall the others. Concurrency is bounded so a large number of
  // accounts cannot exhaust sockets or the database pool.
  await mapWithConcurrency(accounts, SCAN_CONCURRENCY, async (acct) => {
    try {
      const result = await scanAccount(acct);
      logger.info(
        { accountId: acct.id, label: acct.label, ...result },
        "Background scan complete",
      );
    } catch (err) {
      // scanAccount already handles its own failures; this only catches
      // unexpected ones so a single account cannot abort the batch.
      logger.error({ err, accountId: acct.id }, "Background scan errored");
    }
  });
}
