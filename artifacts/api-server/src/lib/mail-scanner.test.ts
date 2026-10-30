import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Records every insert so a test can assert which table a message landed in.
 *
 * `matched_messages` and `inbox_messages` are deliberately separate tables, and
 * the whole point of capture mode is choosing between them, so the mock keys
 * inserts by table name rather than flattening them.
 */
const dbMock = vi.hoisted(() => {
  const inserts: Array<{ table: string; values: unknown }> = [];
  const updates: Array<Record<string, unknown>> = [];

  const chain = (onValues: (values: unknown) => void) => {
    const self: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "symbol") return undefined;
          if (prop === "then") {
            return (onFulfilled?: (v: unknown) => unknown) =>
              // `.returning()` callers read `[0].id`.
              Promise.resolve([{ id: 1 }]).then(onFulfilled);
          }
          if (prop === "values") {
            return (values: unknown) => {
              onValues(values);
              return self;
            };
          }
          if (prop === "set") {
            return (values: Record<string, unknown>) => {
              updates.push(values);
              return self;
            };
          }
          return () => self;
        },
      },
    ) as Record<string, unknown>;
    return self;
  };

  const tableName = (table: unknown): string => {
    // Drizzle stores the SQL name on a well-known symbol.
    const sym = Object.getOwnPropertySymbols(table as object).find((s) =>
      s.toString().includes("Name"),
    );
    return sym
      ? String((table as Record<symbol, unknown>)[sym])
      : "unknown";
  };

  return {
    db: {
      insert: (table: unknown) => {
        const name = tableName(table);
        return chain((values) => inserts.push({ table: name, values }));
      },
      update: () => chain(() => undefined),
      select: () => chain(() => undefined),
      delete: () => chain(() => undefined),
    },
    inserts,
    updates,
    reset() {
      inserts.length = 0;
      updates.length = 0;
    },
    insertsInto(table: string) {
      return inserts
        .filter((i) => i.table === table)
        .map((i) => i.values as Record<string, unknown>);
    },
  };
});

/** One fake IMAP message per test scenario. */
interface FakeMessage {
  uid: number;
  subject: string;
  from: string;
  body: string;
  /** HTML part, when the scenario needs one. */
  html?: string;
}

const imapMock = vi.hoisted(() => {
  interface FolderState {
    path: string;
    messages: FakeMessage[];
  }
  const state: { folders: FolderState[]; current: string } = {
    folders: [],
    current: "INBOX",
  };

  class FakeImapFlow {
    on() {
      return this;
    }
    async connect() {}
    async logout() {}
    async list() {
      return state.folders.map((f) => ({ path: f.path }));
    }
    async getMailboxLock(path: string) {
      state.current = path;
      return { release: () => undefined };
    }
    async status() {
      return {
        messages:
          state.folders.find((f) => f.path === state.current)?.messages.length ??
          0,
      };
    }
    async search() {
      return (
        state.folders.find((f) => f.path === state.current)?.messages.map(
          (m) => m.uid,
        ) ?? []
      );
    }
    async *fetch() {
      for (const m of state.folders.find((f) => f.path === state.current)
        ?.messages ?? []) {
        yield {
          uid: m.uid,
          // The scanner reads the parsed message, not the envelope, when source
          // is present; source only has to be a Buffer.
          source: Buffer.from(`raw-${m.uid}`),
          envelope: { from: [{ address: m.from }], to: [{ address: "to@x" }] },
          internalDate: new Date("2026-02-01T00:00:00.000Z"),
        };
      }
    }
  }

  return { FakeImapFlow, state };
});

const parserMock = vi.hoisted(() => ({
  simpleParser: vi.fn(async (buf: Buffer) => {
    const uid = Number(buf.toString().replace("raw-", ""));
    const msg = imapMock.state.folders
      .flatMap((f) => f.messages)
      .find((m) => m.uid === uid)!;
    return {
      subject: msg.subject,
      text: msg.body,
      html: msg.html ?? "",
      from: { text: msg.from },
      to: { text: "to@example.com" },
      date: new Date("2026-02-01T00:00:00.000Z"),
      messageId: `<${uid}@example.com>`,
    };
  }),
}));

