/**
 * Telegram alerts for critical keyword matches.
 *
 * Regular matches are only listed in the app; the point of a critical keyword
 * is that it is worth interrupting the operator for, so a hit pushes a
 * Telegram message carrying the whole email — subject, addresses, and the
 * full body, split across as many messages as Telegram's 4096-character limit
 * takes — plus an inline button to the exact web view of that message.
 *
 * Failures never fail the scan: a Telegram outage must not stop mail from
 * being captured, and the next match will try again.
 */
import { htmlToText } from "./scan-planner";
import { logger } from "./logger";

/** Telegram's hard per-message ceiling, characters. */
const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Request budget for one Telegram API call. */
const TELEGRAM_TIMEOUT_MS = 10_000;

/** Leave this much of the 4096 for the header block on the first message. */
const HEADER_BUDGET = 700;

export interface TelegramConfig {
  telegramEnabled: boolean;
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

/** True when a push should actually be attempted. */
export function telegramActive(config: TelegramConfig): boolean {
  return (
    config.telegramEnabled &&
    Boolean(config.telegramBotToken?.trim()) &&
    Boolean(config.telegramChatId?.trim())
  );
}

/**
 * Escape text for Telegram's HTML parse mode.
 *
 * Telegram accepts a small allow-list of tags (b, i, code, a, ...); every
 * untrusted string is escaped before being placed between them, so an email
 * can never inject markup into the alert.
 */
export function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Split a body into Telegram-sized chunks.
 *
 * Splits on the last whitespace before the limit, so words and URLs stay
 * intact; a single unbreakable token longer than the limit is hard-cut.
 */
export function chunkForTelegram(
  text: string,
  limit: number,
): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = window.lastIndexOf(" ") !== -1 ? window.lastIndexOf(" ") : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** The message a scan sends for one critical match. */
export interface CriticalNotice {
  subject: string;
  fromAddress: string;
  toAddress: string;
  accountLabel: string;
  accountEmail: string;
  folder: string;
  receivedAt: Date;
  criticalHits: string[];
  bodyText: string;
  bodyHtml: string;
}

/**
 * Build the first Telegram message (header + first body chunk) and the
 * remaining body chunks. Returned as HTML ready for parse_mode: HTML.
 */
export function buildCriticalMessages(
  notice: CriticalNotice,
  viewUrl: string | null,
): { first: string; rest: string[] } {
  const date = notice.receivedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const folder =
    notice.folder && notice.folder !== "INBOX" ? ` (${notice.folder})` : "";

  const header =
    `🚨 <b>Critical match</b> — Email Watcher\n\n` +
    `<b>Subject:</b> ${escapeTelegramHtml(notice.subject)}\n` +
    `<b>From:</b> ${escapeTelegramHtml(notice.fromAddress)}\n` +
    `<b>To:</b> ${escapeTelegramHtml(notice.toAddress)}\n` +
    `<b>Mailbox:</b> ${escapeTelegramHtml(notice.accountLabel + folder)}\n` +
    `<b>Keywords:</b> ${notice.criticalHits
      .map((k) => `<code>${escapeTelegramHtml(k)}</code>`)
      .join(", ")}\n` +
    `<b>Received:</b> ${escapeTelegramHtml(date)}\n` +
    `\u2500`.repeat(12) +
    `\n`;

  const body =
    notice.bodyText && notice.bodyText.trim().length > 0
      ? notice.bodyText
      : notice.bodyHtml
        ? htmlToText(notice.bodyHtml)
        : notice.bodyText || "(no body was captured)";
  const bodyText = escapeTelegramHtml(body.trim());

  // Reserve a fixed allowance for the "(N more messages)" note so the first
  // message stays under the limit with it appended. Bodies are capped at
  // 128 KB by the scanner, so at most ~35 follow-up chunks exist and the note
  // never outgrows this reserve.
  const firstBudget = TELEGRAM_MESSAGE_LIMIT - header.length - 1;
  const NOTE_RESERVE = 24;
  const chunks = chunkForTelegram(bodyText, firstBudget - NOTE_RESERVE);

  const first = header + (chunks[0] ?? "");
  // Mention the follow-ups so a long mail does not look cut off.
  const restCount = chunks.length - 1;
  const firstWithNote =
    restCount > 0
      ? first + `\n\n(${restCount} more message${restCount === 1 ? "" : "s"})`
      : first;

  return { first: firstWithNote, rest: chunks.slice(1) };
}

async function callTelegram(
  config: TelegramConfig,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const token = config.telegramBotToken!.trim();
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;

    if (!res.ok || !payload?.ok) {
      return {
        ok: false,
        error: payload?.description ?? `Telegram answered ${res.status}`,
      };
    }
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sendMessage(
  config: TelegramConfig,
  html: string,
  viewUrl: string | null,
): Promise<{ ok: boolean; error?: string }> {
  return callTelegram(config, {
    chat_id: config.telegramChatId!.trim(),
    text: html,
    parse_mode: "HTML",
    // The web-view URL sits behind a session gate; a link preview would only
    // show the login screen, so keep the message clean.
    disable_web_page_preview: true,
    ...(viewUrl
      ? {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Open in Email Watcher",
                  url: viewUrl,
                },
              ],
            ],
          },
        }
      : {}),
  });
}

/**
 * Push one critical match. The whole email goes out, chunk by chunk; the
 * first message carries the "open web view" button.
 */
export async function sendCriticalNotice(
  config: TelegramConfig,
  notice: CriticalNotice,
  viewUrl: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { first, rest } = buildCriticalMessages(notice, viewUrl);

  const result = await sendMessage(config, first, viewUrl);
  if (!result.ok) return result;

  for (const chunk of rest) {
    const followUp = await sendMessage(config, chunk, null);
    if (!followUp.ok) return followUp;
  }
  return { ok: true };
}

/** A setup-verification message, sent from the Settings page. */
export async function sendTelegramTestMessage(
  config: TelegramConfig,
): Promise<{ ok: boolean; message: string }> {
  if (!telegramActive(config)) {
    return {
      ok: false,
      message:
        "Telegram is not fully configured: enable it and fill in the bot " +
        "token and chat id first.",
    };
  }

  const result = await sendMessage(
    config,
    "✅ <b>Email Watcher</b>\n\nThis is a test message. Critical keyword " +
      "matches will arrive like this, with the whole email and a button to " +
      "its exact web view.",
    null,
  );

  if (!result.ok) {
    logger.warn({ err: result.error }, "Telegram test message failed");
    return {
      ok: false,
      message: result.error ?? "Telegram rejected the message",
    };
  }
  return { ok: true, message: "Test message delivered." };
}
