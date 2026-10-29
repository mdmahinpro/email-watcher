import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Loads a local .env for development. On a managed host the variables are already
// in the environment and this is a harmless no-op.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

/** Fallback when the host does not inject PORT (i.e. local development). */
const DEFAULT_PORT = 3001;

const run = async () => {
  const app = (await import("./app")).default;
  const { FRONTEND_ORIGINS } = await import("./app");
  const { logger } = await import("./lib/logger");
  const { startScheduler, stopScheduler } = await import("./lib/scheduler");
  const { authState } = await import("./routes/auth");
  const { pool } = await import("@workspace/db");

  const rawPort = process.env["PORT"];
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  // Refuse to serve an unguarded instance outside development. Every API route
  // already fails closed with 503, but starting at all in that state invites
  // someone to point a domain at it and assume it is protected.
  if (!authState.enabled && process.env["NODE_ENV"] === "production") {
    throw new Error(
      `Refusing to start without authentication in production. ${authState.reason}`,
    );
  }

  // The code queries columns the database may not have yet (a deploy can ship
  // faster than a migration). Applying the additive statements here means the
  // server never serves a request its schema cannot answer, on any plan, with
  // nothing for the operator to remember. Runs before listen on purpose: a
  // failure here exits the process rather than letting it serve 500s.
  const { ensureSchema } = await import("./lib/bootstrap-schema");
  await ensureSchema();

  // Bind on all interfaces: a container host routes external traffic to the
  // container's address, and binding loopback-only would make the service
  // unreachable and fail its health check.
  const server = app.listen(port, "0.0.0.0", (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info(
      { port, origins: FRONTEND_ORIGINS, authEnabled: authState.enabled },
      "Server listening",
    );
    startScheduler().catch((schedErr) => {
      logger.error({ err: schedErr }, "Failed to start scheduler");
    });
  });

  // A free host restarts services freely and sends SIGTERM with a short grace
  // period. Draining cleanly means an in-flight scan's progress commit is not
  // interrupted, and the database pool is released rather than left to time out.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");
    server.close(async () => {
      await stopScheduler();
      try {
        await pool.end();
      } catch (poolErr) {
        logger.error({ err: poolErr }, "Failed to close database pool");
      }
      logger.info("Server closed, exiting");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Force-exiting after shutdown timeout");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A background scan runs outside any request, so an unexpected throw there has
  // no handler to reach. Log and keep serving instead of letting Node terminate
  // the process and stop all monitoring.
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
  });
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
