import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The heartbeat runs inside a transaction, so the mock has to model
 * `db.transaction(cb)` handing a transaction object to the callback, and record
 * what was inserted and deleted on it.
 */
const dbMock = vi.hoisted(() => {
  interface Call {
    op: string;
    args: unknown[];
  }

  const calls: Call[] = [];
  /** Rows the next `.returning()` on an insert chain resolves to. */
  let insertReturning: unknown[] = [];
  /** Rows the next `.returning()` on a delete chain resolves to. */
  let deleteReturning: unknown[] = [];
  let failWith: Error | null = null;

  const chain = (kind: "insert" | "delete" | "select"): Record<string, unknown> => {
    const self: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "symbol") return undefined;
          if (prop === "then") {
            return (
              onFulfilled?: (v: unknown) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) => {
              if (failWith) {
                return Promise.reject(failWith).then(onFulfilled, onRejected);
              }
              const value =
                kind === "insert"
                  ? insertReturning
                  : kind === "delete"
                    ? deleteReturning
                    : insertReturning;
              return Promise.resolve(value).then(onFulfilled, onRejected);
            };
          }
          return (...args: unknown[]) => {
            calls.push({ op: `${kind}.${prop}`, args });
            return self;
          };
        },
      },
    ) as Record<string, unknown>;
    return self;
  };

  const tx = {
    insert: (...args: unknown[]) => {
      calls.push({ op: "insert", args });
      return chain("insert");
    },
    delete: (...args: unknown[]) => {
      calls.push({ op: "delete", args });
      return chain("delete");
    },
  };

  const db = {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => {
      calls.push({ op: "transaction", args: [] });
      if (failWith) throw failWith;
      return cb(tx);
    },
    select: (...args: unknown[]) => {
      calls.push({ op: "select", args });
      return chain("select");
    },
  };

  return {
    db,
    calls,
    setInsertReturning(rows: unknown[]) {
      insertReturning = rows;
    },
    setDeleteReturning(rows: unknown[]) {
      deleteReturning = rows;
    },
    fail(err: Error | null) {
      failWith = err;
    },
    reset() {
      calls.length = 0;
      insertReturning = [];
      deleteReturning = [];
      failWith = null;
    },
    opsCalled(): string[] {
      return calls.map((c) => c.op);
    },
    argsOf(op: string): unknown[] {
      const match = calls.find((c) => c.op === op);
      if (!match) throw new Error(`No call to "${op}"`);
      return match.args;
    },
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { ...schema, db: dbMock.db, pool: { end: async () => undefined } };
});

const loggerMock = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./logger", () => loggerMock);

const { beat, beatSafely, currentBeat, utcDayString } = await import(
  "./heartbeat"
);

beforeEach(() => {
  dbMock.reset();
  loggerMock.logger.error.mockClear();
  loggerMock.logger.info.mockClear();
});

describe("utcDayString", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(utcDayString(new Date("2026-03-07T13:45:00.000Z"))).toBe("2026-03-07");
  });

  it("uses UTC, not the host timezone", () => {
    // 23:30 UTC is already the next day in some zones and the previous day in
    // others; anchoring to UTC keeps the key stable wherever this runs.
    expect(utcDayString(new Date("2026-03-07T23:30:00.000Z"))).toBe("2026-03-07");
    expect(utcDayString(new Date("2026-03-08T00:30:00.000Z"))).toBe("2026-03-08");
  });

  it("handles a year boundary", () => {
    expect(utcDayString(new Date("2026-12-31T23:59:59.000Z"))).toBe("2026-12-31");
    expect(utcDayString(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01");
  });
});

describe("beat", () => {
  it("writes today's date", async () => {
    dbMock.setInsertReturning([{ day: "2026-03-07", isInsert: true }]);
    dbMock.setDeleteReturning([]);

    const result = await beat(new Date("2026-03-07T10:00:00.000Z"));

    expect(result.day).toBe("2026-03-07");
    expect(result.inserted).toBe(true);

    const [values] = dbMock.argsOf("insert.values") as [Record<string, unknown>];
    expect(values["day"]).toBe("2026-03-07");
  });

  it("erases every other day's row in the same pass", async () => {
    dbMock.setInsertReturning([{ day: "2026-03-08", isInsert: true }]);
    // Yesterday's row is removed as today's is written.
    dbMock.setDeleteReturning([{ day: "2026-03-07" }]);

    const result = await beat(new Date("2026-03-08T00:05:00.000Z"));

    expect(result.removed).toBe(1);
    expect(dbMock.opsCalled()).toContain("delete");
  });

  it("runs inside a transaction, so there is never a moment with no row", async () => {
    dbMock.setInsertReturning([{ day: "2026-03-07", isInsert: true }]);

    await beat(new Date("2026-03-07T10:00:00.000Z"));

    expect(dbMock.opsCalled()[0]).toBe("transaction");
  });

  it("touches an existing row rather than failing on the same day", async () => {
    // Second beat of the same day: the primary key conflicts, so it updates.
    dbMock.setInsertReturning([{ day: "2026-03-07", isInsert: false }]);
    dbMock.setDeleteReturning([]);

    const result = await beat(new Date("2026-03-07T18:00:00.000Z"));

    expect(result.inserted).toBe(false);
    expect(result.removed).toBe(0);
    expect(dbMock.opsCalled()).toContain("insert.onConflictDoUpdate");
  });

  it("still deletes other days on a same-day repeat", async () => {
    // A restart mid-day must not leave a stale previous day behind.
    dbMock.setInsertReturning([{ day: "2026-03-07", isInsert: false }]);
    dbMock.setDeleteReturning([{ day: "2026-03-05" }, { day: "2026-03-06" }]);

    const result = await beat(new Date("2026-03-07T18:00:00.000Z"));

    expect(result.removed).toBe(2);
  });

  it("propagates a database failure to the caller", async () => {
    dbMock.fail(new Error("connection terminated"));

    await expect(beat(new Date())).rejects.toThrow("connection terminated");
  });
});

describe("beatSafely", () => {
  it("logs a new day rather than staying silent", async () => {
    dbMock.setInsertReturning([{ day: "2026-03-07", isInsert: true }]);
    dbMock.setDeleteReturning([{ day: "2026-03-06" }]);

    await beatSafely(new Date("2026-03-07T00:01:00.000Z"));

    expect(loggerMock.logger.info).toHaveBeenCalled();
  });

  it("swallows a failure so the scheduler tick is not aborted", async () => {
    dbMock.fail(new Error("database paused"));

    // Must not throw: the next tick retries a minute or two later.
    await expect(beatSafely(new Date())).resolves.toBeUndefined();
    expect(loggerMock.logger.error).toHaveBeenCalled();
  });
});

describe("currentBeat", () => {
  it("returns the recorded day", async () => {
    dbMock.setInsertReturning([{ day: "2026-03-07" }]);

    await expect(currentBeat()).resolves.toBe("2026-03-07");
  });

  it("returns null before the first beat", async () => {
    dbMock.setInsertReturning([]);

    await expect(currentBeat()).resolves.toBeNull();
  });
});
