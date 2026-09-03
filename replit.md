# Email Watcher

## Overview

A web app that monitors multiple email inboxes via IMAP and surfaces only
the messages that match a configurable list of keywords (e.g. claim, $,
capterra, review, softwarereviews, eGift, Verify). Matched messages are
shown in a dashboard and (optionally) auto-forwarded to a single
"command" inbox via SMTP.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind + shadcn/ui + Recharts (artifacts/web)
- **API framework**: Express 5 (artifacts/api-server)
- **Database**: PostgreSQL + Drizzle ORM
- **IMAP/SMTP**: imapflow + nodemailer + mailparser
- **Validation**: Zod (generated schemas in lib/api-zod)
- **API codegen**: Orval (from OpenAPI spec at lib/api-spec/openapi.yaml)
- **Build**: esbuild (server bundle), vite (frontend)

## Artifacts

- `artifacts/web` — React + Vite frontend (Email Watcher dashboard) at `/`
- `artifacts/api-server` — Express API + IMAP polling scheduler at `/api`
- `artifacts/mockup-sandbox` — Replit canvas tooling

## Database Schema (lib/db/src/schema)

- `email_accounts` — per-inbox IMAP/SMTP credentials and last-seen UID.
  Soft-deleted via `deleted_at`: removing an account hides it everywhere and
  stops scanning it, but never destroys the messages that reference it.
  `provider` (`generic` | `hostinger`) records where the server settings came
  from. `capture_mode` (`keywords` | `all`) decides what a scan stores.
- `matched_messages` — the keyword triage queue. A row means "this needs
  attention"; it carries the matched keywords and the forwarding outcome, and
  feeds `/messages`, forwarding, and the keyword stats.
- `inbox_messages` — the unfiltered archive. Every message seen in a mailbox
  whose capture mode is `all`, with no keyword test and no forwarding. Feeds
  `/inbox`. Kept separate from `matched_messages` on purpose: mixing an archive
  into the triage queue would drown it and distort every match statistic.
- Both message tables share the column set in `message-content.ts`, including
  `body_text` and `body_html` (the complete message, capped at 128 KB and 512 KB
  respectively — an email with inline base64 images can be megabytes, and an
  uncapped column would fill a 500 MB free-tier database in a few hundred
  messages). `body_truncated` records when a cap was hit. `snippet` remains a
  320-character preview so list queries never read a body.
- Both message tables snapshot `account_label_snapshot` and
  `account_email_snapshot` at capture time, so history keeps showing the origin
  even after the account is renamed, re-pointed, or removed. Both FKs use
  `on delete restrict`, so a stray hard delete is refused rather than silently
  orphaning history.
- `app_settings` — singleton row with keywords, forward-to address, poll
  interval, forwarding toggle.

## Capture Modes

A scan reads each account's `capture_mode`:

- `keywords` (default for the Accounts page): subject, sender, and body are
  tested against the configured keywords. Matches go to `matched_messages` and
  are forwarded if forwarding is on. Non-matches are discarded.
- `all` (default for the Hostinger page): every message is archived to
  `inbox_messages`. No keyword test runs, and **forwarding is skipped** —
  relaying every arriving email would invite a mail loop.

The mode is switchable per account via `PATCH /accounts/:id`. Switching does not
migrate existing rows; it only changes where future scans write.

## Database Hosting

`lib/db/src/index.ts` reads `DATABASE_URL` and configures the pool itself:

- TLS is enabled automatically for any non-local host, so a Supabase, Neon, or
  RDS URL works without extra flags. An explicit `sslmode` in the URL wins; use
  `?sslmode=verify-full&sslrootcert=...` for full certificate verification.
- The pool defaults to 10 clients (`DATABASE_POOL_MAX` overrides) which suits
  Supabase's transaction pooler on port 6543.
- Idle-client errors are handled, so a provider restart cannot terminate the
  process.

See `.env.example` for the Supabase connection-string format.

## Backend Behaviour

- `artifacts/api-server/src/lib/scheduler.ts` runs `scanAllActiveAccounts` every
  `app_settings.pollIntervalSeconds` (default 120s, floor 30s). Restart-safe:
  `PUT /settings` re-arms the interval only when the cadence actually changed,
  and a tick is skipped while the previous one is still running.
- `artifacts/api-server/src/lib/scan-planner.ts` decides which UIDs to fetch. It
  uses a UID SEARCH rather than an open-ended `N:*` FETCH, because IMAP matches
  the highest existing UID when the lower bound is past the end of the mailbox;
  a plain range would re-download the newest message on every idle poll.
