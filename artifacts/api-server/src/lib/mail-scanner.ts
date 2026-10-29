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
  sendCriticalNotice,
  telegramActive,
  type CriticalNotice,
  type TelegramConfig,
} from "./telegram";
import { createViewToken } from "./auth";
import { authState } from "../routes/auth";
import {
  buildKeywordHaystack,
  capBody,
  findKeywordMatches,
  INITIAL_SCAN_LIMIT,
  isJunkFolder,
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

/**
 * TLS options for a legacy shared-hosting mail server.
 *
 * Two concessions, deliberately behind one flag:
 *
 * - `rejectUnauthorized: false` accepts a certificate that does not match the
 *   hostname, which is what shared cPanel hosting serves (one certificate for the
 *   provider's own name across every customer domain). Also covers an expired
 *   certificate.
 * - `minVersion: "TLSv1"` allows TLS 1.0/1.1. Node 24 requires 1.2 by default and
 *   fails with `ssl_choose_client_version: unsupported protocol`, which is not a
 *   certificate problem at all but occurs on exactly the same class of neglected
 *   server.
 *
 * They are combined because an operator cannot act on the distinction: both mean
 * "this is an old shared host", and a second toggle would only add a decision
 * with no separate remedy.
 */
const RELAXED_TLS = {
  rejectUnauthorized: false,
  minVersion: "TLSv1" as const,
};

function createImapClient(account: EmailAccount): ImapFlow {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.username, pass: account.password },
    logger: false,
    ...IMAP_TIMEOUTS,
    // Opting out of strict TLS is per-account and deliberate; see RELAXED_TLS.
    ...(account.allowInvalidCert ? { tls: RELAXED_TLS } : {}),
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

/**
 * Node's TLS errors for a certificate that does not match the hostname.
 *
 * A bare "ERR_TLS_CERT_ALTNAME_INVALID" tells an operator nothing about what to
 * do, and the mailbox is usually fine — it is the certificate that is wrong. So
 * these are rewritten into the actual remedy.
 */
const CERT_ERROR_CODES = [
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_UNSUPPORTED",
];

/**
 * Turn a raw connection failure into something that names the fix.
 *
 * Each branch maps to a genuinely different remedy. Lumping them together — or
 * suggesting the TLS toggle for a DNS failure — sends an operator down the wrong
 * path, which is worse than showing the raw error.
 */
export function describeConnectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";

  // The host does not exist. No client setting can help; the hostname is wrong.
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(message)) {
    return (
      `${message} — that hostname does not exist in DNS. This domain does not ` +
      "use mail.<domain>. Use the Auto-fix server button on the account card " +
      "to look up the real mail server from the domain's MX record, or set it " +
      "by hand."
    );
  }

  // The host resolved but nothing answered on that port: wrong host, wrong
  // port, or a provider that blocks IMAP from outside its own network.
  if (code === "ECONNREFUSED" || /econnrefused/i.test(message)) {
    return (
      `${message} — the server refused the connection on this port. The mail ` +
      "server may be on a different hostname or port than configured. Use the " +
      "Auto-fix server button on the account card to probe the domain's real " +
      "IMAP and SMTP endpoints, or check the port (993 SSL, 143 STARTTLS)."
    );
  }

  // Node refuses TLS 1.0/1.1 by default. Not a certificate problem, but the same
  // relaxed-TLS switch enables it.
  if (
    /unsupported protocol|ssl_choose_client_version|wrong version number|no protocols available/i.test(
      message,
    )
  ) {
    return (
      `${message} — this server only speaks an old TLS version that is ` +
      'disabled by default. Enable "Accept mismatched TLS certificate" on this ' +
      "account, which also permits legacy TLS."
    );
  }

  // The handshake was cut. Commonly a shared host that rate-limits repeated
  // failed logins, or one whose implicit-TLS port is broken while STARTTLS on 143
  // works. Verified on a real host: 993 reset every attempt, 143 authenticated.
  if (code === "ECONNRESET" || /socket hang up|econnreset/i.test(message)) {
    return (
      `${message} — the server closed the connection during the handshake. Try ` +
      "port 143 with SSL/TLS turned off (STARTTLS), which some shared hosts " +
      "accept when port 993 does not. Repeated failed logins can also trigger a " +
      "temporary block, so wait a few minutes before retrying."
    );
  }

  if (code === "ETIMEDOUT" || /timeout|required time/i.test(message)) {
    return (
      `${message} — the server did not answer in time. Check the host and ` +
      "port. Use the Auto-fix server button on the account card to probe for " +
      "the domain's real mail server, and consider that the provider may " +
      "block IMAP from outside its own network."
    );
  }

  if (
    CERT_ERROR_CODES.includes(code) ||
    /altname|self.signed|certificate/i.test(message)
  ) {
    const expired = /expired/i.test(message);
    return (
      `${message} — the server's TLS certificate is ` +
      (expired ? "expired" : "issued for a different hostname") +
      ". This is normal on shared cPanel hosting. Enable \"Accept mismatched " +
      'TLS certificate" on this account.'
    );
  }

  if (
    code === "AUTHENTICATIONFAILED" ||
    /authentication failed|invalid credentials|login failed/i.test(message)
  ) {
    return (
      `${message} — the server rejected these credentials. Check the password, ` +
      "and note that some providers require the full email address as the " +
      "username, or a separate app password for IMAP."
    );
  }

  return message;
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
    // The Test button is where a certificate mismatch is most likely to be met,
    // so this is the highest-value place to name the remedy.
    return { ok: false, message: describeConnectionError(err) };
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
  /** Critical matches successfully pushed to Telegram this scan. */
  notified: number;
  message: string;
}

