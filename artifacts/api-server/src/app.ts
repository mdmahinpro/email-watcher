import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import router from "./routes";
import { logger } from "./lib/logger";
import { mountStatic } from "./lib/static";
// pino-http augments Request with `log`, but type isn't always picked up

/**
 * Browser origins allowed to call the API cross-site.
 *
 * The app's own origin is always allowed and does not need to be listed: in
 * production the SPA is served by this same process, so its requests are
 * same-origin by construction. `RENDER_EXTERNAL_URL` is injected by Render and
 * is included automatically, because a service whose name was taken gets a
 * suffix (email-watcher -> email-watcher-k01d) and hardcoding the URL then
 * silently locks the app out of its own API.
 */
function resolveFrontendOrigins(): string[] {
  const configured = (process.env["FRONTEND_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const external = process.env["RENDER_EXTERNAL_URL"]?.trim();
  if (external) {
    // Normalize: RENDER_EXTERNAL_URL has no trailing slash, but an Origin header
    // never does either, so compare bare origins.
    try {
      const origin = new URL(external).origin;
      if (!configured.includes(origin)) configured.push(origin);
    } catch {
      logger.warn(
        { external },
        "RENDER_EXTERNAL_URL is not a valid URL; ignoring it",
      );
    }
  }

  return configured;
}

const FRONTEND_ORIGINS = resolveFrontendOrigins();

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

/**
 * True when the request came from the origin this server is being served on.
 *
 * Vite marks module scripts `crossorigin`, so the browser sends an `Origin`
 * header even for same-origin asset requests. Those must always be allowed
 * regardless of configuration, or the app cannot load its own bundle.
 */
function isSameOrigin(req: Request, origin: string): boolean {
  const host = req.headers.host;
  if (!host) return false;
  try {
    const { hostname, port } = new URL(origin);
    const expected = port ? `${hostname}:${port}` : hostname;
    return expected === host;
  } catch {
    return false;
  }
}

/**
 * CORS is mounted on /api only.
 *
 * Static assets must never be gated by it: a browser sends `Origin` on
 * `crossorigin` script and stylesheet requests, so a global CORS check turns a
 * misconfigured allow-list into 500s on the stylesheet and JS bundle — which
 * presents as a blank page with no useful error.
 */
app.use(
  "/api",
  cors({
    origin: (origin, cb) => {
      // No Origin header: a same-origin navigation, curl, or a health probe.
      if (!origin) return cb(null, true);
      if (FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
      // A disallowed origin is not a server error. Omitting the CORS headers
      // lets the browser block the response, which is the mechanism CORS is
      // supposed to use; passing an Error here would surface as a 500 instead.
      return cb(null, false);
    },
    // Required for the session cookie to be sent on cross-origin requests, which
    // is the case in development (5173 -> 3001). Only the origins above are
    // allowed, so this does not open the API to arbitrary sites.
    credentials: true,
  }),
);

// Same-origin asset requests carry an Origin header because of Vite's
// `crossorigin` attribute; echo it back so the browser accepts them.
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && isSameOrigin(req, origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  next();
});

app.use(cookieParser());
/**
 * A restore upload carries the whole archive, so the 1 MB global limit would
 * reject every real backup. This parser covers only the restore path and is
 * mounted first; the global parser below then finds the body already parsed.
 *
 * 64 MB is deliberate: the parsed document typically needs several times its
 * size in memory, and a free instance has 512 MB. Bigger archives should be
 * restored through the database provider's own tools.
 */
app.use("/api/backup/restore", express.json({ limit: "64mb" }));
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
