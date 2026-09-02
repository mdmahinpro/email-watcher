import type { Express } from "express";
import request from "supertest";

/**
 * Shared login helper for route tests.
 *
 * Every /api route except /healthz and /auth/* is behind the session gate, so a
 * route test has to authenticate first. Keeping this in one place means the tests
 * exercise the same gate real clients do, rather than bypassing it with a mock —
 * a mocked-away guard is how an endpoint quietly ends up unprotected.
 *
 * Must match vitest.config.ts APP_PASSWORD_HASH.
 */
export const TEST_PASSWORD = "test-password-not-a-real-secret";

/** Log in and return the `Cookie` header value to attach to later requests. */
export async function authCookie(app: Express): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ password: TEST_PASSWORD });

  if (res.status !== 200) {
    throw new Error(
      `Test login failed with ${res.status}. Check vitest.config.ts APP_PASSWORD_HASH.`,
    );
  }

  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find((c) => c.startsWith("ew_session="));
  if (!cookie) throw new Error("Test login returned no session cookie");

  return cookie.split(";")[0]!;
}

/**
 * A supertest wrapper that attaches the session cookie to every request.
 *
 * Usage:
 *   const api = await authedRequest(app);
 *   await api.get("/api/accounts");
 */
export async function authedRequest(app: Express) {
  const cookie = await authCookie(app);

  const wrap = (test: request.Test) => test.set("Cookie", cookie);

  return {
    get: (url: string) => wrap(request(app).get(url)),
    post: (url: string) => wrap(request(app).post(url)),
    put: (url: string) => wrap(request(app).put(url)),
    patch: (url: string) => wrap(request(app).patch(url)),
    delete: (url: string) => wrap(request(app).delete(url)),
  };
}
