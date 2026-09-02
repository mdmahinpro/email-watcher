import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Used as the production startup probe (see .replit-artifact/artifact.toml), so
// it must fail while the database is unreachable rather than report a healthy
// process that cannot serve any real request.
router.get("/healthz", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error({ err }, "Health check failed: database unreachable");
    res.status(503).json(HealthCheckResponse.parse({ status: "degraded" }));
    return;
  }
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
