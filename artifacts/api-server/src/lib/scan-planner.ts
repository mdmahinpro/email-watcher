/**
 * Pure scan-planning helpers, kept free of database and network imports so they
 * can be unit-tested directly.
 */

/**
 * A never-scanned account has no UID high-water mark. Fetching the whole mailbox
 * would download and parse every message ever received, so the first scan is
 * limited to the newest `INITIAL_SCAN_LIMIT` messages and the mark is seeded
 * from there.
 */
export const INITIAL_SCAN_LIMIT = 50;

/**
 * Folders a scan reads in addition to INBOX, matched against the last path
 * segment, case-insensitively.
 *
 * Review invitations, reward mails, and "claim your gift" campaigns are exactly
 * the messages a spam filter loves to hide, so leaving the junk folder unscanned
 * is the single biggest way a keyword match gets lost. Matching is on names, not
 * the IMAP special-use flag, because small providers name the folder freely
 * ("Junk", "Spam", "Bulk Mail", "Junk E-mail") and rarely set the flag.
 */
export function isJunkFolder(folderPath: string): boolean {
  const name = folderPath
    .split("/")
    .pop()!
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return /^(junk|spam|bulk)( |$)/.test(name) || name === "junk e-mail";
}

/**
 * Returns the keywords present in `haystack`, matched as case-insensitive
 * substrings. Blank keywords are ignored and each keyword is reported at most
 * once, in its configured spelling.
 */
export function findKeywordMatches(
  haystack: string,
  keywords: string[],
): string[] {
  const lower = haystack.toLowerCase();
  const hits = new Set<string>();
  for (const raw of keywords) {
    const kw = raw.trim();
    if (!kw) continue;
    if (lower.includes(kw.toLowerCase())) {
      hits.add(kw);
    }
  }
  return [...hits];
}

/**
 * Named HTML entities that appear in email HTML, plus the numeric form.
 *
 * A keyword can be split by an entity in the HTML part ("$" arrives as
 * `&#36;`, "Firm &amp; Review"), so the searchable text is decoded before
 * matching. Full entity support is not needed: a spelling an email actually
 * uses is covered, and anything exotic still matches through the plain-text
 * part or the raw HTML when present.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  dollar: "$",
  pound: "£",
  euro: "€",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  trade: "™",
};

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => {
      const known = NAMED_ENTITIES[name.toLowerCase()];
      return known !== undefined ? known : m;
    });
}

/**
 * URL and resource targets embedded in the HTML, one per line.
 *
 * A keyword is often present only inside a link — "capterra.com/review" in an
 * href, a tracking pixel's src — and the visible text never repeats it. Those
 * values are pulled out of the markup so they take part in matching without
 * the surrounding tags or CSS class names, which would only cause false
 * positives.
 */
function extractHtmlLinks(html: string): string {
  const out: string[] = [];
  const attr = /\b(?:href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(attr)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (value) out.push(decodeHtmlEntities(value));
  }
  return out.join("\n");
}

/**
 * The text a keyword match runs over: every place a human-visible or
 * machine-embedded keyword can appear.
 *
 * The old matcher read only the plain-text part (or the HTML with tags ripped
 * out, when there was no text part). That missed real mail: keywords living in
 * a link target, keywords hidden behind an HTML entity, and keywords present
 * only in the HTML part of a message that also carries a shorter text part.
 * This builder feeds the matcher subject, sender, recipient, the plain-text
 * body, the HTML body reduced to text, and the HTML's embedded links — the
 * HTML is always included, not only when the text part is empty, because the
 * two parts routinely disagree.
 */
export function buildKeywordHaystack(parts: {
  subject: string;
  from: string;
  to: string;
  text: string;
  html: string;
}): string {
  const { subject, from, to, text, html } = parts;

  const pieces = [subject, from, to, text];
  if (html) {
    const withoutBlocks = html.replace(
      /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );
    const asText = decodeHtmlEntities(withoutBlocks).replace(/<[^>]*>/g, " ");
    pieces.push(asText, extractHtmlLinks(html));
  }
  return pieces.filter(Boolean).join("\n");
}

