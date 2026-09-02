import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * CORS behaviour, verified against the real app.
 *
 * The bug these cover: CORS was mounted globally with a rejected origin passed to
 * the callback as an `Error`. That combination turned a misconfigured allow-list
 * into HTTP 500 on the JS bundle and stylesheet — a blank page with no useful
 * error — and it fired even for same-origin requests, because Vite marks module
 * scripts `crossorigin` so the browser sends `Origin` regardless.
 */

const ALLOWED = "https://allowed.example.com";

vi.hoisted(() => {
  process.env["FRONTEND_ORIGINS"] = "https://allowed.example.com";
  // Simulates Render injecting the service's real URL, which must be trusted
  // automatically so a name-suffixed service is not locked out of its own API.
  process.env["RENDER_EXTERNAL_URL"] = "https://email-watcher-k01d.onrender.com";
});

const dbMock = vi.hoisted(() => {
  const makeChain = (): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "symbol") return undefined;
          if (prop === "then") {
            return (onFulfilled?: (v: unknown) => unknown) =>
              Promise.resolve([]).then(onFulfilled);
          }
          return () => makeChain();
        },
      },
    ) as Record<string, unknown>;

  return {
    db: {
      select: makeChain,
      insert: makeChain,
      update: makeChain,
      delete: makeChain,
      execute: () => Promise.resolve({ rows: [{ ok: 1 }] }),
    },
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  return { ...schema, db: dbMock.db, pool: { end: async () => undefined } };
});

vi.mock("../lib/scheduler", () => ({
  startScheduler: vi.fn(async () => undefined),
  stopScheduler: vi.fn(async () => undefined),
  restartScheduler: vi.fn(async () => undefined),
}));

const { default: app, FRONTEND_ORIGINS } = await import("../app");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("allowed origins", () => {
  it("includes the configured origins", () => {
    expect(FRONTEND_ORIGINS).toContain(ALLOWED);
  });

  it("adds RENDER_EXTERNAL_URL automatically", () => {
    // Render suffixes a taken service name (email-watcher -> email-watcher-k01d),
    // so relying on a hardcoded URL locked the app out of its own API.
    expect(FRONTEND_ORIGINS).toContain("https://email-watcher-k01d.onrender.com");
  });
});

describe("static assets", () => {
  it("are not gated by CORS, even from an unknown origin", async () => {
    // The regression: this used to answer 500 and blank the page.
    const res = await request(app)
      .get("/favicon.ico")
      .set("Origin", "https://totally-unknown.example.com");

    expect(res.status).not.toBe(500);
  });

  it("serve normally with no Origin header", async () => {
    const res = await request(app).get("/favicon.ico");

    expect(res.status).not.toBe(500);
  });
});

describe("API CORS", () => {
  it("allows a configured origin and echoes it", async () => {
    const res = await request(app).get("/api/healthz").set("Origin", ALLOWED);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    // Needed for the session cookie to travel cross-origin in development.
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("allows a request with no Origin header", async () => {
    // curl, container health probes, and same-origin navigations.
    const res = await request(app).get("/api/healthz");

    expect(res.status).toBe(200);
  });

  it("refuses a disallowed origin without erroring", async () => {
    const res = await request(app)
      .get("/api/healthz")
      .set("Origin", "https://evil.example.com");

    // The request is served but carries no CORS header, so the browser blocks
    // the response. A 500 here would be the old bug.
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not leak data to a disallowed origin on a guarded route", async () => {
    const res = await request(app)
      .get("/api/accounts")
      .set("Origin", "https://evil.example.com");

    // Auth still applies independently of CORS.
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows the app's own origin regardless of configuration", async () => {
    // Vite's `crossorigin` attribute makes the browser send Origin even
    // same-origin, so this must never depend on the allow-list.
    const res = await request(app)
      .get("/api/healthz")
      .set("Host", "self.example.com")
      .set("Origin", "https://self.example.com");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://self.example.com",
    );
  });

  it("answers a preflight for a configured origin", async () => {
    const res = await request(app)
      .options("/api/settings")
      .set("Origin", ALLOWED)
      .set("Access-Control-Request-Method", "PUT");

    expect(res.status).toBeLessThan(400);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });
});
