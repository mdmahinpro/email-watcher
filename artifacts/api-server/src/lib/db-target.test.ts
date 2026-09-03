import { describe, expect, it } from "vitest";
import { classifyDatabaseTarget } from "./db-target";

/**
 * These cover the two misconfigurations that each produced an identical,
 * unexplained connection timeout in deployment: an IPv6-only host on a platform
 * without IPv6 egress, and the app's own HTTP port pasted into DATABASE_URL.
 */

const POOLER =
  "postgresql://user:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres";

describe("classifyDatabaseTarget", () => {
  it("returns null when unconfigured", () => {
    // Empty rather than undefined: undefined falls through to the default
    // parameter, which reads the real DATABASE_URL from the environment.
    expect(classifyDatabaseTarget("")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    // An unencoded `#` in the password starts a URL fragment, which empties the
    // host and makes the whole string invalid. This is the real failure that
    // produced `TypeError: Invalid URL` from inside pg.
    expect(
      classifyDatabaseTarget("postgresql://user:pw#extra@host:6543/postgres"),
    ).toBeNull();
  });

  it("recognises the Supabase transaction pooler with no complaint", () => {
    const t = classifyDatabaseTarget(POOLER);

    expect(t).toEqual({ kind: "supabase-pooler", port: 6543 });
    expect(t?.warning).toBeUndefined();
  });

  it("accepts the session pooler on 5432", () => {
    const t = classifyDatabaseTarget(POOLER.replace(":6543", ":5432"));

    expect(t).toEqual({ kind: "supabase-pooler", port: 5432 });
  });

  it("flags the app's own port pasted into DATABASE_URL", () => {
    // The real incident: :3001 instead of :6543, which times out silently.
    const t = classifyDatabaseTarget(POOLER.replace(":6543", ":3001"));

    expect(t?.kind).toBe("supabase-pooler");
    expect(t?.port).toBe(3001);
    expect(t?.warning).toMatch(/not a Postgres port/i);
    expect(t?.warning).toMatch(/PORT was not pasted/i);
  });

  it("flags Supabase's direct host as IPv6-only", () => {
    const t = classifyDatabaseTarget(
      "postgresql://user:pw@db.abc123xyz.supabase.co:5432/postgres",
    );

    expect(t?.kind).toBe("supabase-direct-ipv6-only");
    expect(t?.warning).toMatch(/IPv6-only/);
    expect(t?.warning).toMatch(/pooler/);
  });

  it("prefers the IPv6 diagnosis over the port one when both apply", () => {
    // The host problem is the blocking one; reporting the port first would
    // send someone down the wrong path.
    const t = classifyDatabaseTarget(
      "postgresql://user:pw@db.abc123xyz.supabase.co:9999/postgres",
    );

    expect(t?.warning).toMatch(/IPv6-only/);
  });

  it("does not complain about a local database on any port", () => {
    // Docker compose maps arbitrary ports in development.
    for (const host of ["localhost", "127.0.0.1", "dev.local"]) {
      const t = classifyDatabaseTarget(
        `postgres://u:p@${host}:55432/emailwatcher`,
      );
      expect(t?.kind).toBe("local");
      expect(t?.warning).toBeUndefined();
    }
  });

  it("defaults a missing port to 5432 rather than flagging it", () => {
    const t = classifyDatabaseTarget("postgres://u:p@db.example.com/mydb");

    expect(t).toEqual({ kind: "other", port: 5432 });
  });

  it("classifies an unrelated managed host as other", () => {
    const t = classifyDatabaseTarget(
      "postgres://u:p@ep-cool-name.us-east-2.aws.neon.tech:5432/neondb",
    );

    expect(t).toEqual({ kind: "other", port: 5432 });
  });

  it("never includes credentials in its output", () => {
    const t = classifyDatabaseTarget(
      "postgresql://postgres.myref:SuperSecret123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    );

    const serialized = JSON.stringify(t);
    expect(serialized).not.toContain("SuperSecret123");
    expect(serialized).not.toContain("myref");
  });
});