/**
 * Render an HTML body as readable plain text, for places that cannot show
 * markup (a Telegram message, a plain-text forward).
 *
 * Block-level tags become newlines, entities are decoded, and the remaining
 * tags are dropped. Unlike the keyword haystack this keeps no link targets:
 * a human reading the text sees the link text, and the message the links come
 * from carries the real web view.
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<(p|div|li|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n");
  const text = decodeHtmlEntities(withoutBlocks).replace(/<[^>]*>/g, " ");
  // Tags became spaces; collapse the runs they left behind, but keep real
  // newlines so paragraphs survive.
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Collapse whitespace and cut to `max` characters for the stored preview. */export function makeSnippet(text: string, max = 320): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned;
}

/**
 * Cut a message body to `max` characters, reporting whether anything was lost.
 *
 * Unlike `makeSnippet` this preserves the body verbatim — no whitespace
 * collapsing and no ellipsis — because the result is rendered as the message, and
 * for HTML any injected characters would land inside markup.
 */
export function capBody(
  body: string,
  max: number,
): { value: string; truncated: boolean } {
  if (body.length <= max) return { value: body, truncated: false };
  return { value: body.slice(0, max), truncated: true };
}

/**
 * Run `worker` over `items`, keeping at most `limit` calls in flight.
 *
 * Items are handed out in order, but completion order is not guaranteed. A
 * rejecting `worker` rejects the whole call, so callers that must not abort the
 * batch should handle errors inside `worker`.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(0, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const item = items[cursor++]!;
        await worker(item);
      }
    },
  );
  await Promise.all(runners);
}

export interface ScanTargets {
  /** Exact UIDs to fetch, ascending. Never empty. */
  uids: number[];
  /**
   * UID high-water mark to start from. Progress is only committed at or above
   * this value, so a failure cannot rewind an account.
   */
  baseline: number;
}

/** The slice of an ImapFlow client that scan planning needs. */
export interface MailboxProbe {
  status(
    path: string,
    query: { messages: true },
  ): Promise<{ messages?: number | undefined }>;
  search(
    query: { seq: string } | { uid: string },
    options: { uid: true },
  ): Promise<number[] | false | undefined>;
}

/**
 * Resolve exactly which UIDs to fetch, or null when there is nothing new.
 *
 * Planning is done with a UID SEARCH rather than a `N:*` FETCH because IMAP
 * defines an open-ended range as matching the highest existing UID when its
 * lower bound is past the end of the mailbox (RFC 3501 §6.4.8). Fetching
 * `lastUidSeen + 1:*` directly therefore re-downloads and re-parses the newest
 * message on every poll of an idle mailbox. Searching first and filtering to
 * strictly-newer UIDs makes an idle poll cost one cheap SEARCH.
 *
 * For a first scan the window is anchored to the newest `limit` messages, and
 * everything older is treated as already seen.
 */
export async function resolveScanTargets(
  client: MailboxProbe,
  lastUidSeen: number | null,
  limit: number = INITIAL_SCAN_LIMIT,
  mailboxPath: string = "INBOX",
): Promise<ScanTargets | null> {
  if (lastUidSeen !== null) {
    const found = await client.search(
      { uid: `${lastUidSeen + 1}:*` },
      { uid: true },
    );
    if (!found || found.length === 0) return null;

    const uids = found.filter((uid) => uid > lastUidSeen).sort((a, b) => a - b);
    if (uids.length === 0) return null;

    return { uids, baseline: lastUidSeen };
  }

  const status = await client.status(mailboxPath, { messages: true });
  const total = status.messages ?? 0;
  if (total === 0) return null;

  // Sequence numbers are contiguous, so the newest N messages are the last N
  // sequence numbers. Map them to UIDs to build the first-scan window.
  const firstSeq = Math.max(1, total - limit + 1);
  const found = await client.search({ seq: `${firstSeq}:${total}` }, { uid: true });
  if (!found || found.length === 0) return null;

  const uids = [...found].sort((a, b) => a - b);
  return { uids, baseline: uids[0]! - 1 };
}
