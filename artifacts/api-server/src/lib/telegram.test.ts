import { describe, expect, it } from "vitest";
import {
  buildCriticalMessages,
  chunkForTelegram,
  escapeTelegramHtml,
  telegramActive,
  type CriticalNotice,
} from "./telegram";

const notice: CriticalNotice = {
  subject: "Your <b>urgent</b> invoice",
  fromAddress: "billing@x.com",
  toAddress: "me@x.com",
  accountLabel: "Sales",
  accountEmail: "sales@x.com",
  folder: "INBOX",
  receivedAt: new Date("2026-10-29T21:00:00.000Z"),
  criticalHits: ["urgent", "$"],
  bodyText: "Please pay $50 now",
  bodyHtml: "",
};

describe("telegramActive", () => {
  it("requires the switch, a token, and a chat id", () => {
    expect(
      telegramActive({
        telegramEnabled: true,
        telegramBotToken: "tok",
        telegramChatId: "42",
      }),
    ).toBe(true);

    expect(
      telegramActive({
        telegramEnabled: false,
        telegramBotToken: "tok",
        telegramChatId: "42",
      }),
    ).toBe(false);

    expect(
      telegramActive({
        telegramEnabled: true,
        telegramBotToken: null,
        telegramChatId: "42",
      }),
    ).toBe(false);

    expect(
      telegramActive({
        telegramEnabled: true,
        telegramBotToken: "tok",
        telegramChatId: " ",
      }),
    ).toBe(false);
  });
});

describe("escapeTelegramHtml", () => {
  it("escapes the characters Telegram parses as markup", () => {
    expect(escapeTelegramHtml("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });

  it("leaves plain text untouched", () => {
    expect(escapeTelegramHtml("plain $50 — ok")).toBe("plain $50 — ok");
  });
});

describe("chunkForTelegram", () => {
  it("keeps short text as a single chunk", () => {
    expect(chunkForTelegram("short", 100)).toEqual(["short"]);
  });

  it("splits at whitespace and keeps every character", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const chunks = chunkForTelegram(text, 50);

    expect(chunks.length).toBeGreaterThan(1);
    // Nothing lost, nothing duplicated beyond the join spaces trimmed at the
    // cut points.
    expect(chunks.join(" ")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("hard-cuts a single unbreakable token longer than the limit", () => {
    const token = "x".repeat(120);
    const chunks = chunkForTelegram(token, 50);

    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
  });
});

describe("buildCriticalMessages", () => {
  it("carries the header fields and the text body", () => {
    const { first, rest } = buildCriticalMessages(notice, null);

    expect(rest).toEqual([]);
    // User text is escaped so an email cannot inject Telegram markup.
    expect(first).toContain("&lt;b&gt;");
    expect(first).toContain("billing@x.com");
    expect(first).toContain("Sales");
    expect(first).toContain("Please pay $50 now");
    expect(first).toContain("21:00");
    // The keyword hits are shown in code formatting.
    expect(first).toContain("<code>urgent</code>");
    expect(first).toContain("<code>$</code>");
  });

  it("stays within Telegram's message limit", () => {
    const long: CriticalNotice = {
      ...notice,
      bodyText: "line\n".repeat(3000),
    };

    const { first, rest } = buildCriticalMessages(long, null);

    expect(first.length).toBeLessThanOrEqual(4096);
    for (const chunk of rest) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    // The whole body still arrives.
    expect(first + rest.join("")).toContain("line");
  });

  it("renders an HTML-only email as text", () => {
    const htmlOnly: CriticalNotice = {
      ...notice,
      bodyText: "",
      bodyHtml: "<p>Claim your &#36;50 reward</p><p>Today only</p>",
    };

    const { first } = buildCriticalMessages(htmlOnly, null);

    expect(first).toContain("Claim your $50 reward");
    expect(first).toContain("Today only");
  });

  it("marks the folder when the match came from junk", () => {
    const junk: CriticalNotice = {
      ...notice,
      folder: "Junk",
    };

    const { first } = buildCriticalMessages(junk, null);

    expect(first).toContain("Sales (Junk)");
  });
});
