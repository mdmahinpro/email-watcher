import { describe, expect, it } from "vitest";
import {
  INITIAL_SCAN_LIMIT,
  buildKeywordHaystack,
  capBody,
  findKeywordMatches,
  isJunkFolder,
  makeSnippet,
  mapWithConcurrency,
  resolveScanTargets,
  type MailboxProbe,
} from "./scan-planner";

describe("findKeywordMatches", () => {
  it("matches case-insensitively and reports the configured spelling", () => {
    expect(
      findKeywordMatches("Your eGIFT card is ready", ["eGift"]),
    ).toEqual(["eGift"]);
  });

  it("returns every distinct keyword that appears", () => {
    const hits = findKeywordMatches(
      "Claim your review bonus of $50",
      ["claim", "review", "$", "capterra"],
    );
    expect(hits.sort()).toEqual(["$", "claim", "review"]);
  });

  it("reports a keyword once even when it occurs repeatedly", () => {
    expect(findKeywordMatches("verify verify verify", ["verify"])).toEqual([
      "verify",
    ]);
  });

  it("matches substrings inside larger words", () => {
    // Documents current behaviour: matching is plain substring, not word-boundary.
    expect(findKeywordMatches("softwarereviews digest", ["review"])).toEqual([
      "review",
    ]);
  });

  it("ignores blank and whitespace-only keywords", () => {
    expect(findKeywordMatches("anything at all", ["", "   ", "\t"])).toEqual([]);
  });

  it("trims surrounding whitespace from configured keywords", () => {
    expect(findKeywordMatches("please claim it", ["  claim  "])).toEqual([
      "claim",
    ]);
  });

  it("returns nothing when no keyword is configured", () => {
    expect(findKeywordMatches("claim your $5 review", [])).toEqual([]);
  });

  it("returns nothing when no keyword is present", () => {
    expect(findKeywordMatches("ordinary newsletter", ["claim", "$"])).toEqual([]);
  });
});

describe("isJunkFolder", () => {
  it("recognizes the folder names providers actually use", () => {
    for (const path of [
      "Junk",
      "junk",
      "Spam",
      "spam",
      "Junk Mail",
      "junk e-mail",
      "Bulk Mail",
      "INBOX.Archive/Junk",
    ]) {
      expect(isJunkFolder(path)).toBe(true);
    }
  });

  it("leaves ordinary folders alone", () => {
    for (const path of ["INBOX", "Sent", "Trash", "Drafts", "Archive"]) {
      expect(isJunkFolder(path)).toBe(false);
    }
  });
});

describe("buildKeywordHaystack", () => {
  const parts = (over: Partial<Parameters<typeof buildKeywordHaystack>[0]>) => ({
    subject: "",
    from: "",
    to: "",
    text: "",
    html: "",
    ...over,
  });

  it("matches subject, sender, recipient, and text body", () => {
    const haystack = buildKeywordHaystack(
      parts({
        subject: "Your invoice",
        from: "billing@x.com",
        to: "me@x.com",
        text: "amount due today",
      }),
    );
    for (const kw of ["invoice", "billing", "me@x.com", "amount due"]) {
      expect(findKeywordMatches(haystack, [kw])).toEqual([kw]);
    }
  });

  it("includes the HTML part even when a text part exists", () => {
    // The two parts routinely disagree: the text part can be a short summary
    // while the keyword lives in the HTML. The old matcher read only the text.
    const haystack = buildKeywordHaystack(
      parts({
        text: "short plain summary",
        html: "<p>The secret word is capterra</p>",
      }),
    );
    expect(findKeywordMatches(haystack, ["capterra"])).toEqual(["capterra"]);
  });

  it("decodes HTML entities so a keyword split by one still matches", () => {
    const haystack = buildKeywordHaystack(
      parts({ html: "<p>Claim your &#36;50 and &amp; review</p>" }),
    );
    // Hits come back in the configured keyword order.
    expect(findKeywordMatches(haystack, ["$", "review", "&"])).toEqual([
      "$",
      "review",
      "&",
    ]);
  });

  it("matches keywords that appear only inside link and image targets", () => {
    const haystack = buildKeywordHaystack(
      parts({
        text: "no keyword here",
        html: '<a href="https://www.capterra.com/review">link text</a><img src="https://cdn.example/softwarereviews/x.png">',
      }),
    );
    expect(findKeywordMatches(haystack, ["capterra", "softwarereviews"])).toEqual(
      ["capterra", "softwarereviews"],
    );
  });

  it("ignores script and style content, which is not human-visible text", () => {
    const haystack = buildKeywordHaystack(
      parts({
        html: "<style>.review{color:red}</style><script>var claim = 1;</script><p>hello</p>",
      }),
    );
    expect(findKeywordMatches(haystack, ["review", "claim"])).toEqual([]);
  });

  it("handles a message with no HTML part at all", () => {
    const haystack = buildKeywordHaystack(
      parts({ subject: "s", text: "invoice body" }),
    );
    expect(findKeywordMatches(haystack, ["invoice"])).toEqual(["invoice"]);
  });
});