const sendMail = vi.hoisted(() => vi.fn(async () => undefined));
import type { CriticalNotice } from "./telegram";
const settingsMock = vi.hoisted(() => {
  // Partial so a test can override just the fields its scenario needs.
  type MockSettings = Partial<{
    keywords: string[];
    criticalKeywords: string[];
    forwardToEmail: string | null;
    pollIntervalSeconds: number;
    forwardingEnabled: boolean;
    telegramEnabled: boolean;
    telegramBotToken: string | null;
    telegramChatId: string | null;
    appUrl: string | null;
  }>;
  return {
    getSettings: vi.fn(
      async (): Promise<MockSettings> => ({
        keywords: ["invoice"],
        criticalKeywords: [],
        forwardToEmail: "central@example.com",
        pollIntervalSeconds: 120,
        forwardingEnabled: true,
        telegramEnabled: false,
        telegramBotToken: null,
        telegramChatId: null,
        appUrl: null,
      }),
    ),
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { ...schema, db: dbMock.db, pool: { end: async () => undefined } };
});
vi.mock("imapflow", () => ({ ImapFlow: imapMock.FakeImapFlow }));
vi.mock("mailparser", () => parserMock);
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail, close: () => undefined }),
  },
}));
vi.mock("./settings", () => settingsMock);

// Telegram pushes open real network sockets; the scanner only needs to know
// that a push was attempted and what it was asked to send.
const telegramMock = vi.hoisted(() => ({
  telegramActive: vi.fn(
    (c: {
      telegramEnabled?: boolean | undefined;
      telegramBotToken?: string | null | undefined;
      telegramChatId?: string | null | undefined;
    }) =>
      Boolean(
        c.telegramEnabled &&
          c.telegramBotToken &&
          c.telegramChatId?.trim?.(),
      ),
  ),
  sendCriticalNotice: vi.fn(
    async (
      _config: unknown,
      _notice: unknown,
      _viewUrl: string | null,
    ): Promise<{ ok: boolean }> => ({ ok: true }),
  ),
}));
vi.mock("./telegram", () => telegramMock);

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { scanAccount } = await import("./mail-scanner");

const NOW = new Date("2026-02-01T00:00:00.000Z");

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    label: "Mailbox",
    emailAddress: "box@example.com",
    provider: "generic",
    captureMode: "keywords",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    username: "box@example.com",
    password: "pw",
    active: true,
    // Non-null so the scan takes the incremental path and skips the first-scan
    // window calculation.
    lastUidSeen: 0,
    folderMarks: null,
    lastCheckedAt: NOW,
    lastError: null,
    deletedAt: null,
    createdAt: NOW,
    ...overrides,
  } as Parameters<typeof scanAccount>[0];
}

beforeEach(() => {
  dbMock.reset();
  sendMail.mockClear();
  telegramMock.sendCriticalNotice.mockClear();
  telegramMock.telegramActive.mockClear();
  imapMock.state.current = "INBOX";
  imapMock.state.folders = [
    {
      path: "INBOX",
      messages: [
        { uid: 1, subject: "Your invoice is ready", from: "billing@x.com", body: "hi" },
        { uid: 2, subject: "Weekly newsletter", from: "news@x.com", body: "stuff" },
        { uid: 3, subject: "Lunch?", from: "friend@x.com", body: "free at 12" },
      ],
    },
  ];
});

