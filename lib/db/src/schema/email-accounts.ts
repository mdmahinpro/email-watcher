import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Where an account's server settings came from.
 *
 * `hostinger` accounts were created through the Hostinger screen, which fills in
 * imap.hostinger.com / smtp.hostinger.com for the user. The value is only a
 * provenance label: scanning treats every account identically, so a Hostinger
 * account whose host is later edited still works, it is just no longer at the
 * provider defaults.
 */
export const ACCOUNT_PROVIDERS = ["generic", "hostinger"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

/**
 * What a scan does with the mail it finds.
 *
 * - `keywords`: only messages matching a configured keyword are stored, into
 *   `matched_messages`, and those are what get forwarded. This is the triage
 *   behaviour the app was built around.
 * - `all`: every message is archived into `inbox_messages` with no keyword test
 *   and no forwarding. Used for mailboxes you want a complete record of rather
 *   than an attention queue. Forwarding is deliberately skipped here: relaying
 *   every arriving email would be a mail loop waiting to happen.
 */
export const CAPTURE_MODES = ["keywords", "all"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export const emailAccountsTable = pgTable(
  "email_accounts",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    emailAddress: text("email_address").notNull(),
    provider: text("provider")
      .$type<AccountProvider>()
      .notNull()
      .default("generic"),
    captureMode: text("capture_mode")
      .$type<CaptureMode>()
      .notNull()
      .default("keywords"),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull().default(993),
    imapSecure: boolean("imap_secure").notNull().default(true),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull().default(465),
    smtpSecure: boolean("smtp_secure").notNull().default(true),
    username: text("username").notNull(),
    password: text("password").notNull(),
    /**
     * Accept a TLS certificate that does not match the hostname.
     *
     * Shared cPanel hosting routinely serves the provider's own certificate on
     * `mail.<customer-domain>` — e.g. GoDaddy answers with
     * `*.prod.sin2.secureserver.net` — so a strict client rejects the connection
     * with ERR_TLS_CERT_ALTNAME_INVALID even though the credentials are fine and
     * webmail works. This is the same "accept this certificate" decision every
     * desktop mail client offers.
     *
     * Off by default: enabling it means a man-in-the-middle can present any
     * certificate, so it must be a deliberate per-account choice.
     */
    allowInvalidCert: boolean("allow_invalid_cert").notNull().default(false),
    active: boolean("active").notNull().default(true),
    lastUidSeen: integer("last_uid_seen"),
    lastCheckedAt: timestamp("last_checked_at"),
    lastError: text("last_error"),
    /**
     * Soft delete. Removing an account must never destroy the matched-message
     * history that references it, so "delete" sets this timestamp instead of
     * issuing a DELETE. Rows with a value here are excluded from every listing,
     * from scanning, and from stats, but stay joinable by historical messages.
     */
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Every account listing and every scan sweep filters on these two columns.
    index("email_accounts_active_idx").on(t.deletedAt, t.active),
    // The Hostinger screen lists only its own accounts.
    index("email_accounts_provider_idx").on(t.provider, t.deletedAt),
  ],
);

export type EmailAccount = typeof emailAccountsTable.$inferSelect;
export type InsertEmailAccount = typeof emailAccountsTable.$inferInsert;
