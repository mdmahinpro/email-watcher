import { defineConfig } from "vitest/config";

/**
 * Precomputed scrypt hash of TEST_PASSWORD below, using the same parameters as
 * src/lib/auth.ts. Hardcoded so the suite does not spend ~350ms hashing per file.
 * This is test-only and guards nothing.
 */
const TEST_PASSWORD_HASH =
  "scrypt$65536$8$1$0defac6c1cffed4961101a7621aef86d$062bd4d5ba00c925ca597c0ffdcea58475fd603e3872674a6bccbc56bcfb0189da9fb93e349b67398928ac9f4e652927039648c5964263c185ef228de89e1960";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // @workspace/db throws at import time unless DATABASE_URL is set. The route
      // tests mock the module, but the mock is only installed after Vitest has
      // resolved the module graph, so provide a value that is never connected to.
      DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test",
      LOG_LEVEL: "silent",
      // Auth is configured for every test file so the API gate behaves as it does
      // in production. Route tests authenticate via src/test-support/authed.ts.
      APP_PASSWORD_HASH: TEST_PASSWORD_HASH,
      SESSION_SECRET: "z".repeat(48),
      // supertest speaks plain HTTP, so a Secure cookie would never come back.
      AUTH_INSECURE_COOKIES: "true",
    },
  },
});
