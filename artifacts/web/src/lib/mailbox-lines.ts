/**
 * Shared parser for the mailbox textarea used by Bulk Add and the Hostinger page.
 *
 * One mailbox per line, with an optional password after the address. Separators
 * are comma, semicolon, colon, tab, or whitespace, so a paste from a spreadsheet,
 * a CSV export, or a hand-written list all work without reformatting.
 */

export interface ParsedMailbox {
  emailAddress: string;
  /** Present when the line carried its own password. */
  password?: string;
  /** Line number in the textarea, for error reporting. */
  line: number;
  valid: boolean;
  /** Domain part, lowercased. Null when the address is malformed. */
  domain: string | null;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function domainOf(emailAddress: string): string | null {
  const at = emailAddress.lastIndexOf("@");
  if (at <= 0 || at === emailAddress.length - 1) return null;
  const domain = emailAddress.slice(at + 1).toLowerCase();
  return domain.includes(".") ? domain : null;
}

/**
 * `mail.<domain>` for an address, mirroring the server's derivation so the UI can
 * preview exactly what will be used.
 */
export function deriveMailHost(emailAddress: string): string | null {
  const domain = domainOf(emailAddress);
  if (!domain) return null;
  return domain.startsWith("mail.") ? domain : `mail.${domain}`;
}

export function parseMailboxLines(raw: string): ParsedMailbox[] {
  const rows: ParsedMailbox[] = [];
  const seen = new Set<string>();

  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    // Split on the first separator only: passwords may themselves contain commas
    // or colons, so everything after the address is one field.
    const match = /^([^\s,;:\t]+)(?:[\s,;:\t]+(.*))?$/.exec(line);
    const emailAddress = (match?.[1] ?? line).trim();
    const password = match?.[2]?.trim();

    const key = emailAddress.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    rows.push({
      emailAddress,
      ...(password ? { password } : {}),
      line: index + 1,
      valid: EMAIL_SHAPE.test(emailAddress),
      domain: domainOf(emailAddress),
    });
  });

  return rows;
}

/** Distinct domains across parsed rows, in first-seen order. */
export function distinctDomains(rows: ParsedMailbox[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (!row.domain || seen.has(row.domain)) continue;
    seen.add(row.domain);
    out.push(row.domain);
  }
  return out;
}
