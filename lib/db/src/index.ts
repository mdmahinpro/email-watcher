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
 * Local development runs Postgres on loopback without TLS; every hosted
 * provider (Supabase, Neon, RDS) requires TLS. Detect which case we are in from
 * the host rather than making the developer remember a flag.
 *
 * An explicit `sslmode` in the URL always wins: pg-connection-string parses it
 * and we leave its decision alone.
 */
function resolveSsl(url: string): pg.PoolConfig["ssl"] {
  if (/[?&]sslmode=/i.test(url)) return undefined;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Unparseable URL: let pg surface the real error instead of guessing.
    return undefined;
  }

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

export const pool = new Pool({
  connectionString,
  ssl: resolveSsl(connectionString),
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
  // A hosted database can drop an idle connection at any time; fail fast and
  // reconnect rather than hanging a scan on a dead socket.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

// An idle client that errors (network drop, provider restart) emits on the pool.
// Without a listener Node treats it as an unhandled 'error' event and exits.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
