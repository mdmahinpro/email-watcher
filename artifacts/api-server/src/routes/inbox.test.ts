import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authedRequest } from "../test-support/authed";

/**
 * Chainable stand-in for the Drizzle query builder, recording every call so a
 * test can assert on limit/offset and on which filters were applied.
 */
const dbMock = vi.hoisted(() => {
  interface Call {
    op: string;
    args: unknown[];
  }

  const calls: Call[] = [];
  const queue: unknown[] = [];

  const makeChain = (): Record<string, unknown> => {
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
      return makeChain();
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
    enqueue(...results: unknown[]) {
      queue.push(...results);
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
    },
    argsOf(op: string): unknown[] {
      const matches = calls.filter((c) => c.op === op);
      if (matches.length !== 1) {
        throw new Error(
          `Expected exactly one "${op}" call, saw ${matches.length}`,
        );
      }
      return matches[0]!.args;
    },
    countOf(op: string): number {
      return calls.filter((c) => c.op === op).length;
    },
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return {
    ...schema,
    db: dbMock.db,
    pool: { end: async () => undefined },
  };
});

vi.mock("../lib/scheduler", () => ({
  startScheduler: vi.fn(async () => undefined),
  stopScheduler: vi.fn(async () => undefined),
  restartScheduler: vi.fn(async () => undefined),
}));

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

const NOW = new Date("2026-02-01T09:15:00.000Z");

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    accountId: 3,
    accountLabel: "Sales",
    accountEmail: "sales@mydomain.com",
    accountDeletedAt: null,
    messageUid: "42",
    messageId: "<42@example.com>",
    fromAddress: "customer@elsewhere.com",
    toAddress: "sales@mydomain.com",
    subject: "Order enquiry",
    snippet: "Do you ship to Spain?",
    receivedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.reset();
});

describe("GET /api/inbox", () => {
  it("returns archived mail with snapshot attribution", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 5,
      accountId: 3,
      accountLabel: "Sales",
      accountEmail: "sales@mydomain.com",
      accountDeleted: false,
      subject: "Order enquiry",
    });
    expect(res.body[0].receivedAt).toBe(NOW.toISOString());
  });

  it("carries no keyword or forwarding fields", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox");

    // Nothing was matched and nothing was relayed, so these must be absent
    // rather than present-and-empty.
    expect(res.body[0]).not.toHaveProperty("matchedKeywords");
    expect(res.body[0]).not.toHaveProperty("forwarded");
    expect(res.body[0]).not.toHaveProperty("forwardError");
  });

  it("omits bodies, which would make a page megabytes", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox");

    // Bodies come from GET /inbox/:id only.
    expect(res.body[0]).not.toHaveProperty("bodyText");
    expect(res.body[0]).not.toHaveProperty("bodyHtml");
    // The short preview is still there for list rendering.
    expect(res.body[0].snippet).toBe("Do you ship to Spain?");
  });

  it("flags a mailbox that has since been removed", async () => {
    dbMock.enqueue([inboxRow({ accountDeletedAt: NOW })]);

    const res = await request.get("/api/inbox");

    expect(res.body[0].accountDeleted).toBe(true);
    // The internal timestamp is not part of the API contract.
    expect(res.body[0]).not.toHaveProperty("accountDeletedAt");
  });

  it("defaults to the first page", async () => {
    dbMock.enqueue([inboxRow()]);

    await request.get("/api/inbox");

    expect(dbMock.argsOf("limit")).toEqual([100]);
    expect(dbMock.argsOf("offset")).toEqual([0]);
  });

  it("applies limit and offset", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox?limit=25&offset=75");

    expect(res.status).toBe(200);
    expect(dbMock.argsOf("limit")).toEqual([25]);
    expect(dbMock.argsOf("offset")).toEqual([75]);
  });

  it("accepts an account filter", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox?accountId=3");

    expect(res.status).toBe(200);
    expect(dbMock.countOf("where")).toBe(1);
  });

  it("accepts a provider filter", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox?provider=hostinger");

    expect(res.status).toBe(200);
  });

  it("accepts a search term", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox?search=enquiry");

    expect(res.status).toBe(200);
    expect(dbMock.countOf("where")).toBe(1);
  });

  it("ignores a whitespace-only search term", async () => {
    dbMock.enqueue([inboxRow()]);

    const res = await request.get("/api/inbox?search=%20%20");

    expect(res.status).toBe(200);
  });

  it("rejects an unknown provider", async () => {
    const res = await request.get("/api/inbox?provider=gmail");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(dbMock.countOf("select")).toBe(0);
  });

  it("rejects a non-numeric limit", async () => {
    const res = await request.get("/api/inbox?limit=lots");

    expect(res.status).toBe(400);
  });

  it("rejects a limit above the documented maximum", async () => {
    const res = await request.get("/api/inbox?limit=5000");

    expect(res.status).toBe(400);
  });

  it("rejects a negative offset", async () => {
    const res = await request.get("/api/inbox?offset=-1");

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/inbox/:id", () => {
  it("deletes one archived message", async () => {
    const res = await request.delete("/api/inbox/5");

    expect(res.status).toBe(204);
    expect(dbMock.countOf("delete")).toBe(1);
  });

  it("rejects a malformed id", async () => {
    const res = await request.delete("/api/inbox/nope");

    expect(res.status).toBe(400);
    expect(dbMock.countOf("delete")).toBe(0);
  });
});

