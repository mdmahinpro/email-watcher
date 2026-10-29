import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authedRequest } from "../test-support/authed";
import { resetProbeCache } from "../lib/db-health";

/**
 * Chainable stand-in for the Drizzle query builder.
 *
 * Every builder method (`select`, `from`, `where`, `set`, `returning`, ...) is
 * recorded and returns the same chain, and awaiting the chain resolves the next
 * value queued via `enqueue`. This keeps the route tests focused on request and
 * response behaviour without needing a live database.
 */
const dbMock = vi.hoisted(() => {
  interface Call {
    op: string;
    args: unknown[];
  }

  const calls: Call[] = [];
  const queue: unknown[] = [];
  /** Errors to throw from the next `insert(...)` chains, in order. */
  const insertErrors: Array<Error | null> = [];

  const makeChain = (rejectWith?: Error): Record<string, unknown> => {
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === "symbol") return undefined;
          if (prop === "then") {
            return (
              onFulfilled?: (value: unknown) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) => {
              if (rejectWith) {
                return Promise.reject(rejectWith).then(onFulfilled, onRejected);
              }
              const next = queue.length > 0 ? queue.shift() : [];
              return Promise.resolve(next).then(onFulfilled, onRejected);
            };
          }
          return (...args: unknown[]) => {
            calls.push({ op: prop, args });
            return chain;
          };
        },
      },
    ) as Record<string, unknown>;
    return chain;
  };

  const db = {
    select: (...args: unknown[]) => {
      calls.push({ op: "select", args });
      return makeChain();
    },
    insert: (...args: unknown[]) => {
      calls.push({ op: "insert", args });
      const err = insertErrors.length > 0 ? insertErrors.shift() : null;
      return makeChain(err ?? undefined);
    },
    update: (...args: unknown[]) => {
      calls.push({ op: "update", args });
      return makeChain();
    },
    delete: (...args: unknown[]) => {
      calls.push({ op: "delete", args });
      return makeChain();
    },
    execute: (...args: unknown[]) => {
      calls.push({ op: "execute", args });
      const next = queue.length > 0 ? queue.shift() : { rows: [] };
      return Promise.resolve(next);
    },
  };

  return {
    db,
    calls,
    queue,
    enqueue(...results: unknown[]) {
      queue.push(...results);
    },
    /** Queue per-insert failures; `null` means "this insert succeeds". */
    failInserts(...errors: Array<Error | null>) {
      insertErrors.push(...errors);
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
      insertErrors.length = 0;
    },
    /** Arguments of the single recorded call to `op`. */
    argsOf(op: string): unknown[] {
      const matches = calls.filter((c) => c.op === op);
      if (matches.length !== 1) {
        throw new Error(
          `Expected exactly one "${op}" call, saw ${matches.length}`,
        );
      }
      return matches[0]!.args;
    },
    /** Arguments of every recorded call to `op`, in order. */
    allArgsOf(op: string): unknown[][] {
      return calls.filter((c) => c.op === op).map((c) => c.args);
    },
    countOf(op: string): number {
      return calls.filter((c) => c.op === op).length;
    },
  };
});

// Real table definitions (so drizzle's `eq` receives genuine columns) combined
// with the fake query builder. `@workspace/db/schema` has no DATABASE_URL
// requirement, unlike the package root.
vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return {
    ...schema,
    db: dbMock.db,
    pool: { end: async () => undefined },
  };
});

// The scheduler is only reachable from PUT /settings, and re-arming it would
// start real timers.
vi.mock("../lib/scheduler", () => ({
  startScheduler: vi.fn(async () => undefined),
  stopScheduler: vi.fn(async () => undefined),
  restartScheduler: vi.fn(async () => undefined),
}));

// Host discovery opens real sockets; tests must not depend on the network.
// The default "nothing found" keeps every derivation test on its fallback path.
const discoveryMock = vi.hoisted(() => {
  type Server = { host: string; port: number; secure: boolean } | null;
  return {
    discoverImapServer: vi.fn(async (): Promise<Server> => null),
    discoverSmtpServer: vi.fn(async (): Promise<Server> => null),
    discoverMailServers: vi.fn(
      async (): Promise<{ imap: Server; smtp: Server }> => ({
        imap: null,
        smtp: null,
      }),
    ),
  };
});

vi.mock("../lib/mail-discovery", () => discoveryMock);

const { default: app } = await import("../app");

/**
 * Every route below is behind the session gate, so sign in once and reuse the
 * cookie. Authenticating through the real endpoint (rather than mocking the
 * guard) keeps these tests honest about the gate being in place.
 */
let request: Awaited<ReturnType<typeof authedRequest>>;

beforeAll(async () => {
  request = await authedRequest(app);
});

const NOW = new Date("2026-01-15T10:30:00.000Z");

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    label: "Support",
    emailAddress: "support@example.com",
    provider: "generic",
    captureMode: "keywords",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    username: "support@example.com",
    password: "stored-secret",
    allowInvalidCert: false,
    active: true,
    lastUidSeen: 120,
    lastCheckedAt: NOW,
    lastError: null,
    deletedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.reset();
  discoveryMock.discoverImapServer.mockReset();
  discoveryMock.discoverSmtpServer.mockReset();
  discoveryMock.discoverMailServers.mockReset();
  discoveryMock.discoverImapServer.mockResolvedValue(null);
  discoveryMock.discoverSmtpServer.mockResolvedValue(null);
  discoveryMock.discoverMailServers.mockResolvedValue({
    imap: null,
    smtp: null,
  });
});

