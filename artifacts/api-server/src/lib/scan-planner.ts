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

/** Collapse whitespace and cut to `max` characters for the stored preview. */
export function makeSnippet(text: string, max = 320): string {
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

  const status = await client.status("INBOX", { messages: true });
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
