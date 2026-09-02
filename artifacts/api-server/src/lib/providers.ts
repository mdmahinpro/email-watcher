/**
 * Hostinger Email server defaults.
 *
 * Source: Hostinger support, "Set up Hostinger Email on your applications and
 * devices" — IMAP imap.hostinger.com:993 (SSL), SMTP smtp.hostinger.com:465
 * (SSL), with STARTTLS on 587 as the documented fallback when SSL on 465 is
 * blocked.
 *
 * These are shared by the API route and surfaced to the UI so the two cannot
 * drift apart.
 */
export const HOSTINGER = {
  imapHost: "imap.hostinger.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.hostinger.com",
  /** SSL on 465. */
  smtpPortSsl: 465,
  /** STARTTLS on 587; `secure` must be false so the connection upgrades. */
  smtpPortStartTls: 587,
} as const;

export type SmtpMode = "ssl" | "starttls";

export function hostingerSmtp(mode: SmtpMode): {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
} {
  return {
    smtpHost: HOSTINGER.smtpHost,
    smtpPort:
      mode === "starttls" ? HOSTINGER.smtpPortStartTls : HOSTINGER.smtpPortSsl,
    // nodemailer treats `secure: false` on 587 as "connect plain, then upgrade
    // via STARTTLS", which is what Hostinger documents for that port.
    smtpSecure: mode !== "starttls",
  };
}

export function hostingerImap(): {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
} {
  return {
    imapHost: HOSTINGER.imapHost,
    imapPort: HOSTINGER.imapPort,
    imapSecure: HOSTINGER.imapSecure,
  };
}
