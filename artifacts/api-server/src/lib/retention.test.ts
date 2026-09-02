import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Records which tables were updated or deleted from, so a test can assert that
 * body-clearing and row-deletion hit the right tables with the right cutoff.
 */
const dbMock = vi.hoisted(() => {
  interface Call {
    op: string;
    table: string;
    args: unknown[];
  }

  const calls: Call[] = [];
  /** Row counts the next `.returning()` resolves to, keyed by call order. */
  const returning: unknown[][] = [];
  let sizeBytes: string | null = "12345678";
  let sizeThrows = false;

  const tableName = (table: unknown): string => {
    const sym = Object.getOwnPropertySymbols(table as object).find((s) =>
      s.toString().includes("Name"),
    );
    return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
  };

  const chain = (op: string, table: string): Record<string, unknown> => {
    const self: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "symbol") return undefined;
          if (prop === "then") {
            return (onFulfilled?: (v: unknown) => unknown) => {
              const rows = returning.length > 0 ? returning.shift()! : [];
              return Promise.resolve(rows).then(onFulfilled);
            };
          }
          return (...args: unknown[]) => {
            calls.push({ op: `${op}.${prop}`, table, args });
            return self;
          };
        },
      },
    ) as Record<string, unknown>;
    return self;
  };

  const db = {
    update: (table: unknown) => {
      const name = tableName(table);
      calls.push({ op: "update", table: name, args: [] });
      return chain("update", name);
    },
    delete: (table: unknown) => {
      const name = tableName(table);
      calls.push({ op: "delete", table: name, args: [] });
      return chain("delete", name);
    },
    execute: () => {
      if (sizeThrows) return Promise.reject(new Error("permission denied"));
      return Promise.resolve({ rows: [{ bytes: sizeBytes }] });
    },
  };

  return {
    db,
    calls,
    /** Queue the rows each successive `.returning()` yields. */
    queueReturning(...rowSets: unknown[][]) {
      returning.push(...rowSets);
    },
    setSize(bytes: string | null) {
      sizeBytes = bytes;
      sizeThrows = false;
    },
    makeSizeThrow() {
      sizeThrows = true;
    },
    reset() {
      calls.length = 0;
      returning.length = 0;
      sizeBytes = "12345678";
      sizeThrows = false;
    },
    tablesFor(op: string): string[] {
      return calls.filter((c) => c.op === op).map((c) => c.table);
    },
    countOf(op: string): number {
      return calls.filter((c) => c.op === op).length;
    },
    setArgs(): Array<Record<string, unknown>> {
      return calls
        .filter((c) => c.op === "update.set")
        .map((c) => c.args[0] as Record<string, unknown>);
    },
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { ...schema, db: dbMock.db, pool: { end: async () => undefined } };
});

const settingsMock = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({
    keywords: [] as string[],
    forwardToEmail: null as string | null,
    pollIntervalSeconds: 120,
    forwardingEnabled: false,
    retainBodiesDays: 0,
    retainMessagesDays: 0,
  })),
}));
vi.mock("./settings", () => settingsMock);

const loggerMock = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./logger", () => loggerMock);

const { applyRetention, applyRetentionSafely, databaseSizeBytes } = await import(
  "./retention"
);

function settings(overrides: Record<string, unknown> = {}) {
  return {
    keywords: [] as string[],
    forwardToEmail: null as string | null,
    pollIntervalSeconds: 120,
    forwardingEnabled: false,
    retainBodiesDays: 0,
    retainMessagesDays: 0,
    ...overrides,
  };
}

const NOW = new Date("2026-06-01T12:00:00.000Z");

beforeEach(() => {
  dbMock.reset();
  loggerMock.logger.warn.mockClear();
  loggerMock.logger.error.mockClear();
  settingsMock.getSettings.mockResolvedValue(settings());
});

