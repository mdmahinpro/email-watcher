import type { NextFunction, Request, Response } from "express";
import { authState, isAuthenticated } from "../routes/auth";
import { logger } from "../lib/logger";

/**
 * Paths under /api that are reachable without a session.
 *
 * Deliberately tiny and exact-matched:
 * - `/healthz` and `/readyz` are container probes, which run before anyone can
 *   log in. They reveal only whether the process and database are alive.
 * - the `/auth/*` endpoints are the gate itself.
 *
 * Plus one prefix:
 * - `/view/` serves a single stored message by signed, expiring link. The
 *   HMAC over the message id is the credential — unguessable,
 *   non-enumerable, and invalidated by a password change — and it grants
 *   exactly one message, nothing else. Telegram alerts carry these links so
 *   a critical match can be opened without a session.
 */
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/readyz",
  "/auth/session",
  "/auth/login",
  "/auth/logout",
]);

const PUBLIC_PATH_PREFIXES = ["/view/"];

/**
 * Require a valid session for every API route except the few public ones.
 *
 * Allow-list by design: a new route is protected the moment it is added, without
 * anyone remembering to guard it. That is the opposite of a deny-list, where
 * forgetting an entry silently exposes data.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // `req.path` here is relative to the router mount point (/api).
  if (PUBLIC_PATHS.has(req.path) || PUBLIC_PATH_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }

  if (!authState.enabled) {
    // Fail closed. With no password configured, an unauthenticated request must
    // not be served just because the gate is missing.
    res.status(503).json({
      error: "AuthNotConfigured",
      message: authState.reason,
    });
    return;
  }

  if (!isAuthenticated(req)) {
    logger.warn(
      { ip: req.ip, method: req.method, path: req.path },
      "Blocked unauthenticated request",
    );
    res.status(401).json({
      error: "Unauthorized",
      message: "Sign in to access this resource",
    });
    return;
  }

  next();
}
