import { beforeEach, describe, expect, it, vi } from "vitest";

// The pool is imported by @workspace/db; only execute is exercised here.
const dbMock = vi.hoisted(() => ({
  execute: vi.fn(async (_stmt: unknown) => undefined),
}));

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return {
    ...schema,
    db: dbMock,
    pool: { end: async () => undefined },
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { ensureSchema } = await import("./bootstrap-schema");

beforeEach(() => {
  dbMock.execute.mockClear();
  dbMock.execute.mockResolvedValue(undefined);
});

describe("ensureSchema", () => {
  it("runs one idempotent statement per additive column", async () => {
    await ensureSchema();

    expect(dbMock.execute).toHaveBeenCalledTimes(8);
    const statements = dbMock.execute.mock.calls.map((c) => String(c[0]));
    for (const statement of statements) {
      // Nothing here may ever drop or rewrite: a boot must not lose data.
      expect(statement).toMatch(/ADD COLUMN IF NOT EXISTS/);
      expect(statement).not.toMatch(/DROP|RENAME|ALTER COLUMN|TRUNCATE/i);
    }
  });

  it("covers every column the code queries", async () => {
    await ensureSchema();

    const joined = dbMock.execute.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain(`"email_accounts" ADD COLUMN IF NOT EXISTS "folder_marks"`);
    expect(joined).toContain(`"matched_messages" ADD COLUMN IF NOT EXISTS "folder"`);
    expect(joined).toContain(`"inbox_messages" ADD COLUMN IF NOT EXISTS "folder"`);
    expect(joined).toContain(`"app_settings" ADD COLUMN IF NOT EXISTS "critical_keywords"`);
    expect(joined).toContain(`"app_settings" ADD COLUMN IF NOT EXISTS "telegram_enabled"`);
    expect(joined).toContain(`"app_settings" ADD COLUMN IF NOT EXISTS "telegram_bot_token"`);
    expect(joined).toContain(`"app_settings" ADD COLUMN IF NOT EXISTS "telegram_chat_id"`);
    expect(joined).toContain(`"app_settings" ADD COLUMN IF NOT EXISTS "app_url"`);
  });

  it("gives a new column a default the old rows can live with", async () => {
    await ensureSchema();

    const folderStatement = dbMock.execute.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes(`"matched_messages" ADD COLUMN IF NOT EXISTS "folder"`));
    // Existing rows predate the column; they were all read from INBOX at the
    // time, so the default must say so rather than failing the constraint.
    expect(folderStatement).toContain(`NOT NULL DEFAULT 'INBOX'`);
  });

  it("throws on failure so the process exits instead of serving 500s", async () => {
    dbMock.execute.mockRejectedValueOnce(new Error("connection refused"));

    await expect(ensureSchema()).rejects.toThrow("connection refused");
  });
});
