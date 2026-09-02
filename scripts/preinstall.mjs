// Runs before `pnpm install` (see root package.json "preinstall").
// Cross-platform replacement for the previous `sh -c` one-liner, which failed on
// Windows where /bin/sh is unavailable.
//
// Two jobs:
//   1. Remove npm/yarn lockfiles so they cannot drift from pnpm-lock.yaml.
//   2. Refuse to install with a package manager other than pnpm.
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const lockfile of ["package-lock.json", "yarn.lock"]) {
  rmSync(path.join(repoRoot, lockfile), { force: true });
}

const userAgent = process.env["npm_config_user_agent"] ?? "";

// npm_config_user_agent is unset when the script is invoked directly (e.g. by a
// tool or by hand), so only reject a positively identified non-pnpm client.
if (userAgent && !userAgent.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
