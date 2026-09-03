import { describe, expect, it } from "vitest";
import { deriveMailHost, distinctDomains, domainOf } from "./mail-host";

describe("domainOf", () => {
  it("extracts the domain", () => {
    expect(domainOf("paud1@andonosari.com")).toBe("andonosari.com");
  });

  it("lowercases the domain", () => {
    expect(domainOf("User@Example.COM")).toBe("example.com");
  });

  it("uses the last @, so a quoted local part does not break it", () => {
    expect(domainOf("odd@name@example.com")).toBe("example.com");
  });

  it("handles a multi-level domain", () => {
    expect(domainOf("vinay@andrewsgroup.co.in")).toBe("andrewsgroup.co.in");
  });

  it("trims surrounding whitespace", () => {
    expect(domainOf("  user@example.com  ")).toBe("example.com");
  });

  it("rejects an address with no @", () => {
    expect(domainOf("not-an-address")).toBeNull();
  });

  it("rejects an empty local part", () => {
    expect(domainOf("@example.com")).toBeNull();
  });

  it("rejects an empty domain", () => {
    expect(domainOf("user@")).toBeNull();
  });

  it("rejects a dotless domain, which cannot be a public mail domain", () => {
    expect(domainOf("user@localhost")).toBeNull();
  });

  it("rejects a domain containing whitespace", () => {
    expect(domainOf("user@exa mple.com")).toBeNull();
  });
});

describe("deriveMailHost", () => {
  it("prefixes the domain with mail.", () => {
    expect(deriveMailHost("paud1@andonosari.com")).toBe("mail.andonosari.com");
  });

  it("matches the MX convention for self-hosted domains", () => {
    // albadrmed.com's MX is mail.albadrmed.com, which is why this default works.
    expect(deriveMailHost("tamer.acc2@albadrmed.com")).toBe(
      "mail.albadrmed.com",
    );
  });

  it("does not double the prefix when the domain already starts with mail.", () => {
    expect(deriveMailHost("user@mail.example.com")).toBe("mail.example.com");
  });

  it("handles a multi-level domain", () => {
    expect(deriveMailHost("vinay@andrewsgroup.co.in")).toBe(
      "mail.andrewsgroup.co.in",
    );
  });

  it("returns null for an unusable address", () => {
    for (const bad of ["", "nope", "user@", "@example.com", "user@localhost"]) {
      expect(deriveMailHost(bad)).toBeNull();
    }
  });
});

describe("distinctDomains", () => {
  it("returns each domain once, in first-seen order", () => {
    expect(
      distinctDomains([
        "a@one.com",
        "b@two.com",
        "c@one.com",
        "d@three.com",
      ]),
    ).toEqual(["one.com", "two.com", "three.com"]);
  });

  it("treats differently-cased domains as one", () => {
    expect(distinctDomains(["a@One.com", "b@ONE.COM"])).toEqual(["one.com"]);
  });

  it("skips unusable addresses", () => {
    expect(distinctDomains(["good@example.com", "bad", "also@bad"])).toEqual([
      "example.com",
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(distinctDomains([])).toEqual([]);
  });
});
