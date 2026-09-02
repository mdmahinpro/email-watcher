import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { TEST_PASSWORD } from "../test-support/authed";

/**
 * Auth credentials come from vitest.config.ts `env`, which is applied before any
 * module loads, so `loadAuthConfig` sees them at import time.
 */

/** Minimal chainable Drizzle stand-in; these tests only care about status codes. */
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

const { default: app } = await import("../app");

/** Extract the session cookie from a login response. */
function sessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = cookies.find((c) => c.startsWith("ew_session="));
  if (!match) throw new Error("No session cookie in response");
  return match.split(";")[0]!;
}

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

/**
 * Each test gets a distinct client IP so the shared in-process rate limiter does
 * not leak state between tests. Express reads this only when trust proxy is on,
 * so also vary nothing else: the limiter falls back to a single key otherwise,
 * which is why the rate-limit assertions below use their own budget accounting.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/session", () => {
  it("is reachable without a session and reports signed-out", async () => {
    const res = await request(app).get("/api/auth/session");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false, authRequired: true });
  });

  it("reports signed-in once a session cookie is presented", async () => {
    const cookie = await login();

    const res = await request(app)
      .get("/api/auth/session")
      .set("Cookie", cookie);

    expect(res.body).toEqual({ authenticated: true, authRequired: true });
  });

  it("ignores a tampered cookie", async () => {
    const cookie = await login();
    // Flip the last character of the signature.
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");

    const res = await request(app)
      .get("/api/auth/session")
      .set("Cookie", tampered);

    expect(res.body.authenticated).toBe(false);
  });
});

describe("POST /api/auth/login", () => {
  it("sets an httpOnly, lax, path-scoped cookie", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    const raw = res.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : [raw as string];
    const cookie = cookies.find((c) => c.startsWith("ew_session="))!;

    // httpOnly keeps the token away from injected scripts.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it("rejects a wrong password without revealing why", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "wrong-password-entirely" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("never echoes the submitted password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "some-guessed-password" });

    expect(JSON.stringify(res.body)).not.toContain("some-guessed-password");
  });

  it("rejects a missing password", async () => {
    const res = await request(app).post("/api/auth/login").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rejects an empty password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "" });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the cookie and ends the session", async () => {
    const cookie = await login();

    const out = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(204);

    const raw = out.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : [raw as string];
    expect(cookies.some((c) => c.startsWith("ew_session=;"))).toBe(true);
  });

  it("is safe to call without a session", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(204);
  });
});

describe("the API gate", () => {
  const PROTECTED = [
    ["get", "/api/accounts"],
    ["post", "/api/accounts"],
    ["post", "/api/accounts/bulk"],
    ["post", "/api/accounts/hostinger"],
    ["get", "/api/accounts/hostinger/defaults"],
    ["patch", "/api/accounts/1"],
    ["delete", "/api/accounts/1"],
    ["post", "/api/accounts/1/test"],
    ["post", "/api/accounts/1/scan"],
    ["get", "/api/messages"],
    ["delete", "/api/messages/1"],
    ["get", "/api/inbox"],
    ["delete", "/api/inbox/1"],
    ["get", "/api/settings"],
    ["put", "/api/settings"],
    ["get", "/api/stats/summary"],
    ["get", "/api/stats/keyword-breakdown"],
    ["get", "/api/stats/account-activity"],
  ] as const;

  it.each(PROTECTED)(
    "refuses %s %s without a session",
    async (method, path) => {
      const res = await (request(app) as never as Record<
        string,
        (p: string) => request.Test
      >)[method]!(path).send({});

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    },
  );

  it("leaks no data in the 401 body", async () => {
    const res = await request(app).get("/api/accounts");

    // Only the error shape, never a partial payload.
    expect(Object.keys(res.body).sort()).toEqual(["error", "message"]);
  });

  it("allows a protected route once signed in", async () => {
    const cookie = await login();

    const res = await request(app).get("/api/accounts").set("Cookie", cookie);

    expect(res.status).toBe(200);
  });

  it("refuses an unknown /api path without a session, before routing", async () => {
    // The guard runs ahead of the 404 handler, so an unauthenticated probe cannot
    // enumerate which routes exist.
    const res = await request(app).get("/api/does-not-exist");

    expect(res.status).toBe(401);
  });

  it("keeps /healthz public for container probes", async () => {
    const res = await request(app).get("/api/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("keeps /readyz public for container probes", async () => {
    const res = await request(app).get("/api/readyz");

    // 200 or 503 depending on the mocked database, but never 401.
    expect(res.status).not.toBe(401);
  });
});

/**
 * MUST BE LAST.
 *
 * The login rate limiter is module-scoped and keyed by client IP, and supertest
 * always presents as the same client, so exhausting the budget here would make
 * every earlier login fail. The limiting logic itself is covered exhaustively in
 * lib/rate-limit.test.ts; this only proves the route is wired to it.
 */
describe("login rate limiting", () => {
  it("answers 429 with Retry-After once the budget is spent", async () => {
    let sawRateLimit = false;

    // The budget is 10 per 15 minutes and a correct password resets it, so keep
    // guessing wrong until the limiter trips.
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ password: `wrong-guess-${i}` });

      if (res.status === 429) {
        sawRateLimit = true;
        expect(res.body.error).toBe("TooManyAttempts");
        expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
        break;
      }
      expect(res.status).toBe(401);
    }

    expect(sawRateLimit).toBe(true);
  });

  it("keeps refusing the correct password while rate limited", async () => {
    // Fail closed: a valid password must not bypass the limiter, or the limit
    // would be trivially probe-able.
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(429);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
