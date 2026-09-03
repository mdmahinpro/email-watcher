/**
 * Classify the configured database host and port.
 *
 * Exposed through /api/healthz so a deployment can be diagnosed without shell or
 * dashboard access. Deliberately a *category*, never the raw host: the Supabase
 * direct hostname embeds the project ref, and credentials must never appear in a
 * public response.
 */

export type DatabaseHostKind =
  | "local"
  | "supabase-pooler"
  | "supabase-direct-ipv6-only"
  | "other";

/**
 * Ports a Postgres server is actually reached on.
 *
 * 5432 is the standard listener and Supabase's session pooler; 6543 is Supabase's
 * transaction pooler. Anything else in a `DATABASE_URL` is far more likely to be a
 * paste error than a real configuration — an app's own HTTP port ending up here is
 * exactly the kind of mix-up that produces a silent connection timeout.
 */
const KNOWN_POSTGRES_PORTS = new Set([5432, 6543]);

export interface DatabaseTarget {
  kind: DatabaseHostKind;
  port: number;
  /** Set when the target is known or likely to be unreachable. */
  warning?: string;
}

/**
 * Reasons a target looks wrong, most specific first.
 *
 * Returns undefined when nothing is suspect.
 */
function diagnose(kind: DatabaseHostKind, port: number): string | undefined {
  // Supabase's direct connection host resolves to IPv6 only. Platforms without
  // IPv6 egress — Render free among them — cannot reach it at all, and the
  // failure looks identical to a paused database.
  if (kind === "supabase-direct-ipv6-only") {
    return (
      "This is Supabase's direct host, which is IPv6-only. Use the Connection " +
      "Pooling string instead: aws-0-<region>.pooler.supabase.com port 6543."
    );
  }

  if (kind !== "local" && !KNOWN_POSTGRES_PORTS.has(port)) {
    return (
      `Port ${port} is not a Postgres port. Expected 6543 for Supabase's ` +
      "transaction pooler or 5432 for its session pooler. Check that the app's " +
      "own PORT was not pasted into DATABASE_URL."
    );
  }

  return undefined;
}

export function classifyDatabaseTarget(
  connectionString: string | undefined = process.env["DATABASE_URL"],
): DatabaseTarget | null {
  if (!connectionString) return null;

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const port = Number(url.port) || 5432;

  const kind: DatabaseHostKind =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local")
      ? "local"
      : /\.pooler\.supabase\.com$/.test(host)
        ? "supabase-pooler"
        : /^db\.[a-z0-9]+\.supabase\.co$/.test(host)
          ? "supabase-direct-ipv6-only"
          : "other";

  const warning = diagnose(kind, port);

  return { kind, port, ...(warning ? { warning } : {}) };
}