- `artifacts/api-server/src/lib/mail-scanner.ts` connects via IMAP, parses each
  new message, and either keyword-matches it into `matched_messages` or archives
  it into `inbox_messages`, depending on the account's capture mode. Up to 4
  accounts are scanned in parallel, and a concurrent scan of the same account
  reuses the in-flight scan rather than duplicating work.
- Forwarding happens after the IMAP connection is released, so a slow or dead
  SMTP destination cannot hold the mailbox open until the IMAP socket times out.
  Each message's outcome is written back to `matched_messages.forwarded` /
  `forward_error`.
- A never-scanned account only reads the newest 50 messages on its first pass,
  so adding an account does not download an entire mailbox.
- `last_uid_seen` is committed after each stored message, so a crash cannot
  replay mail that was already recorded.
- All scanner errors are logged into `email_accounts.last_error` and cleared on
  the next successful scan.

## Key API Routes (under /api)

- `GET /healthz` — returns 503 when the database is unreachable
- `GET /accounts` (optional `provider=generic|hostinger`), `POST /accounts`,
  `PATCH /accounts/:id`, `DELETE /accounts/:id`
  - `PATCH` is a partial update; omit `password` to keep the stored credential,
    and use `active` to pause/resume monitoring
  - `DELETE` is a soft delete; matched messages are retained
- `POST /accounts/bulk` — create many accounts in one request. Server settings
  default to `mail.<domain>` derived from each address, so a batch spanning many
  domains works without naming a host; an explicit `imapHost`/`smtpHost` overrides
  that for the whole batch. A mailbox may carry its own password or fall back to
  the batch one. Partial success: each address reports its own outcome, and
  duplicates or existing addresses are skipped rather than failing the batch
- `POST /accounts/hostinger` — create Hostinger mailboxes. Server settings come
  from `src/lib/providers.ts` (imap.hostinger.com:993 SSL, smtp.hostinger.com:465
  SSL or 587 STARTTLS), so the request only carries addresses and passwords. Each
  mailbox may bring its own password or fall back to a shared one. Defaults to
  `captureMode: "all"`
- `GET /accounts/hostinger/defaults` — the provider constants, so the UI cannot
  drift from the server
- `POST /accounts/:id/test` — IMAP connection test
- `POST /accounts/:id/scan` — manual scan trigger
- `POST /accounts/test-all` (optional `provider`, `activeOnly`) — test every
  account, 4 at a time. Per-account results; one failure never hides the rest.
  Paused accounts are included, since you may want to verify one before resuming
- `POST /accounts/scan-all` (optional `provider`) — scan every active account now.
  Paused accounts are always skipped, because pausing means do not poll
- `GET /messages` (`accountId`, `limit`, `offset`), `GET /messages/:id`,
  `DELETE /messages/:id` — keyword matches. The list omits bodies; `:id` returns
  the full message
- `GET /inbox` (`accountId`, `provider`, `search`, `limit`, `offset`),
  `GET /inbox/:id`, `DELETE /inbox/:id` — unfiltered archive. `search` is a
  case-insensitive substring match over subject, sender, and snippet
- `GET/PUT /settings`
- `GET /stats/summary` `/stats/keyword-breakdown` `/stats/account-activity`
- `GET /auth/session`, `POST /auth/login`, `POST /auth/logout` — the access gate
- Unmatched `/api/*` paths return a JSON 404 when authenticated, 401 otherwise.

Every route above except `/healthz` and `/auth/*` requires a session; see Access
Control. `email_accounts.password` is still stored in plaintext, so the database
itself remains sensitive.

## Access Control

The whole app is behind a single password. There is one operator, so there is no
user table: the scrypt hash lives in `APP_PASSWORD_HASH` and sessions are
stateless HMAC tokens in an httpOnly cookie.

Set the password with:

```
pnpm --filter @workspace/scripts run set-password
```

That writes `APP_PASSWORD_HASH` and `SESSION_SECRET` into the repo-root `.env`
(mode 600) and never stores the plaintext. Restart the API server afterwards.

How the gate works:

- `artifacts/api-server/src/middlewares/require-auth.ts` guards **every** `/api`
  route by allow-list. Only `/healthz` (the container probe) and `/auth/*` are
  public, so a newly added route is protected by default rather than by memory.
- The guard runs before routing, so an unauthenticated request cannot even
  enumerate which endpoints exist — an unknown `/api` path answers 401, not 404.
- With no password configured, every guarded route answers 503. It fails closed;
  a missing gate never means an open one. The server also refuses to boot in
  `NODE_ENV=production` without a password.
- Session tokens are signed with a key derived from `SESSION_SECRET` **and** the
  password hash, so changing the password revokes every existing session. That is
  the only revocation mechanism a stateless token has.
