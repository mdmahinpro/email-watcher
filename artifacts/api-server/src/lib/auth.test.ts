import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  generateSessionSecret,
  hashPassword,
  loadAuthConfig,
  verifyPassword,
  verifySessionToken,
} from "./auth";

const SECRET = "a".repeat(48);
const OTHER_SECRET = "b".repeat(48);

describe("hashPassword / verifyPassword", () => {
  it("accepts the correct password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("Correct horse battery staple", hash)).toBe(false);
    expect(verifyPassword("", hash)).toBe(false);
    expect(verifyPassword("correct horse battery stapl", hash)).toBe(false);
  });

  it("salts each hash, so the same password hashes differently", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    // Both must still verify.
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });

  it("stores the cost parameters alongside the hash", () => {
    const hash = hashPassword("pw");
    const [scheme, N, r, p] = hash.split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(N)).toBe(65536);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it("never stores the plaintext", () => {
    const hash = hashPassword("super-secret-value");
    expect(hash).not.toContain("super-secret-value");
  });

  it("handles unicode and long passwords", () => {
    const password = "パスワード🔐" + "x".repeat(300);
    const hash = hashPassword(password);
    expect(verifyPassword(password, hash)).toBe(true);
  });

  it("rejects malformed stored hashes rather than throwing", () => {
    for (const bad of [
      "",
      "not-a-hash",
      "scrypt$1$2$3",
      "bcrypt$65536$8$1$aa$bb",
      "scrypt$x$8$1$aa$bb",
      "scrypt$65536$8$1$$bb",
      "scrypt$65536$8$1$aa$",
    ]) {
      expect(verifyPassword("pw", bad)).toBe(false);
    }
  });
});

