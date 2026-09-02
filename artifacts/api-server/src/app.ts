import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import router from "./routes";
import { logger } from "./lib/logger";
import { mountStatic } from "./lib/static";
// pino-http augments Request with `log`, but type isn't always picked up

const FRONTEND_ORIGINS = (process.env["FRONTEND_ORIGINS"] ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app: Express = express();

/**
 * Trust the reverse proxy's X-Forwarded-* headers when told to.
 *
 * Required behind nginx/Caddy/Cloudflare so `req.ip` is the real client and not
 * the proxy, which the login rate limiter depends on. Off by default: trusting
 * these headers when there is no proxy lets a client spoof its own IP and defeat
 * the limiter entirely.
 */
const trustProxy = process.env["TRUST_PROXY"];
if (trustProxy) {
  // Accepts "1", "2" (hop count) or a subnet/preset like "loopback".
  const hops = Number(trustProxy);
  app.set("trust proxy", Number.isInteger(hops) ? hops : trustProxy);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin "${origin}" not allowed by CORS`), false);
    },
    // Required for the session cookie to be sent on cross-origin requests, which
    // is the case in development (5173 -> 3001). Only the origins above are
    // allowed, so this does not open the API to arbitrary sites.
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// The SPA is served from this same process so that the app and its API share one
// origin; see lib/static.ts. Mounted after /api so it can never shadow a route.
mountStatic(app);

// Centralized error handler
app.use(
  (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "ValidationError",
        issues: err.issues,
      });
      return;
    }
    const message =
      err instanceof Error ? err.message : "Internal Server Error";
    if (req.log) {
      req.log.error({ err }, "Unhandled error");
    } else {
      logger.error({ err }, "Unhandled error");
    }
    res.status(500).json({ error: "InternalServerError", message });
  },
);

export { FRONTEND_ORIGINS };
export default app;
