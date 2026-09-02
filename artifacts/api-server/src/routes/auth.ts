import { Router, type IRouter, type Request, type Response } from "express";
import { LoginBody } from "@workspace/api-zod";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  loadAuthConfig,
  verifyPassword,
  verifySessionToken,
  type AuthState,
} from "../lib/auth";
import { RateLimiter } from "../lib/rate-limit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Read once at module load. The password hash and session secret come from the
 * environment, so re-reading per request would only add cost without picking up
 * changes: a rotation requires a restart either way.
 */
const authState: AuthState = loadAuthConfig();

if (!authState.enabled) {
  logger.warn({ reason: authState.reason }, "Authentication is DISABLED");
}

/**
 * A single-password gate is only as strong as the number of guesses allowed, so
 * cap attempts per client. 10 per 15 minutes is invisible to a person who
 * mistypes and ruinous to a script.
 */
const loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

/**
 * Client key for rate limiting.
 *
 * `req.ip` honours Express's trust-proxy setting, which app.ts configures from
 * TRUST_PROXY. Behind a misconfigured proxy every client collapses to one key,
 * which fails closed (shared limit) rather than open.
 */
function clientKey(req: Request): string {
  return req.ip ?? "unknown";
}

function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    // httpOnly: the token must be unreachable from JavaScript, so an injected
    // script cannot exfiltrate it.
    httpOnly: true,
    // lax, not strict: strict would drop the cookie on the first navigation from
    // an external link, showing a spurious login screen. lax still blocks
    // cross-site POSTs, which is the CSRF case that matters here.
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
  });
}

/** True when the request carries a valid, unexpired session cookie. */
export function isAuthenticated(req: Request): boolean {
  if (!authState.enabled) return false;

  const raw = req.cookies?.[SESSION_COOKIE];
  if (typeof raw !== "string" || raw.length === 0) return false;

  const verdict = verifySessionToken(
    raw,
    authState.config.sessionSecret,
    authState.config.passwordHash,
  );
  return verdict.valid;
}

export { authState };

/**
 * Unauthenticated by design: the frontend calls this on load to choose between
 * the login screen and the app, so it must answer 200 either way.
 */
router.get("/auth/session", (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    authRequired: authState.enabled,
  });
});

router.post("/auth/login", (req, res) => {
  if (!authState.enabled) {
    // 503, not 401: the server is misconfigured, not the caller.
    res.status(503).json({
      error: "AuthNotConfigured",
      message: authState.reason,
    });
    return;
  }

  const key = clientKey(req);
  const limit = loginLimiter.hit(key);
  if (!limit.allowed) {
    logger.warn({ ip: key }, "Login rate limit exceeded");
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({
      error: "TooManyAttempts",
      message: `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
    });
    return;
  }

  const body = LoginBody.parse(req.body);

  if (!verifyPassword(body.password, authState.config.passwordHash)) {
    logger.warn({ ip: key, remaining: limit.remaining }, "Failed login");
    // No detail about why: a wrong password and a malformed hash must look the
    // same from outside.
    res.status(401).json({ error: "Unauthorized", message: "Incorrect password" });
    return;
  }

  // A correct password clears the counter so a genuine operator is never locked
  // out by earlier typos.
  loginLimiter.reset(key);

  const token = createSessionToken(
    authState.config.sessionSecret,
    authState.config.passwordHash,
  );
  setSessionCookie(res, token, authState.config.secureCookies);
  logger.info({ ip: key }, "Login succeeded");

  res.json({ authenticated: true, authRequired: true });
});

router.post("/auth/logout", (req, res) => {
  clearSessionCookie(
    res,
    authState.enabled ? authState.config.secureCookies : true,
  );
  if (isAuthenticated(req)) {
    logger.info({ ip: clientKey(req) }, "Logout");
  }
  res.status(204).end();
});

export default router;
