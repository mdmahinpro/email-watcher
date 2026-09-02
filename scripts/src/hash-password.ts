/**
 * Print an scrypt hash for a password, for pasting into a host's environment
 * variable UI.
 *
 * Run with: pnpm --filter @workspace/scripts run hash-password
 *
 * `set-password` writes to a local `.env`, which is useless for a platform like
 * Render where there is no writable checkout and secrets are set in a dashboard.
 * This variant prints the values instead and touches no files.
 *
 * The plaintext is read without echo and never written anywhere.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { stdin, stdout } from "node:process";

const MIN_PASSWORD_LENGTH = 12;

// Must stay in sync with artifacts/api-server/src/lib/auth.ts.
const SCRYPT = { N: 65536, r: 8, p: 1, keyLength: 64, saltBytes: 16 } as const;
/** scrypt needs ~128*N*r bytes; Node's default maxmem of 32 MB is too low. */
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
 * `readline` has no masked input, so the terminal is switched to raw mode and
 * characters are consumed manually. Without this the password would be visible
 * on screen and left in the scrollback.
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
            if (char >= " ") value += char;
        }
      }
    };

    stdin.on("data", onData);
  });
}

/** Constant-time compare, so the confirmation step leaks nothing. */
function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function main(): Promise<void> {
  stdout.write("\nEmail Watcher — generate deployment credentials\n");
  stdout.write("----------------------------------------------\n");
  stdout.write("Nothing is written to disk; copy the values below into your\n");
  stdout.write("host's environment variable settings.\n\n");

  const password = await readSecret(
    `Password (min ${MIN_PASSWORD_LENGTH} characters): `,
  );
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters; got ${password.length}.`,
    );
  }

  const confirmation = await readSecret("Confirm password: ");
  if (!sameSecret(password, confirmation)) {
    throw new Error("Passwords do not match. Nothing generated.");
  }

  const hash = hashPassword(password);
  const sessionSecret = randomBytes(48).toString("base64url");

  // Verify what we are about to print actually validates the password, so a bad
  // value is caught here rather than at a login screen in production.
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

  stdout.write("\nSet these two environment variables:\n\n");
  stdout.write(`APP_PASSWORD_HASH=${hash}\n\n`);
  stdout.write(`SESSION_SECRET=${sessionSecret}\n\n`);
  stdout.write("Notes:\n");
  stdout.write("  - The hash is safe to paste into a dashboard; it is not the password.\n");
  stdout.write("  - Store the password itself in a password manager. It cannot be recovered from the hash.\n");
  stdout.write("  - Changing either value signs out all existing sessions.\n");
  stdout.write("  - Do NOT set AUTH_INSECURE_COOKIES in production.\n\n");
}

try {
  await main();
} catch (err) {
  stdout.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exitCode = 1;
}