describe("PATCH /api/accounts/:id", () => {
  it("applies only the supplied fields", async () => {
    const existing = accountRow();
    dbMock.enqueue([existing], [{ ...existing, label: "Billing" }]);

    const res = await request.patch("/api/accounts/7")
      .send({ label: "Billing" });

    expect(res.status).toBe(200);
    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).toEqual({ label: "Billing" });
  });

  it("leaves the stored password untouched when password is omitted", async () => {
    const existing = accountRow();
    dbMock.enqueue([existing], [{ ...existing, username: "billing" }]);

    await request.patch("/api/accounts/7").send({ username: "billing" });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).not.toHaveProperty("password");
  });

  it("writes a new password when one is supplied", async () => {
    const existing = accountRow();
    dbMock.enqueue([existing], [existing]);

    await request.patch("/api/accounts/7")
      .send({ password: "rotated-secret" });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).toMatchObject({ password: "rotated-secret" });
  });

  it("never echoes the password back", async () => {
    const existing = accountRow();
    dbMock.enqueue([existing], [existing]);

    const res = await request.patch("/api/accounts/7")
      .send({ password: "rotated-secret" });

    expect(res.body).not.toHaveProperty("password");
    expect(JSON.stringify(res.body)).not.toContain("rotated-secret");
  });

  it("resets the UID mark when the mailbox changes", async () => {
    const existing = accountRow();
    dbMock.enqueue([existing], [{ ...existing, imapHost: "imap.other.com" }]);

    await request.patch("/api/accounts/7")
      .send({ imapHost: "imap.other.com" });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).toMatchObject({ lastUidSeen: null });
  });

  it("keeps the UID mark when the mailbox is unchanged", async () => {
    const existing = accountRow();
    dbMock.enqueue([existing], [existing]);

    // Same host as stored: not a mailbox change.
    await request.patch("/api/accounts/7")
      .send({ imapHost: "imap.example.com" });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).not.toHaveProperty("lastUidSeen");
  });

  it("clears a stale error when the account is re-enabled", async () => {
    const existing = accountRow({ active: false, lastError: "auth failed" });
    dbMock.enqueue([existing], [{ ...existing, active: true, lastError: null }]);

    await request.patch("/api/accounts/7").send({ active: true });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).toEqual({ active: true, lastError: null });
  });

  it("keeps a reported error visible after a cosmetic change", async () => {
    const existing = accountRow({ lastError: "auth failed" });
    dbMock.enqueue([existing], [{ ...existing, label: "Renamed" }]);

    await request.patch("/api/accounts/7").send({ label: "Renamed" });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).not.toHaveProperty("lastError");
  });

  it("pauses an account without touching any other field", async () => {
    const existing = accountRow();
    dbMock.enqueue([existing], [{ ...existing, active: false }]);

    const res = await request.patch("/api/accounts/7")
      .send({ active: false });

    expect(res.status).toBe(200);
    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).toEqual({ active: false });
  });

  it("returns the account unchanged for an empty patch", async () => {
    dbMock.enqueue([accountRow()]);

    const res = await request.patch("/api/accounts/7").send({});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(dbMock.countOf("update")).toBe(0);
  });

  it("returns 404 for an unknown account and does not update", async () => {
    dbMock.enqueue([]);

    const res = await request.patch("/api/accounts/999")
      .send({ label: "Ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
    expect(dbMock.countOf("update")).toBe(0);
  });

  it("rejects an invalid field before reading the account", async () => {
    const res = await request.patch("/api/accounts/7").send({ label: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(dbMock.countOf("select")).toBe(0);
  });

  it("rejects a malformed id", async () => {
    const res = await request.patch("/api/accounts/not-a-number")
      .send({ label: "Valid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rejects an unparseable email address", async () => {
    const res = await request.patch("/api/accounts/7")
      .send({ emailAddress: "nope" });

    expect(res.status).toBe(400);
    expect(dbMock.countOf("select")).toBe(0);
  });

  it("switches an account between capture modes", async () => {
    const existing = accountRow({ captureMode: "keywords" });
    dbMock.enqueue([existing], [{ ...existing, captureMode: "all" }]);

    const res = await request.patch("/api/accounts/7")
      .send({ captureMode: "all" });

    expect(res.status).toBe(200);
    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).toEqual({ captureMode: "all" });
  });

  it("accepting a mismatched certificate clears the stale TLS error", async () => {
    // Enabling the flag is precisely the fix for the stored error, so the old
    // message must not outlive it and keep the card looking broken.
    const existing = accountRow({
      lastError: "Hostname/IP does not match certificate's altnames",
    });
    dbMock.enqueue([existing], [{ ...existing, allowInvalidCert: true }]);

    const res = await request.patch("/api/accounts/7")
      .send({ allowInvalidCert: true });

    expect(res.status).toBe(200);
    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch).toEqual({ allowInvalidCert: true, lastError: null });
  });

  it("exposes the certificate flag without leaking the password", async () => {
    dbMock.enqueue([accountRow({ allowInvalidCert: true })]);

    const res = await request.get("/api/accounts");

    expect(res.body[0].allowInvalidCert).toBe(true);
    expect(res.body[0]).not.toHaveProperty("password");
  });

  it("rejects an unknown capture mode", async () => {
    const res = await request.patch("/api/accounts/7")
      .send({ captureMode: "everything" });

    expect(res.status).toBe(400);
    expect(dbMock.countOf("select")).toBe(0);
  });
});

describe("POST /api/accounts/delete-bulk", () => {
  it("soft-deletes every id, preserving message history", async () => {
    // A hard delete would destroy matched and archived messages that reference
    // these rows, so this must be an UPDATE just like the single-account route.
    dbMock.enqueue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const res = await request
      .post("/api/accounts/delete-bulk")
      .send({ ids: [1, 2, 3] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([1, 2, 3]);
    expect(res.body.notFound).toEqual([]);
    expect(dbMock.countOf("delete")).toBe(0);
    expect(dbMock.countOf("update")).toBe(1);

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch["deletedAt"]).toBeInstanceOf(Date);
    // Deactivated too, so the scheduler stops polling immediately.
    expect(patch["active"]).toBe(false);
  });

  it("uses one statement, so a partial failure cannot half-apply", async () => {
    dbMock.enqueue([{ id: 1 }, { id: 2 }]);

    await request.post("/api/accounts/delete-bulk").send({ ids: [1, 2] });

    expect(dbMock.countOf("update")).toBe(1);
  });

  it("reports ids that matched no live account", async () => {
    // Already removed, or never existed. The requested end state holds either
    // way, so this is reported rather than treated as an error.
    dbMock.enqueue([{ id: 1 }]);

    const res = await request
      .post("/api/accounts/delete-bulk")
      .send({ ids: [1, 999] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([1]);
    expect(res.body.notFound).toEqual([999]);
  });

  it("de-duplicates repeated ids", async () => {
    // Otherwise a repeated id could appear in both result lists at once.
    dbMock.enqueue([{ id: 5 }]);

    const res = await request
      .post("/api/accounts/delete-bulk")
      .send({ ids: [5, 5, 5] });

    expect(res.body.deleted).toEqual([5]);
    expect(res.body.notFound).toEqual([]);
  });

  it("rejects an empty id list", async () => {
    const res = await request.post("/api/accounts/delete-bulk").send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(dbMock.countOf("update")).toBe(0);
  });

  it("rejects a missing id list", async () => {
    const res = await request.post("/api/accounts/delete-bulk").send({});

    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric id", async () => {
    const res = await request
      .post("/api/accounts/delete-bulk")
      .send({ ids: [1, "two"] });

    expect(res.status).toBe(400);
    expect(dbMock.countOf("update")).toBe(0);
  });

  it("rejects a batch beyond the documented maximum", async () => {
    const res = await request
      .post("/api/accounts/delete-bulk")
      .send({ ids: Array.from({ length: 201 }, (_, i) => i + 1) });

    expect(res.status).toBe(400);
  });

  it("is not shadowed by the /accounts/:id route", async () => {
    // "delete-bulk" would parse as an id if the routes were declared the other
    // way round, giving a confusing 400 about a malformed id.
    dbMock.enqueue([{ id: 1 }]);

    const res = await request
      .post("/api/accounts/delete-bulk")
      .send({ ids: [1] });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/accounts/test-all", () => {
  it("tests every account and summarises the outcome", async () => {
    // Two accounts; the scanner mock is not installed here, so the real
    // testAccountConnection runs and fails on DNS. That is fine: what matters is
    // that every account is attempted and reported, not the specific verdict.
    dbMock.enqueue([
      accountRow({ id: 1, emailAddress: "a@nonexistent.invalid" }),
      accountRow({ id: 2, emailAddress: "b@nonexistent.invalid" }),
    ]);

    const res = await request.post("/api/accounts/test-all").send({});

    expect(res.status).toBe(200);
    expect(res.body.tested).toBe(2);
    expect(res.body.succeeded + res.body.failed).toBe(2);
    expect(res.body.results).toHaveLength(2);
    // Each row identifies its account so the UI can map results to cards.
    for (const r of res.body.results) {
      expect(r).toHaveProperty("accountId");
      expect(r).toHaveProperty("emailAddress");
      expect(r).toHaveProperty("ok");
      expect(typeof r.message).toBe("string");
    }
  }, 60_000);

  it("preserves listing order regardless of completion order", async () => {
    // Concurrency means whichever host answers first finishes first, but the
    // response must line up with the accounts page.
    dbMock.enqueue([
      accountRow({ id: 10, emailAddress: "first@nonexistent.invalid" }),
      accountRow({ id: 20, emailAddress: "second@nonexistent.invalid" }),
      accountRow({ id: 30, emailAddress: "third@nonexistent.invalid" }),
    ]);

    const res = await request.post("/api/accounts/test-all").send({});

    expect(res.body.results.map((r: { accountId: number }) => r.accountId)).toEqual(
      [10, 20, 30],
    );
  }, 60_000);

  it("returns an empty summary when there are no accounts", async () => {
    dbMock.enqueue([]);

    const res = await request.post("/api/accounts/test-all").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tested: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    });
  });

  it("accepts a provider filter", async () => {
    dbMock.enqueue([]);

    const res = await request
      .post("/api/accounts/test-all?provider=hostinger")
      .send({});

    expect(res.status).toBe(200);
  });

  it("rejects an unknown provider", async () => {
    const res = await request
      .post("/api/accounts/test-all?provider=gmail")
      .send({});

    expect(res.status).toBe(400);
    expect(dbMock.countOf("select")).toBe(0);
  });

  it("never leaks passwords in its results", async () => {
    dbMock.enqueue([accountRow({ id: 1, password: "top-secret-value" })]);

    const res = await request.post("/api/accounts/test-all").send({});

    expect(JSON.stringify(res.body)).not.toContain("top-secret-value");
  }, 60_000);
});

describe("POST /api/accounts/scan-all", () => {
  it("skips paused accounts and counts them separately", async () => {
    // Pausing is an instruction not to poll, so a manual scan-all must respect
    // it rather than overriding it.
    dbMock.enqueue([
      accountRow({ id: 1, active: false }),
      accountRow({ id: 2, active: false }),
    ]);

    const res = await request.post("/api/accounts/scan-all").send({});

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(2);
    expect(res.body.scannedAccounts).toBe(0);
    expect(res.body.results).toEqual([]);
  });

  it("returns totals across accounts", async () => {
    dbMock.enqueue([]);

    const res = await request.post("/api/accounts/scan-all").send({});

    expect(res.body).toEqual({
      scannedAccounts: 0,
      skipped: 0,
      totalMatched: 0,
      totalArchived: 0,
      totalForwarded: 0,
      totalNotified: 0,
      failed: 0,
      results: [],
    });
  });

  it("reports a per-account failure without failing the request", async () => {
    // One unreachable mailbox must not hide the others, which is the whole point
    // of running the batch while triaging a fresh import.
    dbMock.enqueue([accountRow({ id: 1, emailAddress: "x@nonexistent.invalid" })]);

    const res = await request.post("/api/accounts/scan-all").send({});

    expect(res.status).toBe(200);
    expect(res.body.scannedAccounts).toBe(1);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.failed).toBe(1);
  }, 60_000);

  it("rejects an unknown provider", async () => {
    const res = await request
      .post("/api/accounts/scan-all?provider=outlook")
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/accounts/:id", () => {
  it("soft-deletes rather than issuing a DELETE, so history is preserved", async () => {
    const res = await request.delete("/api/accounts/7");

    expect(res.status).toBe(204);
    // A hard delete would destroy the matched_messages that reference this row.
    expect(dbMock.countOf("delete")).toBe(0);
    expect(dbMock.countOf("update")).toBe(1);

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch["deletedAt"]).toBeInstanceOf(Date);
    // Also deactivated so the scheduler stops polling it immediately.
    expect(patch["active"]).toBe(false);
  });

  it("rejects a malformed id", async () => {
    const res = await request.delete("/api/accounts/nope");

    expect(res.status).toBe(400);
    expect(dbMock.countOf("update")).toBe(0);
  });
});

describe("POST /api/accounts/bulk", () => {
  const body = {
    accounts: [
      { emailAddress: "one@example.com" },
      { emailAddress: "two@example.com" },
    ],
    password: "shared-secret",
    imapHost: "imap.example.com",
    smtpHost: "smtp.example.com",
  };

  it("derives mail.<domain> per address when no host is given", async () => {    // The point of the default: one paste covering several domains, which a
    // single shared host cannot serve.
    dbMock.enqueue(
      [],
      [accountRow({ id: 11 })],
      [accountRow({ id: 12 })],
      [accountRow({ id: 13 })],
    );

    const res = await request.post("/api/accounts/bulk").send({
      accounts: [
        { emailAddress: "paud1@andonosari.com" },
        { emailAddress: "tamer@albadrmed.com" },
        { emailAddress: "vinay@andrewsgroup.co.in" },
      ],
      password: "pw",
    });

    expect(res.status).toBe(200);
    const rows = dbMock.allArgsOf("values").map((a) => a[0]) as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => r["imapHost"])).toEqual([
      "mail.andonosari.com",
      "mail.albadrmed.com",
      "mail.andrewsgroup.co.in",
    ]);
    // SMTP derives from the same domain.
    expect(rows.map((r) => r["smtpHost"])).toEqual([
      "mail.andonosari.com",
      "mail.albadrmed.com",
      "mail.andrewsgroup.co.in",
    ]);
  });

  it("applies the default ports alongside derived hosts", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    await request.post("/api/accounts/bulk").send({
      accounts: [{ emailAddress: "a@example.com" }],
      password: "pw",
    });

    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row).toMatchObject({
      imapHost: "mail.example.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "mail.example.com",
      smtpPort: 465,
      smtpSecure: true,
    });
  });

  it("uses a discovered server instead of the mail.<domain> guess", async () => {
    // Discovery probes the domain's MX records and conventional hostnames; a
    // live greeting beats the guess, so the account starts working.
    discoveryMock.discoverImapServer.mockResolvedValue({
      host: "mx.realdomain.com",
      port: 143,
      secure: false,
    });
    discoveryMock.discoverSmtpServer.mockResolvedValue({
      host: "smtp.realdomain.com",
      port: 587,
      secure: false,
    });
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    const res = await request.post("/api/accounts/bulk").send({
      accounts: [{ emailAddress: "a@realdomain.com" }],
      password: "pw",
    });

    expect(res.status).toBe(200);
    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row).toMatchObject({
      imapHost: "mx.realdomain.com",
      imapPort: 143,
      imapSecure: false,
      smtpHost: "smtp.realdomain.com",
      smtpPort: 587,
      smtpSecure: false,
    });
  });

  it("falls back to the derived host when discovery finds nothing", async () => {
    discoveryMock.discoverImapServer.mockResolvedValue(null);
    discoveryMock.discoverSmtpServer.mockResolvedValue(null);
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    const res = await request.post("/api/accounts/bulk").send({
      accounts: [{ emailAddress: "a@example.com" }],
      password: "pw",
    });

    expect(res.status).toBe(200);
    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row["imapHost"]).toBe("mail.example.com");
    expect(row["imapPort"]).toBe(993);
  });

  it("skips discovery entirely when the batch names its servers", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    await request.post("/api/accounts/bulk").send({
      accounts: [{ emailAddress: "a@example.com" }],
      password: "pw",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
    });

    expect(discoveryMock.discoverImapServer).not.toHaveBeenCalled();
    expect(discoveryMock.discoverSmtpServer).not.toHaveBeenCalled();
  });

  it("an explicit host overrides derivation for the whole batch", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })], [accountRow({ id: 12 })]);

    await request.post("/api/accounts/bulk").send({
      accounts: [
        { emailAddress: "a@one.com" },
        { emailAddress: "b@two.com" },
      ],
      password: "pw",
      imapHost: "imap.hostinger.com",
      smtpHost: "smtp.hostinger.com",
    });

    const rows = dbMock.allArgsOf("values").map((a) => a[0]) as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      expect(row["imapHost"]).toBe("imap.hostinger.com");
      expect(row["smtpHost"]).toBe("smtp.hostinger.com");
    }
  });

  it("prefers a per-mailbox password over the batch one", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })], [accountRow({ id: 12 })]);

    await request.post("/api/accounts/bulk").send({
      accounts: [
        { emailAddress: "a@one.com", password: "own-pw" },
        { emailAddress: "b@two.com" },
      ],
      password: "shared-pw",
    });

    const rows = dbMock.allArgsOf("values").map((a) => a[0]) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]!["password"]).toBe("own-pw");
    expect(rows[1]!["password"]).toBe("shared-pw");
  });

  it("works with per-mailbox passwords and no batch password", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    const res = await request.post("/api/accounts/bulk").send({
      accounts: [{ emailAddress: "a@one.com", password: "own-pw" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
  });

  it("reports a mailbox with no password and no batch fallback", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    const res = await request.post("/api/accounts/bulk").send({
      accounts: [
        { emailAddress: "a@one.com", password: "own-pw" },
        { emailAddress: "b@two.com" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].reason).toMatch(/no shared password/i);
  });

  it("reports an address whose domain yields no usable host", async () => {
    // A dotless domain cannot be a public mail domain, so nothing can be derived.
    dbMock.enqueue([]);

    const res = await request.post("/api/accounts/bulk").send({
      accounts: [{ emailAddress: "root@localhost" }],
      password: "pw",
    });

    // Rejected by the schema's email format before reaching derivation.
    expect(res.status).toBe(400);
  });

  it("creates one account per address with the shared credentials", async () => {
    dbMock.enqueue(
      [], // no existing addresses
      [accountRow({ id: 11, emailAddress: "one@example.com" })],
      [accountRow({ id: 12, emailAddress: "two@example.com" })],
    );

    const res = await request.post("/api/accounts/bulk").send(body);

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.failed).toEqual([]);

    const inserts = dbMock.allArgsOf("values").map((a) => a[0]);
    expect(inserts).toHaveLength(2);
    for (const row of inserts as Array<Record<string, unknown>>) {
      expect(row["password"]).toBe("shared-secret");
      expect(row["imapHost"]).toBe("imap.example.com");
      expect(row["smtpHost"]).toBe("smtp.example.com");
      // Spec defaults are applied by the zod schema.
      expect(row["imapPort"]).toBe(993);
      expect(row["smtpPort"]).toBe(465);
      expect(row["active"]).toBe(true);
    }
  });

  it("defaults label and username to the address", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    await request.post("/api/accounts/bulk")
      .send({ ...body, accounts: [{ emailAddress: "solo@example.com" }] });

    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row["label"]).toBe("solo@example.com");
    expect(row["username"]).toBe("solo@example.com");
  });

  it("honours an explicit label and username per entry", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    await request.post("/api/accounts/bulk")
      .send({
        ...body,
        accounts: [
          {
            emailAddress: "solo@example.com",
            label: "Solo Inbox",
            username: "solo-login",
          },
        ],
      });

    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row["label"]).toBe("Solo Inbox");
    expect(row["username"]).toBe("solo-login");
  });

  it("never echoes the shared password back", async () => {
    dbMock.enqueue(
      [],
      [accountRow({ id: 11 })],
      [accountRow({ id: 12 })],
    );

    const res = await request.post("/api/accounts/bulk").send(body);

    expect(JSON.stringify(res.body)).not.toContain("shared-secret");
  });

  it("reports duplicates within the request instead of inserting twice", async () => {
    dbMock.enqueue([], [accountRow({ id: 11 })]);

    const res = await request.post("/api/accounts/bulk")
      .send({
        ...body,
        accounts: [
          { emailAddress: "dup@example.com" },
          { emailAddress: "DUP@example.com" },
        ],
      });

    expect(res.status).toBe(200);
    expect(dbMock.countOf("values")).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].reason).toMatch(/duplicate/i);
  });

  it("skips addresses that already exist as live accounts", async () => {
    dbMock.enqueue(
      [{ emailAddress: "one@example.com" }], // already taken
      [accountRow({ id: 12, emailAddress: "two@example.com" })],
    );

    const res = await request.post("/api/accounts/bulk").send(body);

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].emailAddress).toBe("one@example.com");
    expect(res.body.failed[0].reason).toMatch(/already exists/i);
  });

  it("keeps going when one insert fails", async () => {
    dbMock.enqueue([], [accountRow({ id: 12 })]);
    dbMock.failInserts(new Error("constraint violation"), null);

    const res = await request.post("/api/accounts/bulk").send(body);

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].reason).toBe("constraint violation");
  });

  it("rejects an empty account list", async () => {
    const res = await request.post("/api/accounts/bulk")
      .send({ ...body, accounts: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rejects a malformed address before touching the database", async () => {
    const res = await request.post("/api/accounts/bulk")
      .send({ ...body, accounts: [{ emailAddress: "not-an-email" }] });

    expect(res.status).toBe(400);
    expect(dbMock.countOf("values")).toBe(0);
  });

  it("accepts a batch with no password field, reporting each mailbox instead", async () => {
    // The batch password is optional now: a mailbox may carry its own. Missing
    // both is a per-mailbox failure, not a rejected request, so one bad line
    // cannot discard a long paste.
    const { password: _password, ...withoutPassword } = body;
    dbMock.enqueue([]);

    const res = await request.post("/api/accounts/bulk").send(withoutPassword);

    expect(res.status).toBe(200);
    expect(res.body.created).toEqual([]);
    expect(res.body.failed).toHaveLength(2);
    for (const f of res.body.failed) {
      expect(f.reason).toMatch(/no shared password/i);
    }
  });

  it("rejects a batch larger than the documented maximum", async () => {
    const res = await request.post("/api/accounts/bulk")
      .send({
        ...body,
        accounts: Array.from({ length: 201 }, (_, i) => ({
          emailAddress: `user${i}@example.com`,
        })),
      });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/accounts", () => {
  it("omits password, lastUidSeen and deletedAt, and serializes dates", async () => {
    dbMock.enqueue([accountRow()]);

    const res = await request.get("/api/accounts");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).not.toHaveProperty("password");
    expect(res.body[0]).not.toHaveProperty("lastUidSeen");
    expect(res.body[0]).not.toHaveProperty("deletedAt");
    expect(res.body[0].createdAt).toBe(NOW.toISOString());
    expect(res.body[0].lastCheckedAt).toBe(NOW.toISOString());
  });

  it("reports a never-checked account as null rather than omitting the field", async () => {
    dbMock.enqueue([accountRow({ lastCheckedAt: null })]);

    const res = await request.get("/api/accounts");

    expect(res.body[0].lastCheckedAt).toBeNull();
  });

  it("exposes the provider", async () => {
    dbMock.enqueue([accountRow({ provider: "hostinger" })]);

    const res = await request.get("/api/accounts");

    expect(res.body[0].provider).toBe("hostinger");
  });

  it("exposes the capture mode", async () => {
    dbMock.enqueue([accountRow({ captureMode: "all" })]);

    const res = await request.get("/api/accounts");

    expect(res.body[0].captureMode).toBe("all");
  });

  it("accepts a provider filter", async () => {
    dbMock.enqueue([accountRow({ provider: "hostinger" })]);

    const res = await request.get("/api/accounts?provider=hostinger");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("rejects an unknown provider", async () => {
    const res = await request.get("/api/accounts?provider=gmail");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(dbMock.countOf("select")).toBe(0);
  });
});

describe("POST /api/accounts", () => {
  it("tags a manually configured account as generic", async () => {
    dbMock.enqueue([accountRow({ id: 20 })]);

    const res = await request.post("/api/accounts").send({
      label: "Manual",
      emailAddress: "manual@example.com",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      username: "manual@example.com",
      password: "pw",
    });

    expect(res.status).toBe(201);
    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row["provider"]).toBe("generic");
    // The generic form is the keyword triage path, not the archive.
    expect(row["captureMode"]).toBe("keywords");
  });
});

describe("GET /api/accounts/hostinger/defaults", () => {
  it("returns Hostinger's documented settings", async () => {
    const res = await request.get("/api/accounts/hostinger/defaults");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      imapHost: "imap.hostinger.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.hostinger.com",
      smtpPortSsl: 465,
      smtpPortStartTls: 587,
    });
  });
});