describe("makeSnippet", () => {
  it("collapses runs of whitespace into single spaces", () => {
    expect(makeSnippet("a\n\n  b\tc")).toBe("a b c");
  });

  it("keeps text shorter than the limit unchanged and untruncated", () => {
    expect(makeSnippet("short body", 320)).toBe("short body");
  });

  it("truncates to the limit and appends an ellipsis", () => {
    const result = makeSnippet("x".repeat(50), 10);
    expect(result).toBe(`${"x".repeat(10)}…`);
  });

  it("does not truncate text exactly at the limit", () => {
    expect(makeSnippet("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("capBody", () => {
  it("returns short bodies untouched", () => {
    expect(capBody("hello", 100)).toEqual({ value: "hello", truncated: false });
  });

  it("keeps a body exactly at the limit", () => {
    const body = "x".repeat(50);
    expect(capBody(body, 50)).toEqual({ value: body, truncated: false });
  });

  it("cuts at the limit and reports truncation", () => {
    const result = capBody("x".repeat(100), 40);
    expect(result.value).toHaveLength(40);
    expect(result.truncated).toBe(true);
  });

  it("preserves the body verbatim, unlike makeSnippet", () => {
    // No whitespace collapsing and no ellipsis: the result is rendered as the
    // message, and for HTML an injected character would land inside markup.
    const body = "<p>a\n\n  b</p>";
    expect(capBody(body, 1000).value).toBe(body);
    expect(capBody("x".repeat(10), 5).value).not.toContain("…");
  });

  it("handles an empty body", () => {
    expect(capBody("", 100)).toEqual({ value: "", truncated: false });
  });
});

/**
 * MailboxProbe stub that records queries and answers UID searches from a fixed
 * mailbox, including IMAP's open-ended-range behaviour: `N:*` matches the
 * highest existing UID even when N is past the end of the mailbox.
 */
function probe(options: {
  /** UIDs present in the mailbox, ascending. */
  mailbox?: number[];
  /** Overrides the reported message count; defaults to mailbox length. */
  messages?: number;
  /** Forces a specific search result regardless of the query. */
  searchResult?: number[] | false;
}): MailboxProbe & { queries: Array<{ seq: string } | { uid: string }> } {
  const mailbox = options.mailbox ?? [];
  const queries: Array<{ seq: string } | { uid: string }> = [];

  return {
    queries,
    async status() {
      return { messages: options.messages ?? mailbox.length };
    },
    async search(query) {
      queries.push(query);
      if (options.searchResult !== undefined) return options.searchResult;

      if ("uid" in query) {
        const [lowRaw] = query.uid.split(":");
        const low = Number(lowRaw);
        const matches = mailbox.filter((uid) => uid >= low);
        // RFC 3501 §6.4.8: an open-ended range still matches the highest UID.
        if (matches.length === 0 && mailbox.length > 0) {
          return [mailbox[mailbox.length - 1]!];
        }
        return matches;
      }

      const [fromRaw, toRaw] = query.seq.split(":");
      const from = Number(fromRaw);
      const to = toRaw === "*" ? mailbox.length : Number(toRaw);
      return mailbox.slice(from - 1, to);
    },
  };
}

describe("resolveScanTargets (incremental)", () => {
  it("returns only UIDs newer than the stored mark", async () => {
    const client = probe({ mailbox: [10, 11, 12, 13] });

    await expect(resolveScanTargets(client, 11)).resolves.toEqual({
      uids: [12, 13],
      baseline: 11,
    });
    expect(client.queries).toEqual([{ uid: "12:*" }]);
  });

  it("returns null on an idle mailbox instead of refetching the newest message", async () => {
    // The server answers 14:* with UID 13 because the range is open-ended.
    const client = probe({ mailbox: [10, 11, 12, 13] });

    await expect(resolveScanTargets(client, 13)).resolves.toBeNull();
  });

  it("returns sorted UIDs even when the server answers out of order", async () => {
    const client = probe({ mailbox: [], searchResult: [22, 20, 21] });

    await expect(resolveScanTargets(client, 19)).resolves.toEqual({
      uids: [20, 21, 22],
      baseline: 19,
    });
  });

  it("treats a zero mark as a real mark rather than a first scan", async () => {
    const client = probe({ mailbox: [1, 2] });

    await expect(resolveScanTargets(client, 0)).resolves.toEqual({
      uids: [1, 2],
      baseline: 0,
    });
    // No status() interrogation, and no seq search.
    expect(client.queries).toEqual([{ uid: "1:*" }]);
  });

  it("returns null when the incremental search finds nothing", async () => {
    const client = probe({ mailbox: [], searchResult: [] });

    await expect(resolveScanTargets(client, 5)).resolves.toBeNull();
  });

  it("returns null when the incremental search fails", async () => {
    const client = probe({ mailbox: [], searchResult: false });

    await expect(resolveScanTargets(client, 5)).resolves.toBeNull();
  });
});

describe("resolveScanTargets (first scan)", () => {
  it("limits the window to the newest INITIAL_SCAN_LIMIT messages", async () => {
    const mailbox = Array.from({ length: 1000 }, (_, i) => i + 1);
    const client = probe({ mailbox });

    const result = await resolveScanTargets(client, null);

    expect(result!.uids).toHaveLength(INITIAL_SCAN_LIMIT);
    expect(result!.uids[0]).toBe(951);
    expect(result!.uids.at(-1)).toBe(1000);
    expect(result!.baseline).toBe(950);
    expect(client.queries).toEqual([{ seq: "951:1000" }]);
  });

  it("starts at sequence 1 when the mailbox is smaller than the limit", async () => {
    const client = probe({ mailbox: [7, 8, 9] });

    await expect(resolveScanTargets(client, null)).resolves.toEqual({
      uids: [7, 8, 9],
      baseline: 6,
    });
    expect(client.queries).toEqual([{ seq: "1:3" }]);
  });

  it("anchors the baseline to the lowest UID regardless of result order", async () => {
    const client = probe({ messages: 3, searchResult: [9, 7, 8] });

    await expect(resolveScanTargets(client, null)).resolves.toEqual({
      uids: [7, 8, 9],
      baseline: 6,
    });
  });

  it("honours a custom limit", async () => {
    const mailbox = Array.from({ length: 100 }, (_, i) => i + 1);
    const client = probe({ mailbox });

    const result = await resolveScanTargets(client, null, 5);

    expect(result!.uids).toEqual([96, 97, 98, 99, 100]);
    expect(result!.baseline).toBe(95);
    expect(client.queries).toEqual([{ seq: "96:100" }]);
  });

  it("returns null for an empty mailbox", async () => {
    await expect(resolveScanTargets(probe({ messages: 0 }), null)).resolves.toBeNull();
  });

  it("returns null when the message count is unavailable", async () => {
    const client: MailboxProbe = {
      async status() {
        return {};
      },
      async search() {
        throw new Error("should not be called");
      },
    };
    await expect(resolveScanTargets(client, null)).resolves.toBeNull();
  });

  it("returns null when the seq search finds no UIDs", async () => {
    await expect(
      resolveScanTargets(probe({ messages: 5, searchResult: [] }), null),
    ).resolves.toBeNull();
  });

  it("returns null when the seq search fails", async () => {
    await expect(
      resolveScanTargets(probe({ messages: 5, searchResult: false }), null),
    ).resolves.toBeNull();
  });
});

describe("mapWithConcurrency", () => {
  it("processes every item", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
      },
    );
    expect(peak).toBe(3);
  });

  it("handles an empty list without invoking the worker", async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("handles a list smaller than the limit", async () => {
    const seen: string[] = [];
    await mapWithConcurrency(["a"], 8, async (s) => {
      seen.push(s);
    });
    expect(seen).toEqual(["a"]);
  });

  it("propagates a worker rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
