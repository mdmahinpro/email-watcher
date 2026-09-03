/**
 * Derive a mail server hostname from an email address.
 *
 * `mail.<domain>` is the near-universal convention for a domain that runs its own
 * mail service, and it matches the MX records of self-hosted and reseller setups
 * (mail.example.com). Deriving it per address is what lets one bulk paste cover
 * mailboxes on many different domains — a single shared host cannot.
 *
 * This is a *default*, not a guarantee: providers that terminate mail elsewhere
 * (Microsoft 365, Google Workspace, Hostinger) need their own host, which the
 * caller supplies explicitly or corrects on the account afterwards.
 */

/** The domain part of an address, lowercased, or null when malformed. */
export function domainOf(emailAddress: string): string | null {
  const at = emailAddress.lastIndexOf("@");
  if (at <= 0 || at === emailAddress.length - 1) return null;

  const domain = emailAddress.slice(at + 1).trim().toLowerCase();
  // A bare label with no dot cannot be a public mail domain, and an address that
  // still contains whitespace was never valid.
  if (!domain.includes(".") || /\s/.test(domain)) return null;

  return domain;
}

/**
 * `mail.<domain>` for the given address, or null when the domain is unusable.
 *
 * A domain that already begins with `mail.` is returned unchanged rather than
 * becoming `mail.mail.example.com`.
 */
export function deriveMailHost(emailAddress: string): string | null {
  const domain = domainOf(emailAddress);
  if (!domain) return null;
  return domain.startsWith("mail.") ? domain : `mail.${domain}`;
}

/** Distinct domains across a set of addresses, in first-seen order. */
export function distinctDomains(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses) {
    const domain = domainOf(address);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}