/**
 * The slice of an ImapFlow client the folder listing needs.
 */
interface MailboxLister {
  list(): Promise<
    Array<{ path: string; specialUse?: string | undefined }> | undefined
  >;
}

/**
 * Folders one scan reads: INBOX plus every junk/spam folder the server offers.
 *
 * The mail this app exists to catch — review invitations, rewards, "claim your
 * gift" — is exactly the mail spam filters move out of the inbox, so not
 * reading the junk folder is the biggest way a keyword match gets lost. A
 * folder is recognized by its name (small providers use "Junk", "Spam",
 * "Bulk Mail", ...) or by the IMAP special-use flag when the server sets one.
 * Folders that do not exist are simply absent from the listing, and a server
 * whose LIST fails falls back to INBOX only.
 */
export async function foldersToScan(client: MailboxLister): Promise<string[]> {
  let mailboxes: Array<{ path: string; specialUse?: string | undefined }> = [];
  try {
    mailboxes = (await client.list()) ?? [];
  } catch (err) {
    logger.warn({ err }, "Could not list mailboxes; scanning INBOX only");
    return ["INBOX"];
  }

  const folders = ["INBOX"];
  for (const mb of mailboxes) {
    if (mb.path === "INBOX") continue;
    if (isJunkFolder(mb.path) || mb.specialUse === "\\Junk") {
      folders.push(mb.path);
    }
  }
  return folders;
}

