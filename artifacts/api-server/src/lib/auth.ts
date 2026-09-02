import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Single-password gate for this app.
 *
 * There is exactly one operator, so there is no user table: the password hash
 * lives in `APP_PASSWORD_HASH` and sessions are stateless signed tokens. That
 * keeps the credential out of the database (which already holds plaintext
 * mailbox passwords) and means a session survives a server restart without
 * needing a session store.
 */

/** scrypt parameters. N=2^16 costs ~100ms per hash, which is the point. */
const SCRYPT = {
  N: 65536,
  r: 8,
  p: 1,
  keyLength: 64,
  saltBytes: 16,
} as const;

/**
 * scrypt needs roughly `128 * N * r` bytes — 64 MB at these parameters — but
 * Node caps `maxmem` at 32 MB by default and throws rather than allocating more.
 * Compute the ceiling from the parameters, with headroom, so a stored hash with a
 * higher cost still verifies.
 */
function scryptMaxmem(N: number, r: number): number {
  return 256 * N * r;
}

const HASH_PREFIX = "scrypt";

/** Sessions last a week; long enough to be convenient, short enough to expire. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const SESSION_COOKIE = "ew_session";

/**
 * Hash a password for storage in `APP_PASSWORD_HASH`.
 *
 * Format: `scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>`. The parameters travel with
 * the hash so raising the cost later does not invalidate existing hashes.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT.saltBytes);
  const hash = scryptSync(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: scryptMaxmem(SCRYPT.N, SCRYPT.r),
  });
  return [
    HASH_PREFIX,
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }

  try {
    const salt = Buffer.from(parts[4]!, "hex");
    const hash = Buffer.from(parts[5]!, "hex");
    if (salt.length === 0 || hash.length === 0) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

/**
 * Verify a candidate password against a stored hash.
 *
 * Comparison is timing-safe so a response time cannot be used to learn how much
 * of a guess was correct.
 */
export function verifyPassword(candidate: string, stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(candidate, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: scryptMaxmem(parsed.N, parsed.r),
    });
  } catch {
    return false;
  }

  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Derive the token-signing key.
 *
 * Mixing the password hash into the key means changing the password invalidates
 * every existing session, which is the behaviour you want from a "reset my
 * password because I think someone got in" action. A stateless token cannot
 * otherwise be revoked.
 */
function signingKey(secret: string, passwordHash: string): Buffer {
  return createHmac("sha256", secret)
    .update("ew-session-v1")
    .update(passwordHash)
    .digest();
}

function sign(payload: string, secret: string, passwordHash: string): string {
  return base64url(
    createHmac("sha256", signingKey(secret, passwordHash))
      .update(payload)
      .digest(),
  );
}

/**
 * Mint a session token.
 *
 * Format: `<expiresAtSeconds>.<nonce>.<hmac>`. Stateless, so no session table is
 * needed; the nonce makes each token unique so one cannot be confused for
 * another in logs.
 */
export function createSessionToken(
  secret: string,
  passwordHash: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): string {
  const expiresAt = nowSeconds + ttlSeconds;
  const nonce = base64url(randomBytes(12));
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload, secret, passwordHash)}`;
}

export type SessionVerdict =
  | { valid: true; expiresAt: number }
  | { valid: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * Verify a session token.
 *
 * The signature is checked before the expiry so a tampered token is never
 * reported as merely "expired", which would leak that its signature was valid.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  passwordHash: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionVerdict {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };

  const [expiresAtRaw, nonce, providedSignature] = parts as [
    string,
    string,
    string,
  ];
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || nonce.length === 0) {
    return { valid: false, reason: "malformed" };
  }

  const expected = sign(`${expiresAtRaw}.${nonce}`, secret, passwordHash);
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSignature);
  // timingSafeEqual throws on a length mismatch, which is itself not secret.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad-signature" };
  }

  if (expiresAt <= nowSeconds) return { valid: false, reason: "expired" };

  return { valid: true, expiresAt };
}

export interface AuthConfig {
  passwordHash: string;
  sessionSecret: string;
  /** Send the Secure cookie attribute. Off for plain-HTTP local development. */
  secureCookies: boolean;
}

export type AuthState =
  | { enabled: true; config: AuthConfig }
  | { enabled: false; reason: string };

/**
 * Read auth configuration from the environment.
 *
 * Returns a disabled state rather than throwing when `APP_PASSWORD_HASH` is
 * absent, so a fresh checkout still boots and can explain what to do. The server
 * refuses to start unguarded in production; see `assertAuthConfigured`.
 */
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthState {
  const passwordHash = env["APP_PASSWORD_HASH"]?.trim();
  if (!passwordHash) {
    return {
      enabled: false,
      reason:
        "APP_PASSWORD_HASH is not set. Run `pnpm --filter @workspace/scripts run set-password` to generate one.",
    };
  }

  if (!parseHash(passwordHash)) {
    return {
      enabled: false,
      reason:
        "APP_PASSWORD_HASH is malformed. Regenerate it with `pnpm --filter @workspace/scripts run set-password`.",
    };
  }

  const sessionSecret = env["SESSION_SECRET"]?.trim();
  if (!sessionSecret || sessionSecret.length < 32) {
    return {
      enabled: false,
      reason:
        "SESSION_SECRET must be set to at least 32 characters. Run `pnpm --filter @workspace/scripts run set-password` to generate one.",
    };
  }

  // Default to secure cookies unless explicitly told the deployment is plain
  // HTTP; getting this wrong silently is worse than an opt-out.
  const secureCookies = env["AUTH_INSECURE_COOKIES"] !== "true";

  return {
    enabled: true,
    config: { passwordHash, sessionSecret, secureCookies },
  };
}

/** Generate a value suitable for `SESSION_SECRET`. */
export function generateSessionSecret(): string {
  return randomBytes(48).toString("base64url");
}
