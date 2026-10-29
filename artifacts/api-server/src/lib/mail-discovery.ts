/**
 * Find a domain's real mail server when the configured guess is wrong.
 *
 * Bulk add defaults every address to `mail.<domain>`, which is the common
 * convention but far from universal: plenty of domains run their IMAP on the
 * bare domain, on `imap.<domain>`, or on whatever host their MX record names.
 * A wrong guess used to surface later as `getaddrinfo ENOTFOUND mail.<domain>`
 * on the account card, with nothing but a manual lookup to fix it.
 *
 * Discovery answers that automatically: it collects candidate hostnames,
 * resolves the domain's MX records, and probes each candidate until one
 * answers with a real IMAP (`* OK` / `* PREAUTH`) or SMTP (`220`) greeting.
 * A greeting, not just an open socket, is required because a web server on
 * the same host also accepts the connection and would otherwise be recorded
 * as the mail server.
 */
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { domainOf } from "./mail-host";
import { logger } from "./logger";

/**
 * How long a single host+port probe waits for a greeting.
 *
 * Kept short: a bulk add probes several domains, and a firewalled port (the
 * usual reason a probe fails) burns the whole timeout silently.
 */
const PROBE_TIMEOUT_MS = 5_000;

export interface DiscoveredServer {
  host: string;
  port: number;
  /** True for implicit TLS (IMAPS 993 / SMTPS 465), false for STARTTLS-capable plain ports. */
  secure: boolean;
}

/**
 * Candidate IMAP hostnames, best guess first.
 *
 * The MX hosts come last: they are the most likely to be right, but they are
 * also the slowest to collect, and the cheap guesses often win before DNS is
 * even consulted.
 */
export function imapCandidates(domain: string, mxHosts: string[] = []): string[] {
  return dedupe([
    domain.startsWith("mail.") ? domain : `mail.${domain}`,
    `imap.${domain}`,
    domain,
    ...mxHosts,
  ]);
}

/** Candidate SMTP hostnames, same policy as {@link imapCandidates}. */
export function smtpCandidates(domain: string, mxHosts: string[] = []): string[] {
  return dedupe([
    domain.startsWith("mail.") ? domain : `mail.${domain}`,
    `smtp.${domain}`,
    domain,
    ...mxHosts,
  ]);
}

function dedupe(hosts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hosts) {
    const key = h.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * The domain's MX hosts, highest priority first, or an empty list when the
 * domain has no MX records (or DNS fails — never an error for the caller).
 */
export async function mxHostsFor(domain: string): Promise<string[]> {
  try {
    const records = await dns.resolveMx(domain);
    return dedupe(
      records
        .filter((r) => r.exchange && r.exchange !== ".")
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange),
    );
  } catch {
    // No MX at all, a null MX (`.`), a resolver outage, or a domain that only
    // publishes an A record. The conventional candidates still get their turn.
    return [];
  }
}

/**
 * Wait for the server's first response line and test it against `pattern`.
 *
 * The greeting is what distinguishes a mail server from anything else that
 * happens to listen: an HTTP server answers with `HTTP/...` or nothing until
 * spoken to, an SSH server with `SSH-`, while IMAP opens with `* OK` and SMTP
 * with `220`.
 */
function readFirstLine(
  socket: net.Socket | tls.TLSSocket,
  pattern: RegExp,
  onResult: (ok: boolean) => void,
): void {
  let buffer = "";
  const finish = (ok: boolean) => {
    socket.removeListener("data", onData);
    socket.removeListener("error", onError);
    socket.destroy();
    onResult(ok);
  };
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      finish(pattern.test(buffer.slice(0, newline)));
    } else if (buffer.length > 512) {
      finish(false);
    }
  };
  const onError = () => finish(false);
  socket.on("data", onData);
  socket.on("error", onError);
}