- Login is rate limited to 10 attempts per 15 minutes per IP, and a correct
  password does not bypass an active limit. Behind a proxy, set `TRUST_PROXY` so
  the limiter sees real client IPs.
- The frontend does not mount the app tree until the session resolves, and any
  401 from any request re-checks the session and drops back to the login screen.

`AUTH_INSECURE_COOKIES=true` drops the `Secure` cookie attribute for local
plain-HTTP development. Never set it on a real domain.

## Deploying free on Render + Supabase

One Render web service and one Supabase project. `render.yaml` is a Blueprint
that Render reads directly.

**Why one service:** the Express server also serves the built SPA
(`src/lib/static.ts`). Two origins would break auth — the session cookie is
`SameSite=Lax` and is not sent cross-site, so login would succeed and every
subsequent request would 401. It also keeps the app inside Render's free
allowance of **750 instance-hours** against a ~730-hour month; a second
always-on service would not fit.

**Why not Render's Postgres:** the free tier is deleted 30 days after creation
regardless of activity. Supabase free has no expiry, only a 1-week inactivity
pause that this app's traffic prevents.

Steps:

1. **Supabase** — create a project, then copy Settings ▸ Database ▸ Connection
   string ▸ *Connection pooling* (Transaction mode, port **6543**).
2. **Schema** — with that URL in your local `.env`, run
   `pnpm --filter @workspace/db run push`.
3. **Credentials** — `pnpm --filter @workspace/scripts run hash-password`. It
   prints `APP_PASSWORD_HASH` and `SESSION_SECRET` and writes nothing to disk.
4. **Render** — New ▸ Blueprint, point it at the repo. Then set the three
   `sync: false` variables (`DATABASE_URL`, `APP_PASSWORD_HASH`,
   `SESSION_SECRET`) and correct `FRONTEND_ORIGINS` to the real service URL.
5. **UptimeRobot** — monitor `https://<your-app>/api/healthz` every 5 minutes.
   This is load-bearing, not optional: Render stops a free web service after 15
   minutes without inbound traffic, and a stopped container runs no `setInterval`,
   so mailbox polling would silently cease. `/api/healthz` is outside the auth
   gate for exactly this reason.

   Use monitor type **HTTP(s)**, interval **5 minutes**, and set the keyword or
   expected status to 200. Do not point the monitor at `/api/readyz`: that one
   returns 503 while the database is down, which would page you for something the
   app recovers from on its own.

### Diagnosing a deployment

`/api/healthz` is public and self-describing, so a broken deployment can be
diagnosed without dashboard access:

```json
{ "status": "ok", "database": "ok", "databaseLatencyMs": 210,
  "databaseTarget": "supabase-pooler", "databasePort": 6543 }
```

- `database: "unreachable"` with `databaseTarget: "supabase-direct-ipv6-only"` —
  the direct Supabase host is IPv6-only and Render has no IPv6 egress. Switch to
  the pooler string.
- `databasePort` that is neither 6543 nor 5432 — something other than a Postgres
  port is in `DATABASE_URL`. The app's own `PORT` getting pasted there produces a
  silent connection timeout; `databaseWarning` says so explicitly.
- `databaseTarget: "unconfigured"` — `DATABASE_URL` is not set at all.

It reports a *category*, never the raw host, because the direct Supabase hostname
embeds the project ref and this endpoint is unauthenticated.

### Keeping the database alive

Two independent mechanisms, because the ping only helps while the service is up:

- The **heartbeat** (`src/lib/heartbeat.ts`) writes today's date into a
  one-row `heartbeat` table and deletes every other day's row, hourly and on
  boot. It is a real mutation (INSERT + DELETE, not an idempotent no-op), it does
  not depend on any mailbox being reachable, and the table never grows. The
  current date is shown on the Dashboard as proof it is running.
- Ordinary scan traffic, every `pollIntervalSeconds`.

### Free-tier limits that actually bite

- **Storage.** Supabase free is 500 MB. A message with its full body costs ~13 KB,
  so roughly 38,000 messages. Set a retention window in Settings; see below. The
  Dashboard warns past 80% of the ceiling.
- **Outbound SMTP is blocked** on Render free (ports 25/465/587). IMAP 993 is
  not. So monitoring and archiving work, but **forwarding does not** — leave
  Hostinger mailboxes in `all` capture mode, which skips forwarding anyway. If you
  need forwarding later, use an HTTP email API rather than SMTP.
- **Render may suspend** a free service that generates high outbound traffic,
  which a 2-minute IMAP poll plus an external database resembles. Raising
  `pollIntervalSeconds` to 300 halves that footprint.
