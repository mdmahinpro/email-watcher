import { defineConfig } from "drizzle-kit";
import path from "path";

// drizzle-kit does not load .env files, so `pnpm --filter @workspace/db run push`
// would otherwise require DATABASE_URL to already be exported. Read the same
// repo-root .env the API server uses; a value already in the environment wins.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", "..", ".env"));
  } catch {
    // No .env present; fall through to the explicit error below.
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // drizzle-kit treats this as a glob, where a Windows backslash is an escape
  // character, so always hand it a forward-slash path.
  schema: path.join(__dirname, "./src/schema/index.ts").split(path.sep).join("/"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