describe("captureMode: keywords", () => {
  it("stores only keyword matches, into matched_messages", async () => {
    const result = await scanAccount(account({ captureMode: "keywords" }));

    expect(result.scanned).toBe(3);
    expect(result.matched).toBe(1);
    expect(result.archived).toBe(0);

    const matched = dbMock.insertsInto("matched_messages");
    expect(matched).toHaveLength(1);
    expect(matched[0]!["subject"]).toBe("Your invoice is ready");
    expect(matched[0]!["matchedKeywords"]).toEqual(["invoice"]);
    // Nothing should reach the archive in this mode.
    expect(dbMock.insertsInto("inbox_messages")).toHaveLength(0);
  });

  it("forwards the matches", async () => {
    await scanAccount(account({ captureMode: "keywords" }));

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("reports counts in the summary message", async () => {
    const result = await scanAccount(account({ captureMode: "keywords" }));

    expect(result.message).toBe("Scanned 3, matched 1, forwarded 1.");
  });
});

describe("captureMode: all", () => {
  it("archives every message, into inbox_messages", async () => {
    const result = await scanAccount(account({ captureMode: "all" }));

    expect(result.scanned).toBe(3);
    expect(result.archived).toBe(3);

    const archived = dbMock.insertsInto("inbox_messages");
    expect(archived).toHaveLength(3);
    expect(archived.map((r) => r["subject"])).toEqual([
      "Your invoice is ready",
      "Weekly newsletter",
      "Lunch?",
    ]);
    // The archive mailbox never writes into the triage queue: the Messages
    // tab is the webmail view, and an `all` mailbox's listing is the Hostinger
    // Inbox tab. Even a keyword hit (the invoice) stays out of it.
    expect(result.matched).toBe(0);
    expect(dbMock.insertsInto("matched_messages")).toHaveLength(0);
  });

  it("puts nothing in the triage queue, even for a keyword hit", async () => {
    await scanAccount(account({ captureMode: "all" }));

    const archived = dbMock.insertsInto("inbox_messages");
    const invoiceRow = archived.find(
      (r) => r["subject"] === "Your invoice is ready",
    );
    expect(invoiceRow).toBeDefined();
    // Archive rows carry no keyword or forwarding columns at all.
    expect(invoiceRow).not.toHaveProperty("matchedKeywords");
    expect(invoiceRow).not.toHaveProperty("forwarded");
    expect(dbMock.insertsInto("matched_messages")).toHaveLength(0);
  });

  it("never forwards", async () => {
    // Forwarding is enabled in settings; capture mode must still suppress it,
    // because relaying every arriving email invites a mail loop.
    const result = await scanAccount(account({ captureMode: "all" }));

    expect(sendMail).not.toHaveBeenCalled();
    expect(result.forwarded).toBe(0);
  });

  it("archives even when no keywords are configured", async () => {
    settingsMock.getSettings.mockResolvedValueOnce({
      keywords: [],
      forwardToEmail: null,
      pollIntervalSeconds: 120,
      forwardingEnabled: false,
    });

    const result = await scanAccount(account({ captureMode: "all" }));

    expect(result.archived).toBe(3);
  });

  it("snapshots the account label and address onto each row", async () => {
    await scanAccount(
      account({
        captureMode: "all",
        label: "Sales",
        emailAddress: "sales@mydomain.com",
      }),
    );

    for (const row of dbMock.insertsInto("inbox_messages")) {
      expect(row["accountLabelSnapshot"]).toBe("Sales");
      expect(row["accountEmailSnapshot"]).toBe("sales@mydomain.com");
    }
  });

  it("reports archived counts in the summary message", async () => {
    const result = await scanAccount(account({ captureMode: "all" }));

    expect(result.message).toBe("Scanned 3, archived 3.");
  });

  it("reports nothing to do on an idle mailbox", async () => {
    imapMock.state.folders = [{ path: "INBOX", messages: [] }];

    const result = await scanAccount(account({ captureMode: "all" }));

    expect(result.message).toBe("No new messages.");
    expect(result.archived).toBe(0);
    expect(dbMock.insertsInto("inbox_messages")).toHaveLength(0);
  });
});

describe("full body storage", () => {
  it("stores the complete text body, not just the snippet", async () => {
    // Long enough that the 320-character snippet would lose most of it — the
    // reported bug was a snippet being shown as though it were the whole email.
    const longBody = `Amount: $60.00 ${"detail ".repeat(200)}end-marker`;
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "Reward", from: "a@x.com", body: longBody },
    ] }];

    await scanAccount(account({ captureMode: "all" }));

    const [row] = dbMock.insertsInto("inbox_messages");
    expect(row!["bodyText"]).toBe(longBody);
    // The snippet stays short for list rendering.
    expect((row!["snippet"] as string).length).toBeLessThanOrEqual(321);
    expect(row!["bodyTruncated"]).toBe(false);
  });

  it("stores the HTML part alongside the text part", async () => {
    imapMock.state.folders = [{ path: "INBOX", messages: [
      {
        uid: 1,
        subject: "Newsletter",
        from: "a@x.com",
        body: "plain version",
        html: "<h1>Rich</h1><p>version</p>",
      },
    ] }];

    await scanAccount(account({ captureMode: "all" }));

    const [row] = dbMock.insertsInto("inbox_messages");
    expect(row!["bodyText"]).toBe("plain version");
    expect(row!["bodyHtml"]).toBe("<h1>Rich</h1><p>version</p>");
  });

  it("stores bodies for keyword matches too", async () => {
    imapMock.state.folders = [{ path: "INBOX", messages: [
      {
        uid: 1,
        subject: "Your invoice",
        from: "a@x.com",
        body: "full invoice text here",
        html: "<p>full invoice</p>",
      },
    ] }];

    await scanAccount(account({ captureMode: "keywords" }));

    const [row] = dbMock.insertsInto("matched_messages");
    expect(row!["bodyText"]).toBe("full invoice text here");
    expect(row!["bodyHtml"]).toBe("<p>full invoice</p>");
  });

  it("caps an oversized text body and flags the truncation", async () => {
    // 200 KB of text against a 128 KB cap.
    const huge = "x".repeat(200 * 1024);
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "Huge", from: "a@x.com", body: huge },
    ] }];

    await scanAccount(account({ captureMode: "all" }));

    const [row] = dbMock.insertsInto("inbox_messages");
    expect((row!["bodyText"] as string).length).toBe(128 * 1024);
    expect(row!["bodyTruncated"]).toBe(true);
  });

  it("caps an oversized HTML body and flags the truncation", async () => {
    // 600 KB of HTML against a 512 KB cap — an email with inline base64 images.
    const huge = "<p>" + "y".repeat(600 * 1024);
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "Huge", from: "a@x.com", body: "short", html: huge },
    ] }];

    await scanAccount(account({ captureMode: "all" }));

    const [row] = dbMock.insertsInto("inbox_messages");
    expect((row!["bodyHtml"] as string).length).toBe(512 * 1024);
    expect(row!["bodyText"]).toBe("short");
    expect(row!["bodyTruncated"]).toBe(true);
  });

  it("stores null rather than an empty string for a missing part", async () => {
    // An HTML-only email has no text part; null distinguishes "absent" from
    // "present but empty" for the viewer's mode switching.
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "HTML only", from: "a@x.com", body: "", html: "<p>hi</p>" },
    ] }];

    await scanAccount(account({ captureMode: "all" }));

    const [row] = dbMock.insertsInto("inbox_messages");
    expect(row!["bodyText"]).toBeNull();
    expect(row!["bodyHtml"]).toBe("<p>hi</p>");
  });

  it("stores email HTML verbatim, without attempting to sanitize it", async () => {
    // Sanitization is the renderer's job: the viewer loads this into a sandboxed
    // iframe with no allow-scripts and a restrictive CSP. Stripping tags here
    // would corrupt the archive while providing weaker protection.
    const hostile = '<script>alert(1)</script><img src="http://tracker/x.gif">';
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "Hostile", from: "a@x.com", body: "t", html: hostile },
    ]}];

    await scanAccount(account({ captureMode: "all" }));

    const [row] = dbMock.insertsInto("inbox_messages");
    expect(row!["bodyHtml"]).toBe(hostile);
  });
});

