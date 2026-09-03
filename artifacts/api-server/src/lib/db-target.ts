/**
 * Classify the configured database host.
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

export interface DatabaseTarget {
  kind: DatabaseHostKind;
  port: number;
  /** Set when the host is known to be unreachable from IPv4-only platforms. */
  warning?: string;
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

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local")
  ) {
    return { kind: "local", port };
  }

  if (/\.pooler\.supabase\.com$/.test(host)) {
    return { kind: "supabase-pooler", port };
  }

  // Supabase's direct connection host resolves to IPv6 only. Platforms without
  // IPv6 egress — Render free among them — cannot reach it at all, and the
  // failure looks identical to a paused database.
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    return {
      kind: "supabase-direct-ipv6-only",
      port,
      warning:
        "This is Supabase's direct host, which is IPv6-only. Use the Connection " +
        "Pooling string instead: aws-0-<region>.pooler.supabase.com port 6543.",
    };
  }

  return { kind: "other", port };
}