describe("applyRetention", () => {
  it("does nothing when both windows are 0", async () => {
    // 0 means keep forever, and it is the default, so an upgrade must never
    // silently destroy data.
    const result = await applyRetention(NOW);

    expect(result).toEqual({ bodiesCleared: 0, rowsDeleted: 0 });
    expect(dbMock.countOf("update")).toBe(0);
    expect(dbMock.countOf("delete")).toBe(0);
  });

  it("clears bodies in both message tables when the body window is set", async () => {
    settingsMock.getSettings.mockResolvedValue(
      settings({ retainBodiesDays: 90 }),
    );
    dbMock.queueReturning([{ id: 1 }, { id: 2 }], [{ id: 3 }]);

    const result = await applyRetention(NOW);

    expect(result.bodiesCleared).toBe(3);
    expect(dbMock.tablesFor("update").sort()).toEqual([
      "inbox_messages",
      "matched_messages",
    ]);
    // Rows are kept; only the body columns are nulled.
    for (const set of dbMock.setArgs()) {
      expect(set).toEqual({ bodyText: null, bodyHtml: null });
    }
  });

  it("does not delete rows when only the body window is set", async () => {
    settingsMock.getSettings.mockResolvedValue(
      settings({ retainBodiesDays: 90 }),
    );
    dbMock.queueReturning([{ id: 1 }], []);

    await applyRetention(NOW);

    expect(dbMock.countOf("delete")).toBe(0);
  });

  it("deletes rows in both tables when the row window is set", async () => {
    settingsMock.getSettings.mockResolvedValue(
      settings({ retainMessagesDays: 365 }),
    );
    dbMock.queueReturning([{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }]);

    const result = await applyRetention(NOW);

    expect(result.rowsDeleted).toBe(4);
    expect(dbMock.tablesFor("delete").sort()).toEqual([
      "inbox_messages",
      "matched_messages",
    ]);
  });

  it("clears bodies before deleting rows when both are set", async () => {
    settingsMock.getSettings.mockResolvedValue(
      settings({ retainBodiesDays: 90, retainMessagesDays: 365 }),
    );
    dbMock.queueReturning([{ id: 1 }], [{ id: 2 }], [{ id: 3 }], [{ id: 4 }]);

    const result = await applyRetention(NOW);

    expect(result.bodiesCleared).toBe(2);
    expect(result.rowsDeleted).toBe(2);
    const ops = dbMock.calls
      .filter((c) => c.op === "update" || c.op === "delete")
      .map((c) => c.op);
    expect(ops.indexOf("update")).toBeLessThan(ops.indexOf("delete"));
  });

  it("only touches rows that still have a body, so a repeat run is cheap", async () => {
    settingsMock.getSettings.mockResolvedValue(
      settings({ retainBodiesDays: 30 }),
    );
    dbMock.queueReturning([], []);

    const result = await applyRetention(NOW);

    // The WHERE clause filters on body presence; a second pass finds nothing.
    expect(result.bodiesCleared).toBe(0);
    expect(dbMock.countOf("update.where")).toBe(2);
  });

  it("reports zero when nothing is old enough yet", async () => {
    settingsMock.getSettings.mockResolvedValue(
      settings({ retainBodiesDays: 365, retainMessagesDays: 730 }),
    );
    dbMock.queueReturning([], [], [], []);

    const result = await applyRetention(NOW);

    expect(result).toEqual({ bodiesCleared: 0, rowsDeleted: 0 });
  });
});

describe("applyRetentionSafely", () => {
  it("swallows a failure so the scheduler tick is not aborted", async () => {
    settingsMock.getSettings.mockRejectedValue(new Error("db unreachable"));

    await expect(applyRetentionSafely(NOW)).resolves.toBeUndefined();
    expect(loggerMock.logger.error).toHaveBeenCalled();
  });
});

describe("databaseSizeBytes", () => {
  it("returns the size as a number", async () => {
    dbMock.setSize("523456789");

    await expect(databaseSizeBytes()).resolves.toBe(523456789);
  });

  it("degrades to null when the host refuses the query", async () => {
    // A pooled connection may lack permission; the size display is
    // informational, so this must not fail the dashboard.
    dbMock.makeSizeThrow();

    await expect(databaseSizeBytes()).resolves.toBeNull();
    expect(loggerMock.logger.warn).toHaveBeenCalled();
  });

  it("returns null for an unusable value", async () => {
    dbMock.setSize(null);

    await expect(databaseSizeBytes()).resolves.toBeNull();
  });
});
