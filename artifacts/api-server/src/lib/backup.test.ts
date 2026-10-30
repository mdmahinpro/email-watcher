import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Queue-driven db mock: every awaited select/insert chain resolves the next
 * enqueued value, in call order. `execute` (sequence fixups) is recorded but
 * never consumes the queue.
 */
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
    reset() {
      calls.length = 0;
      queue.length = 0;
    },
    argsOf(op: string): unknown[] {
      return calls.filter((c) => c.op === op).map((c) => c.args);
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

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { BACKUP_VERSION, RestoreError, backupChunks, restoreBackup } =
  await import("./backup");

beforeEach(() => {
  dbMock.reset();
});

async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const chunk of chunks) out += chunk;
  return out;
}

const messageRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  accountId: 1,
  accountLabelSnapshot: "Box",
  accountEmailSnapshot: "box@example.com",
  messageUid: "7",
  folder: "INBOX",
  messageId: "<7@example.com>",
  fromAddress: "a@example.com",
  toAddress: "box@example.com",
  subject: "Hello",
  snippet: "hi",
  bodyText: "the body",
  bodyHtml: null,
  bodyTruncated: false,
  matchedKeywords: ["x"],
  forwarded: false,
  forwardError: null,
  receivedAt: "2026-10-30T00:00:00.000Z",
  createdAt: "2026-10-30T00:00:00.000Z",
  ...overrides,
});

describe("backupChunks", () => {
  it("produces one valid document with every table and its counts", async () => {
    // One batch per table; each table is read once and then reports empty.
    dbMock.enqueue([{ id: 1, keywords: ["a"], criticalKeywords: [] }]);
    dbMock.enqueue([
      { id: 1, emailAddress: "box@example.com", captureMode: "keywords" },
    ]);
    dbMock.enqueue([messageRow()]);
    dbMock.enqueue([messageRow({ id: 2 })]);

    const doc = JSON.parse(await collect(backupChunks()));

    expect(doc.version).toBe(BACKUP_VERSION);
    expect(typeof doc.exportedAt).toBe("string");
    expect(Object.keys(doc.tables)).toEqual([
      "app_settings",
      "email_accounts",
      "matched_messages",
      "inbox_messages",
    ]);
    expect(doc.tables.matched_messages).toHaveLength(1);
    expect(doc.counts).toEqual({
      app_settings: 1,
      email_accounts: 1,
      matched_messages: 1,
      inbox_messages: 1,
    });
  });

  it("streams an empty database as empty tables", async () => {
    // Four tables, each reading one empty batch.
    dbMock.enqueue([], [], [], []);

    const doc = JSON.parse(await collect(backupChunks()));

    expect(doc.tables.app_settings).toEqual([]);
    expect(doc.counts.inbox_messages).toBe(0);
  });
});

describe("restoreBackup", () => {
  it("rejects a file that is not a backup", async () => {
    await expect(restoreBackup({ hello: "world" })).rejects.toBeInstanceOf(
      RestoreError,
    );
    await expect(restoreBackup(null)).rejects.toBeInstanceOf(RestoreError);
  });

  it("rejects an unsupported version", async () => {
    await expect(
      restoreBackup({ version: 99, tables: {} }),
    ).rejects.toBeInstanceOf(RestoreError);
  });

  it("rejects a table section that is not a list", async () => {
    await expect(
      restoreBackup({
        version: BACKUP_VERSION,
        tables: { matched_messages: { nope: true } },
      }),
    ).rejects.toBeInstanceOf(RestoreError);
  });

  it("inserts in dependency order and advances the sequences", async () => {
    // accounts insert, then messages insert; each returning one row.
    dbMock.enqueue([{ id: 1 }]);
    dbMock.enqueue([{ id: 5 }]);

    const result = await restoreBackup({
      version: BACKUP_VERSION,
      tables: {
        email_accounts: [
          { id: 1, emailAddress: "box@example.com", createdAt: "2026-10-30T00:00:00.000Z" },
        ],
        matched_messages: [messageRow({ id: 5 })],
      },
    });

    expect(result.restored.email_accounts).toBe(1);
    expect(result.restored.matched_messages).toBe(1);
    expect(result.restored.app_settings).toBe(0);
    expect(result.message).toMatch(/Restored 2 rows/);

    // Timestamps came back as Dates, which is what the insert needs.
    const [, firstValues] = dbMock.argsOf("values");
    const firstRow = (firstValues as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(firstRow["createdAt"]).toBeInstanceOf(Date);

    // Sequence fixups for the two tables that received rows.
    expect(dbMock.argsOf("execute")).toHaveLength(2);
  });

  it("reports an identical backup as nothing to restore", async () => {
    // Every insert conflicts: no ids come back.
    dbMock.enqueue([], []);

    const result = await restoreBackup({
      version: BACKUP_VERSION,
      tables: {
        email_accounts: [{ id: 1, emailAddress: "box@example.com" }],
        matched_messages: [messageRow()],
      },
    });

    expect(result.restored.email_accounts).toBe(0);
    expect(result.message).toMatch(/Nothing to restore/);
    // The sequences are still advanced past the ids the file mentions: even
    // though these rows already existed, a future insert must never collide
    // with an id the backup knows about.
    expect(dbMock.argsOf("execute")).toHaveLength(2);
  });
});