- **Restarts are expected.** `last_uid_seen` is committed after every stored
  message and the scheduler catch-up scans 5 seconds after boot, so a restart
  loses nothing.

### Retention

Nothing else in the app deletes mail, so an archive-everything mailbox grows
without bound. Two independent windows in Settings, both defaulting to "keep
forever" so an upgrade never silently destroys data:

- **Clear bodies after N days** — drops `body_text`/`body_html` but keeps the row,
  its snippet, and its metadata. A row without a body is ~1 KB versus ~13 KB, so
  this recovers ~92% of the space while history stays searchable. Reach for this
  first.
- **Delete messages after N days** — removes the row outright. Only needed when
  even the metadata rows accumulate too far.

Applied hourly and immediately on save. A rescan backfills bodies that were
cleared, using `COALESCE` so an existing body is never overwritten.


`artifacts/web/public/` holds three hand-authored SVG marks:

- `logo.svg` — the full mark (envelope + notification badge), also inlined as
  `src/components/logo.tsx` for the app chrome and login screen.
- `favicon.svg` — thicker strokes and no badge gap, because at 16–32px thin
  detail disappears.
- `icon-maskable.svg` — Android adaptive icon; artwork stays inside the inner 80%
  safe zone so no crop shape clips it.

Raster outputs (`favicon.ico`, `apple-touch-icon.png`, `icon-192/512.png`,
`icon-maskable-512.png`) are generated from those and committed, so an app build
never needs sharp:

```
pnpm --filter @workspace/scripts run icons
```

## Frontend Notes

- Reading a message: `src/components/message-viewer.tsx` is a full-screen overlay
  with a maximize toggle, used by both Messages and Hostinger Inbox. Lists show
  only the 320-character snippet; the body is fetched on demand from the `:id`
  endpoint, so a 50-row page stays ~40 KB rather than megabytes.
  - Email HTML is untrusted and is **never** inserted into the app document. It
    is rendered in an `<iframe sandbox="">` — no `allow-scripts`, no
    `allow-same-origin`, so scripts cannot run and the frame has an opaque origin
    with no access to cookies or DOM — behind a CSP of `default-src 'none'`.
  - Remote images are blocked by default and are opt-in per message. Loading them
    tells the sender the address is live and being read.
  - Three view modes: rendered preview, plain text, and HTML source.

- Pages: Dashboard `/`, Messages `/messages`, Hostinger Inbox `/inbox`,
  Accounts `/accounts`, Hostinger `/hostinger`, Settings `/settings`.
  - **Messages** — keyword matches only, across all accounts in `keywords` mode.
  - **Hostinger Inbox** — the unfiltered archive, with search, mailbox filter,
    and pagination. Deliberately a separate list so an archive of everything
    cannot bury the keyword queue.
  - **Accounts** — the general screen: any IMAP/SMTP server, entered by hand,
    plus a bulk paste. Bulk Add defaults each mailbox to `mail.<its own domain>`
    (matching the usual MX convention for self-hosted domains) and accepts a
    password per line, so a list spanning many domains works in one paste. It
    previews the derived servers before creating anything. Defaults to keyword
    mode.
  - **Hostinger** — provider-specific: paste addresses (optionally with an inline
    password per line) and the Hostinger servers are filled in. Defaults to
    archiving all mail. Its accounts also appear on Accounts with a badge.
- Mobile-first. Every grid collapses to one column at the base breakpoint,
  interactive controls are at least 44px on touch and condense from `sm` up, and
  long unbreakable strings (addresses, hosts, errors) use the `pin-break`
  utility.
- Charts render explicit value labels rather than relying on recharts hover
  tooltips, which touch devices cannot open.
- `:hover` effects are gated behind `(hover: hover)` or `md:` so they do not
  latch after a tap; `active:` provides press feedback instead.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm run test` — run tests in every package that defines one
- `pnpm --filter @workspace/scripts run set-password` — set the access password (writes .env)
- `pnpm --filter @workspace/scripts run hash-password` — print credentials for a host's env vars
- `pnpm run build:deploy` — build the SPA then the server, as a host would
- `pnpm run start` — run the built server (serves the SPA too)
- `pnpm --filter @workspace/scripts run icons` — regenerate favicon/PWA rasters
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/web run dev` — run frontend locally

Local dev needs `DATABASE_URL` and `PORT` in the repo-root `.env` (the API server
and `drizzle-kit push` both read it). `docker-compose.yml` provisions a matching
local Postgres. The Vite dev server defaults to port 5173 and proxies `/api` to
`http://localhost:3001`; override with `API_PROXY_TARGET` if the API runs
elsewhere.