describe("junk folder scanning", () => {
  it("scans the junk folder and qualifies its message uids by folder", async () => {
    imapMock.state.folders = [
      {
        path: "INBOX",
        messages: [
          { uid: 1, subject: "Lunch?", from: "friend@x.com", body: "hi" },
        ],
      },
      {
        path: "Junk",
        messages: [
          {
            uid: 7,
            subject: "Your invoice from the promo desk",
            from: "promo@x.com",
            body: "open me",
          },
        ],
      },
    ];

    const result = await scanAccount(account({ captureMode: "keywords" }));

    expect(result.scanned).toBe(2);
    // The invoice keyword only occurs in the junk copy, so without reading
    // that folder this scan would have found nothing.
    expect(result.matched).toBe(1);

    const matched = dbMock.insertsInto("matched_messages");
    expect(matched).toHaveLength(1);
    expect(matched[0]!["folder"]).toBe("Junk");
    // UIDs are only unique per folder, so a non-INBOX row carries the folder
    // in its key; an INBOX row keeps the bare uid for backward compatibility.
    expect(matched[0]!["messageUid"]).toBe("Junk:7");
  });

  it("records the folder on archived rows too", async () => {
    imapMock.state.folders = [
      {
        path: "INBOX",
        messages: [{ uid: 2, subject: "A", from: "a@x.com", body: "x" }],
      },
      {
        path: "Spam",
        messages: [{ uid: 9, subject: "B", from: "b@x.com", body: "y" }],
      },
    ];

    await scanAccount(account({ captureMode: "all" }));

    const archived = dbMock.insertsInto("inbox_messages");
    expect(archived.map((r) => r["folder"])).toEqual(["INBOX", "Spam"]);
  });

  it("ignores ordinary folders like Sent and Trash", async () => {
    imapMock.state.folders = [
      { path: "INBOX", messages: [] },
      { path: "Sent", messages: [{ uid: 5, subject: "S", from: "me@x.com", body: "sent" }] },
      { path: "Trash", messages: [{ uid: 6, subject: "T", from: "me@x.com", body: "gone" }] },
    ];

    const result = await scanAccount(account({ captureMode: "all" }));

    expect(result.scanned).toBe(0);
    expect(result.message).toBe("No new messages.");
  });
});