/** Advance the stored high-water mark and clear any previous failure. */
async function commitProgress(
  accountId: number,
  folder: string,
  lastUidSeen: number,
): Promise<void> {
  await db
    .update(emailAccountsTable)
    .set({
      // Merge the one folder's mark into the map without clobbering the
      // others: concurrent progress commits touch different folders of the
      // same account.
      folderMarks: sql`coalesce(${emailAccountsTable.folderMarks}, '{}'::jsonb) || ${JSON.stringify({ [folder]: lastUidSeen })}::jsonb`,
      // lastUidSeen stays the INBOX mark for backward compatibility: the
      // account card predates per-folder marks and pre-existing deployments
      // have no folder_marks value at all.
      ...(folder === "INBOX" ? { lastUidSeen } : {}),
      lastCheckedAt: new Date(),
      lastError: null,
    })
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
    // Same legacy-host situation as IMAP; see RELAXED_TLS.
    ...(account.allowInvalidCert ? { tls: RELAXED_TLS } : {}),
  });

  let forwarded = 0;
  try {
    for (const item of pending) {
      let forwardError: string | null = null;
      try {
        await transporter.sendMail(buildForwardBody(account, item, forwardTo));
        forwarded++;
      } catch (err: unknown) {
        forwardError = describeConnectionError(err);
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

/**
 * A stored match that still needs a Telegram push. Sent after the IMAP
 * connection is released, so a slow Telegram API cannot hold the mailbox open.
 */
interface PendingNotice extends CriticalNotice {
  rowId: number;
}

/**
 * Push every critical match, and report how many went through.
 *
 * Failures are logged per message and never abort the batch — the match is
 * already stored and listed, so a Telegram outage costs the push, not the mail.
 * The "open in Email Watcher" link is a signed, expiring token for exactly
 * this message, so the reader needs no session.
 */
async function sendPendingNotices(
  config: TelegramConfig,
  pending: PendingNotice[],
  appUrl: string | null,
): Promise<number> {
  if (pending.length === 0) return 0;

  const base = (
    appUrl?.trim() ||
    process.env["RENDER_EXTERNAL_URL"]?.trim() ||
    ""
  ).replace(/\/+$/, "");

  let notified = 0;
  for (const notice of pending) {
    const viewUrl =
      base && authState.enabled
        ? `${base}/view/${createViewToken(
            authState.config.sessionSecret,
            authState.config.passwordHash,
            "matched",
            notice.rowId,
          )}`
        : null;

    const result = await sendCriticalNotice(config, notice, viewUrl);
    if (result.ok) {
      notified++;
    } else {
      logger.error(
        { err: result.error, messageId: notice.rowId },
        "Failed to send Telegram critical notice",
      );
    }
  }
  return notified;
}

async function runScan(account: EmailAccount): Promise<ScanOutcome> {
  const settings = await getSettings();
  const keywords = settings.keywords ?? [];
  const criticalKeywords = settings.criticalKeywords ?? [];
  const telegramConfig: TelegramConfig = {
    telegramEnabled: settings.telegramEnabled,
    telegramBotToken: settings.telegramBotToken,
    telegramChatId: settings.telegramChatId,
  };
  const telegramPush = telegramActive(telegramConfig);
  const forwardTo = settings.forwardToEmail?.trim() ?? "";

  // An `all` mailbox archives everything and forwards nothing: relaying every
  // arriving message would be a mail loop waiting to happen, and the point of
  // that mode is a complete record rather than an attention queue.
  const archiveEverything = account.captureMode === "all";
  const forwardingActive =
    !archiveEverything && settings.forwardingEnabled && forwardTo.length > 0;

  // Keywords run in every capture mode — critical ones are additionally
  // pushed to Telegram when it is configured.
  const runKeywords = keywords.length > 0 || criticalKeywords.length > 0;

  const client = createImapClient(account);

  let scanned = 0;
  let matched = 0;
  let archived = 0;
  const pending: PendingForward[] = [];
  const pendingNotices: PendingNotice[] = [];

  // Seed the per-folder marks. A deployment predating per-folder marks has
  // only lastUidSeen, which has always been the INBOX mark.
  const marks: Record<string, number> = { ...(account.folderMarks ?? {}) };
  if (account.lastUidSeen !== null && marks["INBOX"] === undefined) {
    marks["INBOX"] = account.lastUidSeen;
  }

  try {
    await client.connect();
    const folders = await foldersToScan(client);

    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder);
      try {
        const mark = marks[folder] ?? null;
        const target = await resolveScanTargets(
          client,
          mark,
          INITIAL_SCAN_LIMIT,
          folder,
        );
        if (!target) {
          // Nothing new in this folder; still stamp the check time and clear
          // any previous failure, exactly like the original single-folder scan.
          await commitProgress(account.id, folder, mark ?? 0);
          continue;
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
              { accountId: account.id, uid, folder },
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

          // UIDs are only unique within one folder, so a message read outside
          // INBOX carries the folder in its key. INBOX keys stay bare so rows
          // written before folders existed keep deduplicating.
          const messageUid =
            folder === "INBOX" ? String(uid) : `${folder}:${uid}`;

          // Shared columns for whichever table this message lands in.
          const common = {
            accountId: account.id,
            // The snapshot is written once and never updated, so renaming,
            // re-pointing, or removing the account cannot rewrite where this
            // message came from.
            accountLabelSnapshot: account.label.slice(0, 500),
            accountEmailSnapshot: account.emailAddress.slice(0, 500),
            messageUid,
            folder,
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

          const haystack = runKeywords
            ? buildKeywordHaystack({
                subject,
                from: fromAddress,
                to: String(toAddress),
                text,
                html,
              })
            : "";
          const regularHits =
            keywords.length > 0
              ? findKeywordMatches(haystack, keywords)
              : [];
          const criticalHits =
            criticalKeywords.length > 0
              ? findKeywordMatches(haystack, criticalKeywords)
              : [];
          // A critical keyword is also a keyword: its match is listed like any
          // other, deduplicated in its configured spelling.
          const hits = [...regularHits];
          for (const hit of criticalHits) {
            if (!hits.includes(hit)) hits.push(hit);
          }

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
                { err, accountId: account.id, uid, folder },
                "Failed to archive message",
              );
              // Not persisted, so do not advance past it.
              break;
            }
          }

          if (hits.length > 0) {
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
                      eq(matchedMessagesTable.messageUid, messageUid),
                    ),
                  );
              }
            } catch (err) {
              logger.error(
                { err, accountId: account.id, uid, folder },
                "Failed to insert matched message",
              );
              // The match is not persisted, so do not advance past it.
              break;
            }

            // No id means the row already existed, so it was handled by a previous
            // scan and must not be forwarded again. An `all` mailbox never
            // forwards: relaying every arriving email invites a mail loop.
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

            // Same rule for the Telegram push: only a newly stored row
            // notifies, so a rescan cannot spam the same match twice.
            if (
              telegramPush &&
              criticalHits.length > 0 &&
              insertedId !== undefined
            ) {
              pendingNotices.push({
                rowId: insertedId,
                subject,
                fromAddress,
                toAddress: String(toAddress),
                accountLabel: account.label,
                accountEmail: account.emailAddress,
                folder,
                receivedAt,
                criticalHits,
                bodyText: text,
                bodyHtml: html,
              });
            }
          }

          if (uid > highestUid) highestUid = uid;
          // Commit incrementally: a crash mid-loop must not replay messages that
          // were already stored.
          await commitProgress(account.id, folder, highestUid);
        }

        await commitProgress(account.id, folder, highestUid);
      } finally {
        lock.release();
      }
    }
  } catch (err: unknown) {
    // Stored on the account and shown on its card, so it must name the remedy
    // rather than leave a bare TLS error code.
    const msg = describeConnectionError(err);
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
      notified: 0,
      message: `Scan failed: ${msg}`,
    };
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }

  if (scanned === 0) {
    return {
      scanned: 0,
      matched: 0,
      archived: 0,
      forwarded: 0,
      notified: 0,
      message: "No new messages.",
    };
  }

  // IMAP is released at this point, so slow SMTP cannot stall the mailbox.
  const forwarded = await forwardPending(account, pending, forwardTo);
  const notified = telegramPush
    ? await sendPendingNotices(
        telegramConfig,
        pendingNotices,
        settings.appUrl,
      )
    : 0;

  const notifiedSuffix =
    notified > 0 ? ` Notified ${notified} via Telegram.` : "";
  return {
    scanned,
    matched,
    archived,
    forwarded,
    notified,
    message: archiveEverything
      ? `Scanned ${scanned}, archived ${archived}.${notifiedSuffix}`
      : `Scanned ${scanned}, matched ${matched}, forwarded ${forwarded}.${notifiedSuffix}`,
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