describe("POST /api/accounts/hostinger", () => {
  it("fills in Hostinger's servers and uses the address as the username", async () => {
    dbMock.enqueue(
      [], // nothing already taken
      [accountRow({ id: 30, provider: "hostinger" })],
    );

    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [{ emailAddress: "sales@mydomain.com" }],
        password: "shared-pw",
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toEqual([]);

    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row).toMatchObject({
      provider: "hostinger",
      emailAddress: "sales@mydomain.com",
      // Hostinger authenticates with the full address, not a local part.
      username: "sales@mydomain.com",
      label: "sales@mydomain.com",
      imapHost: "imap.hostinger.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.hostinger.com",
      smtpPort: 465,
      smtpSecure: true,
      password: "shared-pw",
      active: true,
      // Hostinger mailboxes archive everything by default.
      captureMode: "all",
    });
  });

  it("can opt a batch into keyword triage instead of archiving", async () => {
    dbMock.enqueue([], [accountRow({ id: 30 })]);

    await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [{ emailAddress: "sales@mydomain.com" }],
        password: "pw",
        captureMode: "keywords",
      });

    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row["captureMode"]).toBe("keywords");
  });

  it("rejects an unknown captureMode", async () => {
    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [{ emailAddress: "sales@mydomain.com" }],
        password: "pw",
        captureMode: "everything",
      });

    expect(res.status).toBe(400);
  });

  it("uses port 587 with secure=false for STARTTLS", async () => {
    dbMock.enqueue([], [accountRow({ id: 30 })]);

    await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [{ emailAddress: "sales@mydomain.com" }],
        password: "shared-pw",
        smtpMode: "starttls",
      });

    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    // nodemailer reads `secure: false` on 587 as "upgrade via STARTTLS".
    expect(row["smtpPort"]).toBe(587);
    expect(row["smtpSecure"]).toBe(false);
  });

  it("prefers a per-mailbox password over the shared one", async () => {
    dbMock.enqueue(
      [],
      [accountRow({ id: 30 })],
      [accountRow({ id: 31 })],
    );

    await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [
          { emailAddress: "a@mydomain.com", password: "own-pw" },
          { emailAddress: "b@mydomain.com" },
        ],
        password: "shared-pw",
      });

    const rows = dbMock.allArgsOf("values").map((a) => a[0]) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]!["password"]).toBe("own-pw");
    expect(rows[1]!["password"]).toBe("shared-pw");
  });

  it("works with per-mailbox passwords and no shared password", async () => {
    dbMock.enqueue([], [accountRow({ id: 30 })]);

    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [{ emailAddress: "a@mydomain.com", password: "own-pw" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
  });

  it("reports a mailbox that has no password and no shared fallback", async () => {
    dbMock.enqueue([], [accountRow({ id: 30 })]);

    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [
          { emailAddress: "a@mydomain.com", password: "own-pw" },
          { emailAddress: "b@mydomain.com" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].emailAddress).toBe("b@mydomain.com");
    expect(res.body.failed[0].reason).toMatch(/no shared password/i);
  });

  it("honours an explicit label", async () => {
    dbMock.enqueue([], [accountRow({ id: 30 })]);

    await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [
          { emailAddress: "sales@mydomain.com", label: "Sales Inbox" },
        ],
        password: "pw",
      });

    const [row] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(row["label"]).toBe("Sales Inbox");
  });

  it("reports duplicates within the request instead of inserting twice", async () => {
    dbMock.enqueue([], [accountRow({ id: 30 })]);

    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [
          { emailAddress: "dup@mydomain.com" },
          { emailAddress: "DUP@mydomain.com" },
        ],
        password: "pw",
      });

    expect(dbMock.countOf("values")).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].reason).toMatch(/duplicate/i);
  });

  it("skips mailboxes that already exist", async () => {
    dbMock.enqueue(
      [{ emailAddress: "taken@mydomain.com" }],
      [accountRow({ id: 31 })],
    );

    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [
          { emailAddress: "taken@mydomain.com" },
          { emailAddress: "fresh@mydomain.com" },
        ],
        password: "pw",
      });

    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].reason).toMatch(/already exists/i);
  });

  it("never echoes a password back", async () => {
    dbMock.enqueue([], [accountRow({ id: 30 })]);

    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [{ emailAddress: "a@mydomain.com", password: "secret-pw" }],
      });

    expect(JSON.stringify(res.body)).not.toContain("secret-pw");
  });

  it("rejects an empty mailbox list", async () => {
    const res = await request.post("/api/accounts/hostinger")
      .send({ mailboxes: [], password: "pw" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rejects a malformed address before touching the database", async () => {
    const res = await request.post("/api/accounts/hostinger")
      .send({ mailboxes: [{ emailAddress: "nope" }], password: "pw" });

    expect(res.status).toBe(400);
    expect(dbMock.countOf("values")).toBe(0);
  });

  it("rejects an unknown smtpMode", async () => {
    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: [{ emailAddress: "a@mydomain.com" }],
        password: "pw",
        smtpMode: "plaintext",
      });

    expect(res.status).toBe(400);
  });

  it("rejects a batch larger than the documented maximum", async () => {
    const res = await request.post("/api/accounts/hostinger")
      .send({
        mailboxes: Array.from({ length: 201 }, (_, i) => ({
          emailAddress: `user${i}@mydomain.com`,
        })),
        password: "pw",
      });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/accounts/:id/discover-host", () => {
  it("applies a discovered endpoint and drops the stored marks", async () => {
    discoveryMock.discoverMailServers.mockResolvedValue({
      imap: { host: "mx.example.com", port: 993, secure: true },
      smtp: { host: "smtp.example.com", port: 465, secure: true },
    });
    dbMock.enqueue(
      [accountRow({ smtpHost: "smtp.old.example.com" })],
      [accountRow({ imapHost: "mx.example.com" })],
    );

    const res = await request.post("/api/accounts/7/discover-host");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imapFound).toBe(true);
    expect(res.body.smtpFound).toBe(true);

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    // UIDs from a different server cannot be compared, so the marks reset.
    expect(patch).toMatchObject({
      imapHost: "mx.example.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.example.com",
      lastUidSeen: null,
      folderMarks: null,
      lastError: null,
    });
    // Credentials are never part of the reply.
    expect(JSON.stringify(res.body)).not.toContain("stored-secret");
  });

  it("keeps the marks when discovery agrees with the stored settings", async () => {
    discoveryMock.discoverMailServers.mockResolvedValue({
      imap: { host: "imap.example.com", port: 993, secure: true },
      smtp: { host: "smtp.example.com", port: 465, secure: true },
    });
    dbMock.enqueue([accountRow()]);

    const res = await request.post("/api/accounts/7/discover-host");

    expect(res.status).toBe(200);
    // Nothing to apply, so nothing was written — but the answer says the host
    // is right and points the operator at the password instead.
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBeNull();
    expect(dbMock.countOf("update")).toBe(0);
    expect(res.body.message).toMatch(/password/i);
  });

  it("reports when no candidate answered and changes nothing", async () => {
    discoveryMock.discoverMailServers.mockResolvedValue({
      imap: null,
      smtp: null,
    });
    dbMock.enqueue([accountRow()]);

    const res = await request.post("/api/accounts/7/discover-host");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.updated).toBeNull();
    expect(dbMock.countOf("update")).toBe(0);
  });

  it("refuses a Hostinger account, whose servers are preset", async () => {
    dbMock.enqueue([accountRow({ provider: "hostinger" })]);

    const res = await request.post("/api/accounts/7/discover-host");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    // An MX host is a relay, not Hostinger's mailbox server; probing one must
    // not overwrite working settings.
    expect(discoveryMock.discoverMailServers).not.toHaveBeenCalled();
    expect(dbMock.countOf("update")).toBe(0);
  });

  it("returns 404 for an unknown account", async () => {
    dbMock.enqueue([]);

    const res = await request.post("/api/accounts/999/discover-host");

    expect(res.status).toBe(404);
  });

  it("rejects a malformed id", async () => {
    const res = await request.post("/api/accounts/nope/discover-host");

    expect(res.status).toBe(400);
  });
});