describe("keyword matching breadth", () => {
  it("matches a keyword that appears only inside an HTML link target", async () => {
    // The plain-text part never names the review platform; the keyword lives
    // in the href. The old matcher, which read only the text part, missed this.
    settingsMock.getSettings.mockResolvedValueOnce({
      keywords: ["capterra"],
      forwardToEmail: "central@example.com",
      pollIntervalSeconds: 120,
      forwardingEnabled: false,
    });
    imapMock.state.folders = [{ path: "INBOX", messages: [
      {
        uid: 1,
        subject: "Weekly digest",
        from: "news@x.com",
        body: "plain part with no keyword at all",
        html: '<p>See <a href="https://www.capterra.com/reviews/123">the page</a></p>',
      },
    ]}];

    const result = await scanAccount(account({ captureMode: "keywords" }));

    expect(result.matched).toBe(1);
    const [row] = dbMock.insertsInto("matched_messages");
    expect(row!["matchedKeywords"]).toEqual(["capterra"]);
  });

  it("matches a keyword encoded as an HTML entity in the HTML part", async () => {
    settingsMock.getSettings.mockResolvedValueOnce({
      keywords: ["$"],
      forwardToEmail: "central@example.com",
      pollIntervalSeconds: 120,
      forwardingEnabled: false,
    });
    imapMock.state.folders = [{ path: "INBOX", messages: [
      {
        uid: 1,
        subject: "Your reward",
        from: "news@x.com",
        body: "",
        html: "<p>Get your &#36;50 gift card</p>",
      },
    ]}];

    const result = await scanAccount(account({ captureMode: "keywords" }));

    expect(result.matched).toBe(1);
  });
});

