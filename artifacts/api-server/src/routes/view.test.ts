import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createSessionToken, createViewToken } from "../lib/auth";

/**
 * Calls recorded in order, shared across every awaited chain: the mock db is
 * one queue, so a test enqueues the results in the exact order the route's
 * awaits consume them.
 */
const dbMock = vi.hoisted(() => {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const queue: unknown[] = [];

  // A recording callable for every chained method (from, set, where, ...).
  const method = (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
      return proxy;
    };

  const proxy: Record<string, unknown> = new Proxy(
    {} as Record<string, unknown>,
    {
      get(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") {
          return (onFulfilled?: (v: unknown) => unknown) => {
            const next = queue.length > 0 ? queue.shift() : { rows: [] };
            return Promise.resolve(next).then(onFulfilled);
          };
        }
        return method(String(prop));
      },
    },
  );

  return {
    db: {
      insert: method("insert"),
      update: method("update"),
      select: method("select"),
      delete: method("delete"),
    },
    calls,
    enqueue(...results: unknown[]) {
      queue.push(...results);
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
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
 * Must match vitest.config.ts so tokens minted here verify against the app's
 * auth state, exactly like a real Telegram link would.
 */
const SECRET = "z".repeat(48);
const PASSWORD_HASH =
  "scrypt$65536$8$1$0defac6c1cffed4961101a7621aef86d$062bd4d5ba00c925ca597c0ffdcea58475fd603e3872674a6bccbc56bcfb0189da9fb93e349b67398928ac9f4e652927039648c5964263c185ef228de89e1960";

const NOW = new Date("2026-10-29T22:00:00.000Z");

function matchedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    accountId: 3,
    accountLabel: "Sales",
    accountEmail: "sales@mydomain.com",
    accountDeletedAt: null,
    messageUid: "42",
    folder: "INBOX",
    messageId: "<42@example.com>",
    fromAddress: "rewards@example.com",
    toAddress: "sales@mydomain.com",
    subject: "Urgent claim",
    snippet: "claim your reward",
    bodyText: "The full text body",
    bodyHtml: "<p>The full HTML body</p>",
    bodyTruncated: false,
    receivedAt: NOW,
    createdAt: NOW,
    matchedKeywords: ["urgent"],
    forwarded: false,
    forwardError: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.reset();
});

describe("GET /api/view/:token", () => {
  it("serves one message without a session", async () => {
    const token = createViewToken(SECRET, PASSWORD_HASH, "matched", 5);
    dbMock.enqueue([matchedRow()]);

    // Deliberately unauthenticated: the link itself is the credential, which
    // is the entire point of the endpoint.
    const res = await request(app).get(`/api/view/${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 5,
      subject: "Urgent claim",
      bodyText: "The full text body",
      bodyHtml: "<p>The full HTML body</p>",
      matchedKeywords: ["urgent"],
    });
  });

  it("serves an archived (inbox) message by its own token kind", async () => {
    const token = createViewToken(SECRET, PASSWORD_HASH, "inbox", 9);
    dbMock.enqueue([
      matchedRow({ id: 9, matchedKeywords: undefined, forwarded: undefined, forwardError: undefined }),
    ]);

    const res = await request(app).get(`/api/view/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("Urgent claim");
  });

  it("rejects an expired link", async () => {
    const token = createViewToken(SECRET, PASSWORD_HASH, "matched", 5, 1_000, 60);

    const res = await request(app).get(`/api/view/${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("rejects a tampered link", async () => {
    const token = createViewToken(SECRET, PASSWORD_HASH, "matched", 5);
    const tampered = token.replace(/\.5\./, ".6.");

    const res = await request(app).get(`/api/view/${tampered}`);

    expect(res.status).toBe(404);
  });

  it("rejects a session token replayed as a view link", async () => {
    const session = createSessionToken(SECRET, PASSWORD_HASH);

    const res = await request(app).get(`/api/view/${session}`);

    expect(res.status).toBe(404);
  });

  it("answers 404 when the message is no longer stored", async () => {
    const token = createViewToken(SECRET, PASSWORD_HASH, "matched", 999);
    dbMock.enqueue([]);

    const res = await request(app).get(`/api/view/${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("rejects a malformed token shape", async () => {
    const res = await request(app).get("/api/view/");

    // An empty token is an unmatched route, not this endpoint; use junk instead.
    const junk = await request(app).get("/api/view/not-a-token");

    expect([404, 400]).toContain(junk.status);
    expect(res.status).toBe(404);
  });
});
