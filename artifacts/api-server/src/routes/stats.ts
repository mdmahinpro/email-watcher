import { Router, type IRouter } from "express";
import { sql, eq, isNull, desc } from "drizzle-orm";
import {
  db,
  emailAccountsTable,
  matchedMessagesTable,
  inboxMessagesTable,
} from "@workspace/db";
import { databaseSizeBytes } from "../lib/retention";
import { currentBeat } from "../lib/heartbeat";

const router: IRouter = Router();

/** Soft-deleted accounts keep their message history but leave the active roster. */
const notDeleted = isNull(emailAccountsTable.deletedAt);

router.get("/stats/summary", async (_req, res) => {
  const accounts = await db
    .select({ active: emailAccountsTable.active })
    .from(emailAccountsTable)
    .where(notDeleted);
  const totalAccounts = accounts.length;
  const activeAccounts = accounts.filter((a) => a.active).length;

  // Message counts intentionally span deleted accounts: the history is retained,
  // so the totals must keep reflecting it.
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      last24h: sql<number>`count(*) filter (where ${matchedMessagesTable.receivedAt} > now() - interval '1 day')::int`,
      last7d: sql<number>`count(*) filter (where ${matchedMessagesTable.receivedAt} > now() - interval '7 days')::int`,
      forwarded: sql<number>`count(*) filter (where ${matchedMessagesTable.forwarded})::int`,
    })
    .from(matchedMessagesTable);

  // Archived mail is counted separately from keyword matches: mixing an
  // unfiltered archive into the match totals would make every "matches" figure
  // meaningless.
  const [archived] = await db
    .select({
      total: sql<number>`count(*)::int`,
      last24h: sql<number>`count(*) filter (where ${inboxMessagesTable.receivedAt} > now() - interval '1 day')::int`,
    })
    .from(inboxMessagesTable);

  // Both are informational and independently degradable, so a failure in either
  // must not fail the whole dashboard.
  const [databaseBytes, heartbeatDay] = await Promise.all([
    databaseSizeBytes(),
    currentBeat().catch(() => null),
  ]);

  res.json({
    totalAccounts,
    activeAccounts,
    totalMatches: counts?.total ?? 0,
    matchesLast24h: counts?.last24h ?? 0,
    matchesLast7d: counts?.last7d ?? 0,
    forwardedCount: counts?.forwarded ?? 0,
    archivedTotal: archived?.total ?? 0,
    archivedLast24h: archived?.last24h ?? 0,
    databaseBytes,
    heartbeatDay,
  });
});

router.get("/stats/keyword-breakdown", async (_req, res) => {
  // Unnest the jsonb array of keywords and count occurrences.
  const rows = await db.execute(sql`
    SELECT keyword, COUNT(*)::int AS count
    FROM matched_messages,
         LATERAL jsonb_array_elements_text(matched_keywords) AS keyword
    GROUP BY keyword
    ORDER BY count DESC
    LIMIT 50
  `);
  res.json(
    (rows.rows as Array<{ keyword: string; count: number }>).map((r) => ({
      keyword: r.keyword,
      count: Number(r.count),
    })),
  );
});

/**
 * Drizzle's node-postgres driver disables pg's timestamp parsers and hands
 * timestamps back as raw strings, so a `max(timestamp)` aggregate arrives as a
 * string rather than a Date. Normalize both shapes to an ISO string.
 */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  // Postgres renders `timestamp without time zone` without a zone offset; it is
  // stored in UTC, so mark it as such before parsing.
  const normalized = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

router.get("/stats/account-activity", async (_req, res) => {
  const rows = await db
    .select({
      accountId: emailAccountsTable.id,
      label: emailAccountsTable.label,
      emailAddress: emailAccountsTable.emailAddress,
      matchCount: sql<number>`count(${matchedMessagesTable.id})::int`,
      lastMatchAt: sql<
        Date | string | null
      >`max(${matchedMessagesTable.receivedAt})`,
    })
    .from(emailAccountsTable)
    .leftJoin(
      matchedMessagesTable,
      eq(matchedMessagesTable.accountId, emailAccountsTable.id),
    )
    .where(notDeleted)
    .groupBy(
      emailAccountsTable.id,
      emailAccountsTable.label,
      emailAccountsTable.emailAddress,
    )
    .orderBy(desc(sql`count(${matchedMessagesTable.id})`));

  res.json(
    rows.map((r) => ({
      accountId: r.accountId,
      label: r.label,
      emailAddress: r.emailAddress,
      matchCount: Number(r.matchCount ?? 0),
      lastMatchAt: toIsoOrNull(r.lastMatchAt),
    })),
  );
});

export default router;