function probe(
  host: string,
  port: number,
  useTls: boolean,
  greeting: RegExp,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const socket: net.Socket | tls.TLSSocket = useTls
      ? tls.connect({ host, port, rejectUnauthorized: false, servername: host })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      done(false);
    }, PROBE_TIMEOUT_MS);

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on("error", () => done(false));
    socket.on("timeout", () => {
      socket.destroy();
      done(false);
    });
    readFirstLine(socket, greeting, done);
  });
}

const IMAP_GREETING = /^\*\s+(OK|PREAUTH)/i;
const SMTP_GREETING = /^220/;

interface PortSpec {
  port: number;
  secure: boolean;
  useTls: boolean;
  greeting: RegExp;
}

const IMAP_PORTS: PortSpec[] = [
  { port: 993, secure: true, useTls: true, greeting: IMAP_GREETING },
  // A plain 143 greeting means STARTTLS is available on the same socket; the
  // scanner connects with secure=false and lets imapflow negotiate the upgrade.
  { port: 143, secure: false, useTls: false, greeting: IMAP_GREETING },
];

const SMTP_PORTS: PortSpec[] = [
  { port: 465, secure: true, useTls: true, greeting: SMTP_GREETING },
  { port: 587, secure: false, useTls: false, greeting: SMTP_GREETING },
];

/**
 * Probe every candidate host in parallel, each host trying its ports in
 * order, and keep the first success by candidate priority.
 *
 * Parallel rather than sequential because most candidates fail by timeout —
 * a firewalled port drops the SYN — and waiting them out one by one turns a
 * bulk add into minutes of hanging request.
 */
async function probeCandidates(
  candidates: string[],
  ports: PortSpec[],
): Promise<DiscoveredServer | null> {
  const results = await Promise.all(
    candidates.map(async (host) => {
      for (const { port, secure, useTls, greeting } of ports) {
        if (await probe(host, port, useTls, greeting)) {
          return { host, port, secure };
        }
      }
      return null;
    }),
  );
  return results.find((r): r is DiscoveredServer => r !== null) ?? null;
}

/**
 * Find a domain's IMAP and SMTP servers in one pass, sharing a single MX
 * lookup. Either result is null when no candidate answered.
 */
export async function discoverMailServers(
  emailAddressOrDomain: string,
): Promise<{ imap: DiscoveredServer | null; smtp: DiscoveredServer | null }> {
  const domain =
    domainOf(emailAddressOrDomain) ?? emailAddressOrDomain.toLowerCase();
  const mx = await mxHostsFor(domain);

  const [imap, smtp] = await Promise.all([
    probeCandidates(imapCandidates(domain, mx), IMAP_PORTS),
    probeCandidates(smtpCandidates(domain, mx), SMTP_PORTS),
  ]);

  if (imap) {
    logger.info({ domain, ...imap }, "Discovered IMAP server");
  }
  if (smtp) {
    logger.info({ domain, ...smtp }, "Discovered SMTP server");
  }
  return { imap, smtp };
}

/**
 * Find the domain's IMAP server alone, or null when no candidate answers.
 *
 * Takes an email address or a domain, so callers do not have to split it.
 */
export async function discoverImapServer(
  emailAddressOrDomain: string,
): Promise<DiscoveredServer | null> {
  const domain =
    domainOf(emailAddressOrDomain) ?? emailAddressOrDomain.toLowerCase();
  const mx = await mxHostsFor(domain);
  return probeCandidates(imapCandidates(domain, mx), IMAP_PORTS);
}

/** Find the domain's SMTP server alone, or null when no candidate answers. */
export async function discoverSmtpServer(
  emailAddressOrDomain: string,
): Promise<DiscoveredServer | null> {
  const domain =
    domainOf(emailAddressOrDomain) ?? emailAddressOrDomain.toLowerCase();
  const mx = await mxHostsFor(domain);
  return probeCandidates(smtpCandidates(domain, mx), SMTP_PORTS);
}
