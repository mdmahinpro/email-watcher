import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Parse the URL up front so a malformed value fails with an explanation rather
 * than a `TypeError: Invalid URL` from deep inside pg.
 *
 * The usual cause is an unencoded password: `@` and `#` are URL delimiters, so a
 * password containing them splits the authority in the wrong place. They must be
 * percent-encoded (`%40`, `%23`).
 */
function parseConnectionString(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid URL. If the password contains any of " +
        "@ # ? / : or a space, percent-encode it (@ becomes %40, # becomes %23). " +
        "Also make sure no placeholder brackets [] remain around it.",
    );
  }
}

const parsed = parseConnectionString(connectionString);

/**
 * Supabase's *direct* connection host resolves to IPv6 only. Many hosts —
 * Render's free tier among them — have no IPv6 egress, so the socket opens
 * nowhere and dies as "Connection terminated unexpectedly" with nothing
 * explaining why. The pooler host is dual-stack, so it is the correct choice on
 * those platforms.
 */
function warnAboutIpv6OnlyHost(host: string): void {
  const isSupabaseDirect = /^db\.[a-z0-9]+\.supabase\.co$/i.test(host);
  if (!isSupabaseDirect) return;

  console.warn(
    `[db] WARNING: "${host}" is Supabase's direct connection host, which is ` +
      "IPv6-only. If your platform has no IPv6 egress (Render free does not), " +
      "connections will time out. Use the Connection Pooling string instead: " +
      "aws-0-<region>.pooler.supabase.com on port 6543.",
  );
}

/**
 * Ports a Postgres server is actually reached on: 5432 is the standard listener
 * and Supabase's session pooler, 6543 its transaction pooler.
 *
 * Anything else is far more likely a paste error than real configuration. An
 * app's own HTTP port ending up here produces a connection timeout with no
 * indication of the cause, so say so loudly at startup.
 */
function warnAboutUnusualPort(host: string, port: number): void {
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local");
  if (isLocal || port === 5432 || port === 6543) return;

  console.warn(
    `[db] WARNING: port ${port} is not a Postgres port. Expected 6543 for ` +
      "Supabase's transaction pooler or 5432 for its session pooler. Check that " +
      "the app's own PORT was not pasted into DATABASE_URL.",
  );
}

warnAboutIpv6OnlyHost(parsed.hostname);
warnAboutUnusualPort(parsed.hostname, Number(parsed.port) || 5432);

/**
 * Local development runs Postgres on loopback without TLS; every hosted
 * provider (Supabase, Neon, RDS) requires TLS. Detect which case we are in from
 * the host rather than making the developer remember a flag.
 *
 * An explicit `sslmode` in the URL always wins: pg-connection-string parses it
 * and we leave its decision alone.
 */
function resolveSsl(url: string): pg.PoolConfig["ssl"] {
  if (/[?&]sslmode=/i.test(url)) return undefined;

  const host = parsed.hostname;

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local");

  if (isLocal) return undefined;

  // Managed Postgres commonly terminates TLS with a certificate chain that is
  // not in Node's trust store (Supabase's pooler among them). Requiring TLS
  // while not verifying the chain is what `sslmode=require` means in libpq, and
  // matches what these providers document. Set `sslmode=verify-full` plus
  // `sslrootcert` in DATABASE_URL to opt into full verification.
  return { rejectUnauthorized: false };
}

/**
 * Supabase's transaction pooler (port 6543) multiplexes clients over a small
 * number of server connections, so a large client-side pool is wasted and can
 * exhaust the project's connection budget. Keep the pool small by default and
 * allow an override for self-hosted Postgres.
 */
const poolMax = Number(process.env.DATABASE_POOL_MAX ?? 10);

/**
 * Connection acquisition timeout.
 *
 * Kept below the health probe's own budget so a dead database surfaces as a
 * reported failure rather than a hung request. Overridable for slow links.
 */
const connectionTimeoutMillis = Number(
  process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000,
);

export const pool = new Pool({
  connectionString,
  ssl: resolveSsl(connectionString),
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
  // A hosted database can drop an idle connection at any time; fail fast and
  // reconnect rather than hanging a scan on a dead socket.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis)
    ? connectionTimeoutMillis
    : 10_000,
});

// Log the resolved target once. Without this, a wrong host or port is invisible
// and every failure looks identical.
console.log(
  `[db] host=${parsed.hostname} port=${parsed.port || "5432"} ` +
    `database=${parsed.pathname.replace(/^\//, "") || "(default)"} ` +
    `ssl=${resolveSsl(connectionString) ? "on" : "off"} poolMax=${poolMax}`,
);

// An idle client that errors (network drop, provider restart) emits on the pool.
// Without a listener Node treats it as an unhandled 'error' event and exits.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
