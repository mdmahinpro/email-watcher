import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { probeDatabase } from "../lib/db-health";
import { classifyDatabaseTarget } from "../lib/db-target";

const router: IRouter = Router();

/**
 * Liveness. Answers 200 whenever the process is serving.
 *
 * Deliberately does NOT fail when the database is unreachable. This is the path
 * Render uses as its health check, and a liveness probe that depends on an
 * external service turns a transient database outage into a failed deploy and a
 * dead service — the opposite of what a health check is for. The database state is
 * reported in the body instead, so a monitor can still surface it.
 *
 * The probe is bounded well under Render's 5-second abort, so this always returns
 * rather than hanging.
 */
router.get("/healthz", async (_req, res) => {
  const database = await probeDatabase();
  // A category, never the raw host: enough to diagnose a misconfigured
  // deployment from outside, without disclosing the project ref or credentials.
  const target = classifyDatabaseTarget();

  res.json({
    ...HealthCheckResponse.parse({ status: "ok" }),
    database: database.state,
    ...(database.latencyMs !== undefined
      ? { databaseLatencyMs: database.latencyMs }
      : {}),
    ...(database.error ? { databaseError: database.error } : {}),
    ...(target
      ? {
          databaseTarget: target.kind,
          databasePort: target.port,
          ...(target.warning ? { databaseWarning: target.warning } : {}),
        }
      : { databaseTarget: "unconfigured" }),
  });
});

/**
 * Readiness. 503 while the database is unreachable.
 *
 * Kept separate from /healthz and intentionally not wired to any platform health
 * check: use it from a monitor when you want to be alerted that the app cannot
 * actually serve data.
 */
router.get("/readyz", async (_req, res) => {
  const database = await probeDatabase();

  if (database.state !== "ok") {
    res.status(503).json({
      status: "degraded",
      database: database.state,
      ...(database.error ? { databaseError: database.error } : {}),
    });
    return;
  }

  res.json({
    status: "ok",
    database: database.state,
    ...(database.latencyMs !== undefined
      ? { databaseLatencyMs: database.latencyMs }
      : {}),
  });
});

export default router;
