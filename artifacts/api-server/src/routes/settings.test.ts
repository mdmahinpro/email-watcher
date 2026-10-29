import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authedRequest } from "../test-support/authed";

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
    argsOf(op: string): unknown[] {
      const matches = calls.filter((c) => c.op === op);
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one "${op}" call, saw ${matches.length}`);
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

// Retention would touch the db mock with raw SQL shapes these tests never
// enqueue; it is exercised by its own test file.
vi.mock("../lib/retention", () => ({
  applyRetentionSafely: vi.fn(async () => undefined),
}));

const telegramLibMock = vi.hoisted(() => ({
  sendTelegramTestMessage: vi.fn(
    async (
      _config: unknown,
    ): Promise<{ ok: boolean; message: string }> => ({
      ok: true,
      message: "Test message delivered.",
    }),
  ),
  telegramActive: vi.fn(() => true),
}));

vi.mock("../lib/telegram", () => telegramLibMock);

const { default: app } = await import("../app");

let request: Awaited<ReturnType<typeof authedRequest>>;

beforeAll(async () => {
  request = await authedRequest(app);
});

const NOW = new Date("2026-10-29T22:00:00.000Z");

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    keywords: ["invoice"],
    criticalKeywords: ["urgent"],
    forwardToEmail: null,
    pollIntervalSeconds: 120,
    forwardingEnabled: true,
    telegramEnabled: false,
    telegramBotToken: "stored-token",
    telegramChatId: null,
    appUrl: null,
    retainBodiesDays: 0,
    retainMessagesDays: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.reset();
  telegramLibMock.sendTelegramTestMessage.mockClear();
  telegramLibMock.telegramActive.mockClear();
});

describe("GET /api/settings", () => {
  it("returns the settings with a token-present flag instead of the token", async () => {
    dbMock.enqueue([settingsRow()]);

    const res = await request.get("/api/settings");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      keywords: ["invoice"],
      criticalKeywords: ["urgent"],
      telegramBotTokenSet: true,
      telegramEnabled: false,
    });
    // The bot token is a secret; it must never appear in a response.
    expect(JSON.stringify(res.body)).not.toContain("stored-token");
  });
});

describe("PUT /api/settings", () => {
  it("keeps the stored token when the request omits it", async () => {
    dbMock.enqueue([settingsRow()], [settingsRow()], [settingsRow()]);

    const res = await request.put("/api/settings").send({
      pollIntervalSeconds: 120,
      criticalKeywords: ["urgent"],
    });

    expect(res.status).toBe(200);
    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch["telegramBotToken"]).toBe("stored-token");
  });

  it("replaces the token when a new one is sent", async () => {
    dbMock.enqueue([settingsRow()], [settingsRow()], [settingsRow()]);

    await request.put("/api/settings").send({
      telegramBotToken: "new-token",
    });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch["telegramBotToken"]).toBe("new-token");
  });

  it("clears the token on an empty string", async () => {
    dbMock.enqueue([settingsRow()], [settingsRow()], [settingsRow()]);

    await request.put("/api/settings").send({
      telegramBotToken: "",
    });

    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch["telegramBotToken"]).toBeNull();
  });

  it("stores the critical keywords and Telegram configuration", async () => {
    dbMock.enqueue([settingsRow()], [settingsRow()], [settingsRow()]);

    const res = await request.put("/api/settings").send({
      criticalKeywords: ["urgent", "claim"],
      telegramEnabled: true,
      telegramChatId: "4211",
      appUrl: "https://watcher.example.com",
    });

    expect(res.status).toBe(200);
    const [patch] = dbMock.argsOf("set") as [Record<string, unknown>];
    expect(patch["criticalKeywords"]).toEqual(["urgent", "claim"]);
    expect(patch["telegramEnabled"]).toBe(true);
    expect(patch["telegramChatId"]).toBe("4211");
    expect(patch["appUrl"]).toBe("https://watcher.example.com");
  });
});

describe("POST /api/settings/telegram-test", () => {
  it("delivers with the stored configuration and reports the outcome", async () => {
    dbMock.enqueue([settingsRow({ telegramEnabled: true, telegramChatId: "42" })]);

    const res = await request.post("/api/settings/telegram-test");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, message: "Test message delivered." });
    const [config] = telegramLibMock.sendTelegramTestMessage.mock.calls[0]!;
    expect(config).toMatchObject({
      telegramEnabled: true,
      telegramBotToken: "stored-token",
      telegramChatId: "42",
    });
  });

  it("explains what is missing when the configuration is incomplete", async () => {
    telegramLibMock.sendTelegramTestMessage.mockResolvedValueOnce({
      ok: false,
      message:
        "Telegram is not fully configured: enable it and fill in the bot " +
        "token and chat id first.",
    });
    dbMock.enqueue([settingsRow({ telegramBotToken: null })]);

    const res = await request.post("/api/settings/telegram-test");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.message).toMatch(/bot token/i);
  });
});