describe("session tokens", () => {
  const passwordHash = hashPassword("pw");

  it("verifies a freshly minted token", () => {
    const token = createSessionToken(SECRET, passwordHash);
    expect(verifySessionToken(token, SECRET, passwordHash)).toMatchObject({
      valid: true,
    });
  });

  it("issues a token that expires after the configured TTL", () => {
    const now = 1_800_000_000;
    const token = createSessionToken(SECRET, passwordHash, now);
    const verdict = verifySessionToken(token, SECRET, passwordHash, now);
    expect(verdict).toEqual({
      valid: true,
      expiresAt: now + SESSION_TTL_SECONDS,
    });
  });

  it("rejects an expired token", () => {
    const now = 1_800_000_000;
    const token = createSessionToken(SECRET, passwordHash, now, 60);
    expect(
      verifySessionToken(token, SECRET, passwordHash, now + 61),
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("accepts a token right up to its expiry", () => {
    const now = 1_800_000_000;
    const token = createSessionToken(SECRET, passwordHash, now, 60);
    expect(
      verifySessionToken(token, SECRET, passwordHash, now + 59),
    ).toMatchObject({ valid: true });
  });

  it("rejects a token signed with a different secret", () => {
    const token = createSessionToken(OTHER_SECRET, passwordHash);
    expect(verifySessionToken(token, SECRET, passwordHash)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("invalidates existing tokens when the password changes", () => {
    // The signing key mixes in the password hash, which is what makes a password
    // change act as a session revocation for stateless tokens.
    const token = createSessionToken(SECRET, passwordHash);
    const newHash = hashPassword("new-password");
    expect(verifySessionToken(token, SECRET, newHash)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects a tampered expiry", () => {
    const now = 1_800_000_000;
    const token = createSessionToken(SECRET, passwordHash, now, 60);
    const [, nonce, signature] = token.split(".");
    const forged = `${now + 999_999}.${nonce}.${signature}`;
    // Signature is checked before expiry, so this must not report "expired".
    expect(verifySessionToken(forged, SECRET, passwordHash, now)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  it("rejects a tampered signature", () => {
    const token = createSessionToken(SECRET, passwordHash);
    const parts = token.split(".");
    // Flip one character of the signature, preserving its length.
    const sig = parts[2]!;
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(
      verifySessionToken(`${parts[0]}.${parts[1]}.${flipped}`, SECRET, passwordHash),
    ).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("rejects structurally malformed tokens", () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", ".", "..", "x.y.z"]) {
      const verdict = verifySessionToken(bad, SECRET, passwordHash);
      expect(verdict.valid).toBe(false);
    }
  });

  it("rejects a non-numeric expiry", () => {
    expect(
      verifySessionToken("later.nonce.sig", SECRET, passwordHash),
    ).toEqual({ valid: false, reason: "malformed" });
  });

  it("issues a distinct token each time", () => {
    const now = 1_800_000_000;
    const a = createSessionToken(SECRET, passwordHash, now);
    const b = createSessionToken(SECRET, passwordHash, now);
    expect(a).not.toBe(b);
  });
});

describe("generateSessionSecret", () => {
  it("produces a value long enough for loadAuthConfig", () => {
    const secret = generateSessionSecret();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    // base64url: safe to place in an env file unquoted.
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not repeat", () => {
    expect(generateSessionSecret()).not.toBe(generateSessionSecret());
  });
});

describe("loadAuthConfig", () => {
  const validHash = hashPassword("pw");

  it("enables auth when both values are present and valid", () => {
    const state = loadAuthConfig({
      APP_PASSWORD_HASH: validHash,
      SESSION_SECRET: SECRET,
    } as NodeJS.ProcessEnv);

    expect(state.enabled).toBe(true);
    if (state.enabled) {
      expect(state.config.passwordHash).toBe(validHash);
      // Secure cookies default on; plain HTTP must be an explicit opt-out.
      expect(state.config.secureCookies).toBe(true);
    }
  });

  it("disables auth when the hash is missing", () => {
    const state = loadAuthConfig({
      SESSION_SECRET: SECRET,
    } as NodeJS.ProcessEnv);

    expect(state.enabled).toBe(false);
    if (!state.enabled) {
      expect(state.reason).toContain("APP_PASSWORD_HASH");
    }
  });

  it("disables auth when the hash is malformed", () => {
    const state = loadAuthConfig({
      APP_PASSWORD_HASH: "garbage",
      SESSION_SECRET: SECRET,
    } as NodeJS.ProcessEnv);

    expect(state.enabled).toBe(false);
    if (!state.enabled) {
      expect(state.reason).toContain("malformed");
    }
  });

  it("disables auth when the session secret is missing or too short", () => {
    for (const secret of [undefined, "", "short"]) {
      const state = loadAuthConfig({
        APP_PASSWORD_HASH: validHash,
        ...(secret === undefined ? {} : { SESSION_SECRET: secret }),
      } as NodeJS.ProcessEnv);

      expect(state.enabled).toBe(false);
      if (!state.enabled) {
        expect(state.reason).toContain("SESSION_SECRET");
      }
    }
  });

  it("allows insecure cookies only when explicitly requested", () => {
    const state = loadAuthConfig({
      APP_PASSWORD_HASH: validHash,
      SESSION_SECRET: SECRET,
      AUTH_INSECURE_COOKIES: "true",
    } as NodeJS.ProcessEnv);

    expect(state.enabled).toBe(true);
    if (state.enabled) expect(state.config.secureCookies).toBe(false);
  });

  it("ignores a non-'true' value for the insecure-cookie opt-out", () => {
    const state = loadAuthConfig({
      APP_PASSWORD_HASH: validHash,
      SESSION_SECRET: SECRET,
      AUTH_INSECURE_COOKIES: "yes",
    } as NodeJS.ProcessEnv);

    expect(state.enabled).toBe(true);
    if (state.enabled) expect(state.config.secureCookies).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const state = loadAuthConfig({
      APP_PASSWORD_HASH: `  ${validHash}  `,
      SESSION_SECRET: `  ${SECRET}  `,
    } as NodeJS.ProcessEnv);

    expect(state.enabled).toBe(true);
    if (state.enabled) expect(state.config.passwordHash).toBe(validHash);
  });
});
