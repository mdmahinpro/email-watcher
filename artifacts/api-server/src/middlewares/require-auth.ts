import type { NextFunction, Request, Response } from "express";
import { authState, isAuthenticated } from "../routes/auth";
import { logger } from "../lib/logger";

/**
 * Paths under /api that are reachable without a session.
 *
 * Deliberately tiny and exact-matched:
 * - `/healthz` is the container startup probe, which runs before anyone can log
 *   in. It reveals only whether the database is reachable.
 * - the `/auth/*` endpoints are the gate itself.
 */
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/auth/session",
  "/auth/login",
  "/auth/logout",
]);

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
  if (PUBLIC_PATHS.has(req.path)) {
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
