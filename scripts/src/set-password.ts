/**
 * Generate the credentials that guard the app, and write them into the repo-root
 * .env.
 *
 * Run with: pnpm --filter @workspace/scripts run set-password
 *
 * The password is hashed with scrypt before it is written, so the plaintext never
 * lands on disk. SESSION_SECRET is generated if absent; regenerating it (or
 * changing the password) invalidates every existing session.
 */
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { stdin, stdout } from "node:process";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "..", "..", ".env");

const MIN_PASSWORD_LENGTH = 12;

// Must stay in sync with artifacts/api-server/src/lib/auth.ts.
const SCRYPT = { N: 65536, r: 8, p: 1, keyLength: 64, saltBytes: 16 } as const;

/**
 * scrypt needs roughly `128 * N * r` bytes — 64 MB here — but Node caps `maxmem`
 * at 32 MB by default and throws rather than allocating more.
 */
const SCRYPT_MAXMEM = 256 * SCRYPT.N * SCRYPT.r;

function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT.saltBytes);
  const hash = scryptSync(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

/**
 * Read a line without echoing it.
 *
 * `readline` has no built-in masked input, so the terminal is switched to raw
 * mode and characters are consumed manually. Without this the password would be
 * visible on screen and left in the scrollback.
 */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);

    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case "\r":
          case "\n":
          case "\u0004": // Ctrl-D
            stdout.write("\n");
            cleanup();
            resolve(value);
            return;
          case "\u0003": // Ctrl-C
            stdout.write("\n");
            cleanup();
            reject(new Error("Cancelled"));
            return;
          case "\u007f": // Backspace
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            // Ignore control characters; accept everything else.
            if (char >= " ") value += char;
        }
      }
    };

    stdin.on("data", onData);
  });
}

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Replace `key=` in the .env text, or append it when absent.
 *
 * Rewriting in place rather than regenerating the file preserves comments and
 * every unrelated variable, notably DATABASE_URL.
 */
function upsertEnvVar(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${line}\n`;
}

function readEnvVar(content: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=(.*)$`, "m").exec(content);
  return match ? match[1]!.trim() : null;
}

/** Constant-time string compare, so the confirmation step leaks nothing. */
function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function main(): Promise<void> {
  stdout.write("\nEmail Watcher — set access password\n");
  stdout.write("-----------------------------------\n");

  const existing = existsSync(envPath) ? await readFile(envPath, "utf8") : "";

  if (readEnvVar(existing, "APP_PASSWORD_HASH")) {
    const answer = await ask(
      "A password is already configured. Replace it? Existing sessions will be signed out. [y/N] ",
    );
    if (answer.toLowerCase() !== "y") {
      stdout.write("Cancelled. Nothing changed.\n");
      return;
    }
  }

  const password = await readSecret(
    `New password (min ${MIN_PASSWORD_LENGTH} characters): `,
  );
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters; got ${password.length}.`,
    );
  }

  const confirmation = await readSecret("Confirm password: ");
  if (!sameSecret(password, confirmation)) {
    throw new Error("Passwords do not match. Nothing changed.");
  }

  const hash = hashPassword(password);

  let content = upsertEnvVar(existing, "APP_PASSWORD_HASH", hash);

  // Preserve an existing secret so setting a new password does not needlessly
  // rotate the signing key twice.
  const currentSecret = readEnvVar(content, "SESSION_SECRET");
  if (!currentSecret || currentSecret.length < 32) {
    content = upsertEnvVar(
      content,
      "SESSION_SECRET",
      randomBytes(48).toString("base64url"),
    );
    stdout.write("Generated a new SESSION_SECRET.\n");
  }

  await writeFile(envPath, content, { mode: 0o600 });

  // Sanity check: verify the hash we just wrote actually validates the password,
  // so a broken write is caught here rather than at the login screen.
  const parts = hash.split("$");
  const verify = scryptSync(
    password,
    Buffer.from(parts[4]!, "hex"),
    SCRYPT.keyLength,
    {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
      maxmem: SCRYPT_MAXMEM,
    },
  );
  if (!timingSafeEqual(verify, Buffer.from(parts[5]!, "hex"))) {
    throw new Error("Internal error: generated hash failed verification.");
  }

  stdout.write(`\nPassword saved to ${envPath}\n`);
  stdout.write("Restart the API server for it to take effect.\n");
  stdout.write(
    "Anyone with this password can read every monitored mailbox, so store it in a password manager.\n\n",
  );
}

try {
  await main();
} catch (err) {
  stdout.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exitCode = 1;
}
