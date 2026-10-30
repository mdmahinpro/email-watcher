import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authedRequest } from "../test-support/authed";

/** Queue-driven db mock; `execute` (sequence fixups) never consumes the queue. */
const dbMock = vi.hoisted(() => {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const queue: unknown[] = [];

  const method = (op: string) => (...args: unknown[]) => {
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
            const next = queue.length > 0 ? queue.shift() : [];
            return Promise.resolve(next).then(onFulfilled);
          };
        }
        return method(String(prop));
      },
    },
  );

  return {
    db: {
      select: method("select"),
      insert: method("insert"),
      execute: async (...args: unknown[]) => {
        calls.push({ op: "execute", args });
        return undefined;
      },
      delete: method("delete"),
      update: method("update"),
    },
    calls,
    enqueue(...results: unknown[]) {
      queue.push(...results);
    },
    argsOf(op: string): unknown[] {
      return calls.filter((c) => c.op === op).map((c) => c.args);
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

let request: Awaited<ReturnType<typeof authedRequest>>;

beforeAll(async () => {
  request = await authedRequest(app);
});

beforeEach(() => {
  dbMock.reset();
});

describe("GET /api/backup", () => {
  it("streams the whole database as a downloadable document", async () => {
    // One row in every table, then each table reports empty.
    dbMock.enqueue([{ id: 1, keywords: ["claim"], criticalKeywords: [] }]);
    dbMock.enqueue([{ id: 1, emailAddress: "box@example.com" }]);
    dbMock.enqueue([{ id: 1, subject: "Matched", bodyText: "full body" }]);
    dbMock.enqueue([{ id: 1, subject: "Archived", bodyText: "archived body" }]);

    const res = await request.get("/api/backup");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    // supertest parses JSON, so a body here proves the document is valid JSON.
    expect(res.body.version).toBe(1);
    expect(res.body.tables.matched_messages[0].bodyText).toBe("full body");
    expect(res.body.tables.inbox_messages[0].subject).toBe("Archived");
    expect(res.body.counts.email_accounts).toBe(1);
  });
});

describe("POST /api/backup/restore", () => {
  it("restores missing rows and reports the counts", async () => {
    // Only accounts are provided; the insert returns one restored id.
    dbMock.enqueue([{ id: 3 }]);

    const res = await request.post("/api/backup/restore").send({
      version: 1,
      tables: {
        email_accounts: [{ id: 3, emailAddress: "restored@example.com" }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.restored.email_accounts).toBe(1);
    expect(res.body.message).toMatch(/Restored 1 row/);
  });

  it("rejects a file that is not a backup", async () => {
    const res = await request.post("/api/backup/restore").send({ hello: "x" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rejects a file with an unknown version", async () => {
    const res = await request
      .post("/api/backup/restore")
      .send({ version: 42, tables: {} });

    expect(res.status).toBe(400);
  });

  it("accepts a body larger than the global 1 MB limit", async () => {
    // The restore path has its own JSON parser; a backup is supposed to be big.
    dbMock.enqueue([{ id: 1 }]);
    const bigBody = "x".repeat(1_500_000);

    const res = await request.post("/api/backup/restore").send({
      version: 1,
      tables: {
        matched_messages: [{ id: 1, bodyText: bigBody }],
      },
    });

    expect(res.status).toBe(200);
  });
});