describe("critical keywords and Telegram", () => {
  const telegramSettings = {
    keywords: ["invoice"],
    criticalKeywords: ["urgent"],
    telegramEnabled: true,
    telegramBotToken: "token",
    telegramChatId: "42",
    appUrl: "https://watcher.example.com",
    forwardToEmail: "central@example.com",
    pollIntervalSeconds: 120,
    forwardingEnabled: false,
  };

  it("pushes one Telegram notice for a critical hit", async () => {
    settingsMock.getSettings.mockResolvedValueOnce(telegramSettings);
    imapMock.state.folders = [{ path: "INBOX", messages: [
      {
        uid: 1,
        subject: "Urgent invoice needed",
        from: "billing@x.com",
        body: "the urgent invoice text",
      },
    ]}];

    const result = await scanAccount(account({ captureMode: "keywords" }));

    // A critical hit is also a regular match: listed like any keyword.
    expect(result.matched).toBe(1);
    expect(result.notified).toBe(1);
    expect(result.message).toContain("Notified 1 via Telegram.");

    expect(telegramMock.sendCriticalNotice).toHaveBeenCalledTimes(1);
    const [call] = telegramMock.sendCriticalNotice.mock.calls;
    const notice = call?.[1] as CriticalNotice & { kind: string };
    const viewUrl = call?.[2] as string | null;
    expect(notice.criticalHits).toEqual(["urgent"]);
    expect(notice.subject).toBe("Urgent invoice needed");
    expect(notice.accountLabel).toBe("Mailbox");
    // The button links to a signed, unguessable path for exactly this row.
    expect(viewUrl).toMatch(/^https:\/\/watcher\.example\.com\/view\/v1\.matched\.1\./);
  });

  it("pushes a critical hit from an `all` mailbox but lists nothing", async () => {
    settingsMock.getSettings.mockResolvedValueOnce(telegramSettings);
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "Urgent reward claim", from: "promo@x.com", body: "go" },
      { uid: 2, subject: "Newsletter", from: "news@x.com", body: "weekly" },
    ]}];

    const result = await scanAccount(account({ captureMode: "all" }));

    // Archived everything, pushed the one critical hit, listed nothing in the
    // triage queue, forwarded nothing — the webmail/archive separation holds
    // even for critical mail.
    expect(result.archived).toBe(2);
    expect(result.matched).toBe(0);
    expect(result.notified).toBe(1);
    expect(result.forwarded).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(dbMock.insertsInto("matched_messages")).toHaveLength(0);

    // The notice links to the archived row's web view — an `all` mailbox has
    // no triage row to link to.
    const [call] = telegramMock.sendCriticalNotice.mock.calls;
    const notice = call?.[1] as CriticalNotice & { kind: string; rowId: number };
    const viewUrl = call?.[2] as string | null;
    expect(notice.kind).toBe("inbox");
    expect(notice.criticalHits).toEqual(["urgent"]);
    expect(viewUrl).toMatch(/^https:\/\/watcher\.example\.com\/view\/v1\.inbox\.1\./);
  });

  it("does not push when only a regular keyword hits", async () => {
    settingsMock.getSettings.mockResolvedValueOnce(telegramSettings);
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "Your invoice", from: "billing@x.com", body: "plain" },
    ]}];

    const result = await scanAccount(account({ captureMode: "keywords" }));

    expect(result.matched).toBe(1);
    expect(result.notified).toBe(0);
    expect(telegramMock.sendCriticalNotice).not.toHaveBeenCalled();
  });

  it("stays quiet when Telegram is not configured", async () => {
    settingsMock.getSettings.mockResolvedValueOnce({
      ...telegramSettings,
      telegramEnabled: false,
    });
    imapMock.state.folders = [{ path: "INBOX", messages: [
      { uid: 1, subject: "Urgent invoice", from: "billing@x.com", body: "urgent" },
    ]}];

    const result = await scanAccount(account({ captureMode: "keywords" }));

    // The match is still stored and listed — only the push is suppressed.
    expect(result.matched).toBe(1);
    expect(result.notified).toBe(0);
    expect(telegramMock.sendCriticalNotice).not.toHaveBeenCalled();
  });
});
