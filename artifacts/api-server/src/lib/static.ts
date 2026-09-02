import { existsSync } from "node:fs";
import path from "node:path";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { logger } from "./logger";

/**
 * Serve the built React SPA from the same Express process as the API.
 *
 * This is not merely convenient — it is required for authentication. The session
 * cookie is `SameSite=Lax`, which browsers do not send on cross-site requests, so
 * splitting the SPA and the API across two origins produces a login that appears
 * to succeed and then 401s on every subsequent call. One origin also means one
 * service on a host that meters instance hours (Render free allows 750/month
 * against a ~730-hour month, so a second always-on service would not fit).
 *
 * In development this is skipped entirely: Vite serves the SPA on its own port
 * with HMR and proxies /api here.
 */

/** Where `@workspace/web` writes its build. */
const DEFAULT_STATIC_DIR = path.resolve(
  process.cwd(),
  "..",
  "web",
  "dist",
  "public",
);

function resolveStaticDir(): string | null {
  // An explicit override wins, for deployments that lay the files out elsewhere.
  const configured = process.env["STATIC_DIR"];
  const candidates = configured
    ? [path.resolve(configured)]
    : [
        DEFAULT_STATIC_DIR,
        // When the server is started from the repo root rather than its own
        // package directory.
        path.resolve(process.cwd(), "artifacts", "web", "dist", "public"),
      ];

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

export function mountStatic(app: Express): void {
  const staticDir = resolveStaticDir();

  if (!staticDir) {
    // Not an error: this is the normal state in development, and the API is fully
    // functional without it.
    logger.info(
      "No SPA build found; serving API only (run the web dev server separately)",
    );
    return;
  }

  logger.info({ staticDir }, "Serving SPA");

  // Hashed asset filenames are content-addressed, so they can be cached
  // immutably. index.html must not be, or a deploy would keep serving the old
  // bundle references.
  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else {
          // Icons and the manifest change rarely but are not content-hashed.
          res.setHeader("Cache-Control", "public, max-age=3600");
        }
      },
    }),
  );

  const indexPath = path.join(staticDir, "index.html");

  // SPA fallback: any unmatched GET returns index.html so client-side routes like
  // /inbox work on a hard refresh.
  //
  // Registered as middleware rather than `app.get("*")`: Express 5 uses
  // path-to-regexp v8, which rejects a bare `*` pattern. Filtering inside also
  // makes the two exclusions explicit — /api paths fall through to the JSON 404
  // handler, and non-GET methods do too, because a POST to a nonexistent path
  // should be a 404 rather than an HTML page.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexPath, (err) => {
      if (err) next(err);
    });
  });
}
