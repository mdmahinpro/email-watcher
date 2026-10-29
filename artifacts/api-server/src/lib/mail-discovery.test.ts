import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveMx = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  default: { resolveMx },
}));

const { imapCandidates, smtpCandidates, mxHostsFor } = await import(
  "./mail-discovery"
);

beforeEach(() => {
  resolveMx.mockReset();
});

describe("mxHostsFor", () => {
  it("returns MX hosts ordered by priority", async () => {
    resolveMx.mockResolvedValue([
      { priority: 20, exchange: "mx2.example.com" },
      { priority: 10, exchange: "mx1.example.com" },
    ]);

    await expect(mxHostsFor("example.com")).resolves.toEqual([
      "mx1.example.com",
      "mx2.example.com",
    ]);
  });

  it("drops the null MX marker", async () => {
    resolveMx.mockResolvedValue([{ priority: 0, exchange: "." }]);

    await expect(mxHostsFor("example.com")).resolves.toEqual([]);
  });

  it("returns an empty list rather than throwing when DNS fails", async () => {
    resolveMx.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(mxHostsFor("no-such.example")).resolves.toEqual([]);
  });
});

describe("imapCandidates", () => {
  it("tries the conventional names before the MX hosts", () => {
    expect(imapCandidates("example.com", ["mx1.example.com"])).toEqual([
      "mail.example.com",
      "imap.example.com",
      "example.com",
      "mx1.example.com",
    ]);
  });

  it("does not double a mail. prefix", () => {
    expect(imapCandidates("mail.example.com")[0]).toBe("mail.example.com");
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(
      imapCandidates("example.com", ["Mail.Example.com", "mail.example.com"]),
    ).toEqual(["mail.example.com", "imap.example.com", "example.com"]);
  });
});

describe("smtpCandidates", () => {
  it("tries smtp. before the MX hosts", () => {
    expect(smtpCandidates("example.com", ["mx1.example.com"])).toEqual([
      "mail.example.com",
      "smtp.example.com",
      "example.com",
      "mx1.example.com",
    ]);
  });
});