describe("POST /api/messages/export", () => {
  const exportRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    accountId: 7,
    accountLabel: "Support",
    accountEmail: "support@example.com",
    accountDeletedAt: null,
    messageUid: "120",
    folder: "INBOX",
    messageId: "<abc@example.com>",
    fromAddress: "rewards@example.com",
    toAddress: "support@example.com",
    subject: "Claim your reward",
    snippet: "You have a reward waiting",
    bodyText: "The whole text body",
    bodyHtml: "<p>The whole HTML body</p>",
    bodyTruncated: false,
    receivedAt: NOW,
    createdAt: NOW,
    matchedKeywords: ["claim"],
    forwarded: false,
    forwardError: null,
    ...overrides,
  });

  it("exports the selected ids with their full bodies", async () => {
    dbMock.enqueue([exportRow()]);

    const res = await request
      .post("/api/messages/export")
      .send({ ids: [1] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({
      subject: "Claim your reward",
      bodyText: "The whole text body",
      bodyHtml: "<p>The whole HTML body</p>",
      matchedKeywords: ["claim"],
    });
    // A real download, not just a JSON payload.
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
  });

  it("exports by the same filters the list accepts when no ids are given", async () => {
    dbMock.enqueue([exportRow()]);

    const res = await request
      .post("/api/messages/export")
      .send({ search: "reward" });

    expect(res.status).toBe(200);
    expect(dbMock.countOf("where")).toBe(1);
    // The cap plus one, so truncation is detectable without a count query.
    expect(dbMock.argsOf("limit")).toEqual([2001]);
  });

  it("rejects an invalid date filter", async () => {
    const res = await request
      .post("/api/messages/export")
      .send({ receivedFrom: "not-a-date" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/messages/delete-bulk", () => {
  it("deletes every id and reports the unknown ones", async () => {
    dbMock.enqueue([{ id: 1 }, { id: 2 }]);

    const res = await request
      .post("/api/messages/delete-bulk")
      .send({ ids: [1, 2, 999] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([1, 2]);
    expect(res.body.notFound).toEqual([999]);
  });

  it("rejects an empty id list", async () => {
    const res = await request
      .post("/api/messages/delete-bulk")
      .send({ ids: [] });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/messages/ids", () => {
  it("returns the ids of every match, newest first", async () => {
    dbMock.enqueue([{ id: 9 }, { id: 4 }, { id: 2 }]);

    const res = await request
      .post("/api/messages/ids")
      .send({ search: "claim" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [9, 4, 2], truncated: false });
    // One extra row fetched so truncation is detectable without a count query.
    expect(dbMock.argsOf("limit")).toEqual([2001]);
  });

  it("flags truncation at the selection cap", async () => {
    dbMock.enqueue(
      Array.from({ length: 2001 }, (_, i) => ({ id: i + 1 })),
    );

    const res = await request.post("/api/messages/ids").send({});

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.ids).toHaveLength(2000);
  });

  it("rejects an invalid date filter", async () => {
    const res = await request
      .post("/api/messages/ids")
      .send({ receivedFrom: "not-a-date" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/messages/recheck-archive", () => {
  const archivedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 50,
    accountId: 7,
    accountLabelSnapshot: "Support",
    accountEmailSnapshot: "support@example.com",
    messageUid: "42",
    folder: "INBOX",
    messageId: "<42@example.com>",
    fromAddress: "promo@example.com",
    toAddress: "support@example.com",
    subject: "Your gift is waiting",
    snippet: "open your gift",
    bodyText: "Claim the gift inside",
    bodyHtml: null,
    bodyTruncated: false,
    receivedAt: NOW,
    createdAt: NOW,
    ...overrides,
  });

  it("surfaces archived messages that match the current keywords", async () => {
    dbMock.enqueue(
      // getSettings
      [
        {
          id: 1,
          keywords: ["gift"],
          forwardToEmail: null,
          pollIntervalSeconds: 120,
          forwardingEnabled: false,
          retainBodiesDays: 0,
          retainMessagesDays: 0,
          updatedAt: NOW,
        },
      ],
      // first batch of archived rows
      [archivedRow()],
      // insert ... returning
      [{ id: 90 }],
      // second batch: end of the archive
      [],
    );

    const res = await request.post("/api/messages/recheck-archive");

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.inserted).toBe(1);

    const [values] = dbMock.argsOf("values") as [Record<string, unknown>];
    expect(values["matchedKeywords"]).toEqual(["gift"]);
    expect(values["messageUid"]).toBe("42");
    expect(values["forwarded"]).toBe(false);
  });

  it("leaves non-matching archive rows alone", async () => {
    dbMock.enqueue(
      [
        {
          id: 1,
          keywords: ["invoice"],
          forwardToEmail: null,
          pollIntervalSeconds: 120,
          forwardingEnabled: false,
          retainBodiesDays: 0,
          retainMessagesDays: 0,
          updatedAt: NOW,
        },
      ],
      [archivedRow({ subject: "Lunch", bodyText: "see you at noon" })],
      [],
    );

    const res = await request.post("/api/messages/recheck-archive");

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.inserted).toBe(0);
    expect(dbMock.countOf("values")).toBe(0);
  });
});

describe("GET /api/messages", () => {
  const messageRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    accountId: 7,
    accountLabel: "Support",
    accountEmail: "support@example.com",
    accountDeletedAt: null,
    messageUid: "120",
    messageId: "<abc@example.com>",
    fromAddress: "rewards@example.com",
    toAddress: "support@example.com",
    subject: "Claim your reward",
    snippet: "You have a reward waiting",
    receivedAt: NOW,
    matchedKeywords: ["claim"],
    forwarded: false,
    forwardError: null,
    createdAt: NOW,
    ...overrides,
  });

  it("exposes the forwarding failure reason", async () => {
    dbMock.enqueue([
      messageRow({ forwarded: false, forwardError: "SMTP 535 auth failed" }),
    ]);

    const res = await request.get("/api/messages");

    expect(res.status).toBe(200);
    expect(res.body[0].forwardError).toBe("SMTP 535 auth failed");
  });

  it("keeps the captured attribution and flags a removed account", async () => {
    dbMock.enqueue([
      messageRow({
        accountLabel: "Support (old name)",
        accountEmail: "old@example.com",
        accountDeletedAt: NOW,
      }),
    ]);

    const res = await request.get("/api/messages");

    // The snapshot survives the account being removed, so history stays readable.
    expect(res.body[0].accountId).toBe(7);
    expect(res.body[0].accountLabel).toBe("Support (old name)");
    expect(res.body[0].accountEmail).toBe("old@example.com");
    expect(res.body[0].accountDeleted).toBe(true);
    // The internal timestamp is not part of the API contract.
    expect(res.body[0]).not.toHaveProperty("accountDeletedAt");
  });

  it("reports a live account as not deleted", async () => {
    dbMock.enqueue([messageRow()]);

    const res = await request.get("/api/messages");

    expect(res.body[0].accountDeleted).toBe(false);
  });

  it("applies limit and offset for pagination", async () => {
    dbMock.enqueue([messageRow()]);

    const res = await request.get("/api/messages?limit=25&offset=50");

    expect(res.status).toBe(200);
    expect(dbMock.argsOf("limit")).toEqual([25]);
    expect(dbMock.argsOf("offset")).toEqual([50]);
  });

  it("defaults to the first page", async () => {
    dbMock.enqueue([messageRow()]);

    await request.get("/api/messages");

    expect(dbMock.argsOf("limit")).toEqual([100]);
    expect(dbMock.argsOf("offset")).toEqual([0]);
  });

  it("rejects a non-numeric limit", async () => {
    const res = await request.get("/api/messages?limit=lots");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rejects a limit above the documented maximum", async () => {
    const res = await request.get("/api/messages?limit=5000");

    expect(res.status).toBe(400);
  });

  it("rejects a negative offset", async () => {
    const res = await request.get("/api/messages?offset=-5");

    expect(res.status).toBe(400);
  });

  it("omits bodies, which would make a page megabytes", async () => {
    dbMock.enqueue([messageRow()]);

    const res = await request.get("/api/messages");

    // Bodies come from GET /messages/:id only.
    expect(res.body[0]).not.toHaveProperty("bodyText");
    expect(res.body[0]).not.toHaveProperty("bodyHtml");
    expect(res.body[0].snippet).toBe("You have a reward waiting");
  });
});

describe("GET /api/messages/:id", () => {
  const detailRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    accountId: 7,
    accountLabel: "Support",
    accountEmail: "support@example.com",
    accountDeletedAt: null,
    messageUid: "120",
    messageId: "<abc@example.com>",
    fromAddress: "rewards@example.com",
    toAddress: "support@example.com",
    subject: "Claim your reward",
    snippet: "You have a reward waiting",
    bodyText: "Amount: $60.00. The complete body, every character of it.",
    bodyHtml: "<p>Amount: $60.00</p>",
    bodyTruncated: false,
    receivedAt: NOW,
    createdAt: NOW,
    matchedKeywords: ["claim"],
    forwarded: true,
    forwardError: null,
    ...overrides,
  });

  it("returns the full body, which the list endpoint omits", async () => {
    dbMock.enqueue([detailRow()]);

    const res = await request.get("/api/messages/1");

    expect(res.status).toBe(200);
    expect(res.body.bodyText).toBe(
      "Amount: $60.00. The complete body, every character of it.",
    );
    expect(res.body.bodyHtml).toBe("<p>Amount: $60.00</p>");
  });

  it("includes the keyword and forwarding fields", async () => {
    dbMock.enqueue([detailRow()]);

    const res = await request.get("/api/messages/1");

    expect(res.body.matchedKeywords).toEqual(["claim"]);
    expect(res.body.forwarded).toBe(true);
    expect(res.body.forwardError).toBeNull();
  });

  it("surfaces a forwarding failure reason", async () => {
    dbMock.enqueue([
      detailRow({ forwarded: false, forwardError: "SMTP 535 auth failed" }),
    ]);

    const res = await request.get("/api/messages/1");

    expect(res.body.forwardError).toBe("SMTP 535 auth failed");
  });

  it("surfaces the truncation flag", async () => {
    dbMock.enqueue([detailRow({ bodyTruncated: true })]);

    const res = await request.get("/api/messages/1");

    expect(res.body.bodyTruncated).toBe(true);
  });

  it("reports a missing part as null", async () => {
    dbMock.enqueue([detailRow({ bodyHtml: null, messageId: null })]);

    const res = await request.get("/api/messages/1");

    expect(res.body.bodyHtml).toBeNull();
    expect(res.body.messageId).toBeNull();
  });

  it("returns HTML verbatim, leaving sanitization to the sandboxed renderer", async () => {
    const hostile = '<script>alert(1)</script><img src="http://tracker/x">';
    dbMock.enqueue([detailRow({ bodyHtml: hostile })]);

    const res = await request.get("/api/messages/1");

    expect(res.body.bodyHtml).toBe(hostile);
  });

  it("never leaks the internal account-deleted timestamp", async () => {
    dbMock.enqueue([detailRow({ accountDeletedAt: NOW })]);

    const res = await request.get("/api/messages/1");

    expect(res.body.accountDeleted).toBe(true);
    expect(res.body).not.toHaveProperty("accountDeletedAt");
  });

  it("returns 404 for an unknown id", async () => {
    dbMock.enqueue([]);

    const res = await request.get("/api/messages/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("rejects a malformed id", async () => {
    const res = await request.get("/api/messages/nope");

    expect(res.status).toBe(400);
    expect(dbMock.countOf("select")).toBe(0);
  });
});

describe("GET /api/healthz", () => {
  it("reports ok when the database answers", async () => {
    // The probe caches its result process-wide, so clear it or this inherits a
    // verdict measured by an earlier test in this file.
    resetProbeCache();
    dbMock.enqueue({ rows: [{ ok: 1 }] });

    const res = await request.get("/api/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", database: "ok" });
  });
});

describe("unmatched API routes", () => {
  it("answers with a JSON 404", async () => {
    const res = await request.get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("answers with a JSON 404 for an unsupported method", async () => {
    const res = await request.put("/api/accounts/7").send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });
});