describe("GET /api/inbox/:id", () => {
  const detailRow = (overrides: Record<string, unknown> = {}) => ({
    ...inboxRow(),
    bodyText: "The full plain-text body, all of it.",
    bodyHtml: "<p>The full HTML body</p>",
    bodyTruncated: false,
    ...overrides,
  });

  it("returns the full body, which the list endpoint omits", async () => {
    dbMock.enqueue([detailRow()]);

    const res = await request.get("/api/inbox/5");

    expect(res.status).toBe(200);
    expect(res.body.bodyText).toBe("The full plain-text body, all of it.");
    expect(res.body.bodyHtml).toBe("<p>The full HTML body</p>");
    expect(res.body.bodyTruncated).toBe(false);
  });

  it("keeps the snapshot attribution and the deleted flag", async () => {
    dbMock.enqueue([detailRow({ accountDeletedAt: NOW })]);

    const res = await request.get("/api/inbox/5");

    expect(res.body.accountLabel).toBe("Sales");
    expect(res.body.accountEmail).toBe("sales@mydomain.com");
    expect(res.body.accountDeleted).toBe(true);
    expect(res.body).not.toHaveProperty("accountDeletedAt");
  });

  it("reports a missing part as null, not an empty string", async () => {
    dbMock.enqueue([detailRow({ bodyText: null, messageId: null })]);

    const res = await request.get("/api/inbox/5");

    expect(res.body.bodyText).toBeNull();
    expect(res.body.messageId).toBeNull();
  });

  it("surfaces the truncation flag", async () => {
    dbMock.enqueue([detailRow({ bodyTruncated: true })]);

    const res = await request.get("/api/inbox/5");

    expect(res.body.bodyTruncated).toBe(true);
  });

  it("returns HTML verbatim, leaving sanitization to the sandboxed renderer", async () => {
    const hostile = '<script>alert(1)</script><img src="http://tracker/x">';
    dbMock.enqueue([detailRow({ bodyHtml: hostile })]);

    const res = await request.get("/api/inbox/5");

    expect(res.body.bodyHtml).toBe(hostile);
  });

  it("returns 404 for an unknown id", async () => {
    dbMock.enqueue([]);

    const res = await request.get("/api/inbox/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("rejects a malformed id", async () => {
    const res = await request.get("/api/inbox/nope");

    expect(res.status).toBe(400);
    expect(dbMock.countOf("select")).toBe(0);
  });
});

describe("GET /api/stats/summary", () => {
  it("counts archived mail separately from keyword matches", async () => {
    dbMock.enqueue(
      // accounts
      [{ active: true }, { active: false }],
      // matched_messages aggregate
      [{ total: 4, last24h: 1, last7d: 3, forwarded: 2 }],
      // inbox_messages aggregate
      [{ total: 250, last24h: 40 }],
      // heartbeat row (databaseSizeBytes uses db.execute, queued separately)
      [{ day: "2026-06-01" }],
    );

    const res = await request.get("/api/stats/summary");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalAccounts: 2,
      activeAccounts: 1,
      totalMatches: 4,
      matchesLast24h: 1,
      matchesLast7d: 3,
      forwardedCount: 2,
      // An unfiltered archive must never inflate the match figures.
      archivedTotal: 250,
      archivedLast24h: 40,
    });
    // Both free-tier observability fields are present, even if null.
    expect(res.body).toHaveProperty("databaseBytes");
    expect(res.body).toHaveProperty("heartbeatDay");
  });
});
