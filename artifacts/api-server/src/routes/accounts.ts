import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, emailAccountsTable } from "@workspace/db";
import {
  CreateAccountBody,
  CreateAccountsBulkBody,
  CreateHostingerAccountsBody,
  ListAccountsQueryParams,
  UpdateAccountBody,
  UpdateAccountParams,
  DeleteAccountParams,
  TestAccountParams,
  ScanAccountParams,
} from "@workspace/api-zod";
import { testAccountConnection, scanAccount } from "../lib/mail-scanner";
import { HOSTINGER, hostingerImap, hostingerSmtp } from "../lib/providers";
import { deriveMailHost } from "../lib/mail-host";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Only rows that have not been soft-deleted are visible through the API. */
const notDeleted = isNull(emailAccountsTable.deletedAt);

function serialize(a: typeof emailAccountsTable.$inferSelect) {
  // Strip the credential and internal bookkeeping from API responses.
  const {
    password: _password,
    lastUidSeen: _lastUidSeen,
    deletedAt: _deletedAt,
    ...rest
  } = a;
  return {
    ...rest,
    lastCheckedAt: a.lastCheckedAt ? a.lastCheckedAt.toISOString() : null,
    lastError: a.lastError ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

async function findLiveAccount(id: number) {
  const [row] = await db
    .select()
    .from(emailAccountsTable)
    .where(and(eq(emailAccountsTable.id, id), notDeleted))
    .limit(1);
  return row;
}

/**
 * Insert prepared account rows one at a time, reporting per-address outcomes.
 *
 * Shared by the bulk and Hostinger endpoints. Partial success is the useful
 * behaviour: one malformed or duplicate address must not discard the rest of a
 * long paste, so each address reports its own result and the request succeeds.
 */
async function insertAccountsIndividually(
  candidates: Array<typeof emailAccountsTable.$inferInsert>,
  failed: Array<{ emailAddress: string; reason: string }>,
) {
  const created: Array<ReturnType<typeof serialize>> = [];
  for (const candidate of candidates) {
    try {
      const [row] = await db
        .insert(emailAccountsTable)
        .values(candidate)
        .returning();
      created.push(serialize(row!));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, emailAddress: candidate.emailAddress },
        "Account create failed",
      );
      failed.push({ emailAddress: candidate.emailAddress, reason });
    }
  }
  return created;
}

/** Drop candidates whose address already belongs to a live account. */
async function rejectExistingAddresses(
  candidates: Array<typeof emailAccountsTable.$inferInsert>,
  failed: Array<{ emailAddress: string; reason: string }>,
) {
  if (candidates.length === 0) return;

  const addresses = candidates.map((c) => c.emailAddress);
  const existing = await db
    .select({ emailAddress: emailAccountsTable.emailAddress })
    .from(emailAccountsTable)
    .where(and(inArray(emailAccountsTable.emailAddress, addresses), notDeleted));
  const taken = new Set(existing.map((r) => r.emailAddress.toLowerCase()));

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (taken.has(candidate.emailAddress.toLowerCase())) {
      failed.push({
        emailAddress: candidate.emailAddress,
        reason: "An account with this address already exists",
      });
      candidates.splice(i, 1);
    }
  }
}

/** Restore the caller's ordering after the reject/insert passes reorder it. */
function sortFailuresByInputOrder(
  failed: Array<{ emailAddress: string; reason: string }>,
  inputAddresses: string[],
) {
  const order = new Map(
    inputAddresses.map((a, i) => [a.trim().toLowerCase(), i]),
  );
  failed.sort(
    (a, b) =>
      (order.get(a.emailAddress.toLowerCase()) ?? 0) -
      (order.get(b.emailAddress.toLowerCase()) ?? 0),
  );
}

router.get("/accounts", async (req, res) => {
  const params = ListAccountsQueryParams.parse({
    provider: req.query["provider"],
  });

  const where =
    params.provider !== undefined
      ? and(notDeleted, eq(emailAccountsTable.provider, params.provider))
      : notDeleted;

  const rows = await db
    .select()
    .from(emailAccountsTable)
    .where(where)
    .orderBy(asc(emailAccountsTable.createdAt));
  res.json(rows.map(serialize));
});

router.post("/accounts", async (req, res) => {
  const body = CreateAccountBody.parse(req.body);
  const [created] = await db
    .insert(emailAccountsTable)
    .values({
      label: body.label,
      emailAddress: body.emailAddress,
      provider: "generic",
      imapHost: body.imapHost,
      imapPort: body.imapPort ?? 993,
      imapSecure: body.imapSecure ?? true,
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort ?? 465,
      smtpSecure: body.smtpSecure ?? true,
      username: body.username,
      password: body.password,
      // The generic form is the keyword-triage path.
      captureMode: "keywords",
      active: true,
    })
    .returning();
  res.status(201).json(serialize(created!));
});

/**
 * Bulk create.
 *
 * Server settings default to `mail.<domain>` derived per address, so one paste can
 * cover mailboxes on many different domains — a single shared host cannot. An
 * explicit `imapHost`/`smtpHost` overrides that for the whole batch, for the case
 * where every mailbox really is on one server.
 *
 * Passwords work the same way: a mailbox may carry its own, or fall back to the
 * batch password. Twelve domains almost always means twelve passwords.
 */
router.post("/accounts/bulk", async (req, res) => {
  const body = CreateAccountsBulkBody.parse(req.body);

  const failed: Array<{ emailAddress: string; reason: string }> = [];
  const seen = new Set<string>();
  const candidates: Array<typeof emailAccountsTable.$inferInsert> = [];

  for (const entry of body.accounts) {
    const emailAddress = entry.emailAddress.trim();
    const key = emailAddress.toLowerCase();

    if (seen.has(key)) {
      failed.push({ emailAddress, reason: "Duplicate address in this request" });
      continue;
    }
    seen.add(key);

    const password = entry.password ?? body.password;
    if (!password) {
      failed.push({
        emailAddress,
        reason:
          "No password for this mailbox, and no shared password was provided",
      });
      continue;
    }

    // An explicit batch host wins; otherwise derive from this address's domain.
    const derived = deriveMailHost(emailAddress);
    const imapHost = body.imapHost ?? derived;
    const smtpHost = body.smtpHost ?? derived;
    if (!imapHost || !smtpHost) {
      failed.push({
        emailAddress,
        reason:
          "Could not derive a mail server from this address. Supply a host explicitly.",
      });
      continue;
    }

    candidates.push({
      label: entry.label?.trim() || emailAddress,
      emailAddress,
      provider: "generic",
      imapHost,
      imapPort: body.imapPort,
      imapSecure: body.imapSecure,
      smtpHost,
      smtpPort: body.smtpPort,
      smtpSecure: body.smtpSecure,
      username: entry.username?.trim() || emailAddress,
      password,
      captureMode: "keywords",
      active: true,
    });
  }

  await rejectExistingAddresses(candidates, failed);
  const created = await insertAccountsIndividually(candidates, failed);
  sortFailuresByInputOrder(
    failed,
    body.accounts.map((a) => a.emailAddress),
  );

  logger.info(
    {
      created: created.length,
      failed: failed.length,
      derivedHosts: body.imapHost === undefined,
    },
    "Bulk account create complete",
  );
  res.json({ created, failed });
});

/** Hostinger's published IMAP/SMTP settings, so the UI cannot drift from them. */
router.get("/accounts/hostinger/defaults", (_req, res) => {
  res.json({
    imapHost: HOSTINGER.imapHost,
    imapPort: HOSTINGER.imapPort,
    imapSecure: HOSTINGER.imapSecure,
    smtpHost: HOSTINGER.smtpHost,
    smtpPortSsl: HOSTINGER.smtpPortSsl,
    smtpPortStartTls: HOSTINGER.smtpPortStartTls,
  });
});

/**
 * Add Hostinger mailboxes without asking for server settings.
 *
 * Hostinger uses one set of hosts for every mailbox, so the request only carries
 * addresses and passwords. A mailbox may bring its own password, or fall back to
 * the shared one; Hostinger mailbox passwords are per-mailbox by default, so
 * both shapes are common in practice.
 */
router.post("/accounts/hostinger", async (req, res) => {
  const body = CreateHostingerAccountsBody.parse(req.body);
  const imap = hostingerImap();
  const smtp = hostingerSmtp(body.smtpMode);

  const failed: Array<{ emailAddress: string; reason: string }> = [];
  const seen = new Set<string>();
  const candidates: Array<typeof emailAccountsTable.$inferInsert> = [];

  for (const mailbox of body.mailboxes) {
    const emailAddress = mailbox.emailAddress.trim();
    const key = emailAddress.toLowerCase();

    if (seen.has(key)) {
      failed.push({ emailAddress, reason: "Duplicate mailbox in this request" });
      continue;
    }
    seen.add(key);

    const password = mailbox.password ?? body.password;
    if (!password) {
      failed.push({
        emailAddress,
        reason:
          "No password for this mailbox, and no shared password was provided",
      });
      continue;
    }

    candidates.push({
      label: mailbox.label?.trim() || emailAddress,
      emailAddress,
      provider: "hostinger",
      // Hostinger mailboxes archive everything by default; the request may opt
      // an individual batch into keyword triage instead.
      captureMode: body.captureMode,
      ...imap,
      ...smtp,
      // Hostinger authenticates with the full email address.
      username: emailAddress,
      password,
      active: true,
    });
  }

  await rejectExistingAddresses(candidates, failed);
  const created = await insertAccountsIndividually(candidates, failed);
  sortFailuresByInputOrder(
    failed,
    body.mailboxes.map((m) => m.emailAddress),
  );

  logger.info(
    {
      created: created.length,
      failed: failed.length,
      smtpMode: body.smtpMode,
      captureMode: body.captureMode,
    },
    "Hostinger account create complete",
  );
  res.json({ created, failed });
});

router.patch("/accounts/:id", async (req, res) => {
  const { id } = UpdateAccountParams.parse({ id: Number(req.params["id"]) });
  const body = UpdateAccountBody.parse(req.body);

  const existing = await findLiveAccount(id);
  if (!existing) {
    res.status(404).json({ error: "NotFound", message: "Account not found" });
    return;
  }

  // Only assign keys that were actually supplied, so an omitted field never
  // overwrites a stored value (notably `password`).
  const patch: Partial<typeof emailAccountsTable.$inferInsert> = {};
  if (body.label !== undefined) patch.label = body.label;
  if (body.emailAddress !== undefined) patch.emailAddress = body.emailAddress;
  if (body.imapHost !== undefined) patch.imapHost = body.imapHost;
  if (body.imapPort !== undefined) patch.imapPort = body.imapPort;
  if (body.imapSecure !== undefined) patch.imapSecure = body.imapSecure;
  if (body.smtpHost !== undefined) patch.smtpHost = body.smtpHost;
  if (body.smtpPort !== undefined) patch.smtpPort = body.smtpPort;
  if (body.smtpSecure !== undefined) patch.smtpSecure = body.smtpSecure;
  if (body.username !== undefined) patch.username = body.username;
  if (body.password !== undefined) patch.password = body.password;
  if (body.active !== undefined) patch.active = body.active;
  if (body.captureMode !== undefined) patch.captureMode = body.captureMode;

  // UIDs are only meaningful within one mailbox. If the account now points at a
  // different mailbox, the stored high-water mark is meaningless, so drop it and
  // let the next scan re-establish a baseline. Messages already captured keep
  // their own label/address snapshot, so history is unaffected.
  const mailboxChanged =
    (body.imapHost !== undefined && body.imapHost !== existing.imapHost) ||
    (body.username !== undefined && body.username !== existing.username) ||
    (body.emailAddress !== undefined &&
      body.emailAddress !== existing.emailAddress);
  if (mailboxChanged) {
    patch.lastUidSeen = null;
  }

  // A stored failure describes the old connection settings, so clear it when the
  // connection is reconfigured or the account is re-enabled. A cosmetic change
  // (e.g. label only) leaves the error visible.
  const connectionChanged =
    mailboxChanged ||
    body.imapPort !== undefined ||
    body.imapSecure !== undefined ||
    body.smtpHost !== undefined ||
    body.smtpPort !== undefined ||
    body.smtpSecure !== undefined ||
    body.password !== undefined;
  if (connectionChanged || body.active === true) {
    patch.lastError = null;
  }

  if (Object.keys(patch).length === 0) {
    res.json(serialize(existing));
    return;
  }

  const [updated] = await db
    .update(emailAccountsTable)
    .set(patch)
    .where(and(eq(emailAccountsTable.id, id), notDeleted))
    .returning();
  res.json(serialize(updated!));
});

/**
 * Soft delete.
 *
 * Matched messages reference the account and carry a snapshot of its label and
 * address, so removing an account must not destroy that history. The row is
 * marked deleted and deactivated: it disappears from every listing and from
 * scanning, while historical messages remain intact and attributable.
 */
router.delete("/accounts/:id", async (req, res) => {
  const { id } = DeleteAccountParams.parse({ id: Number(req.params["id"]) });
  await db
    .update(emailAccountsTable)
    .set({ deletedAt: new Date(), active: false })
    .where(and(eq(emailAccountsTable.id, id), notDeleted));
  res.status(204).end();
});

router.post("/accounts/:id/test", async (req, res) => {
  const { id } = TestAccountParams.parse({ id: Number(req.params["id"]) });
  const acct = await findLiveAccount(id);
  if (!acct) {
    res.status(404).json({ ok: false, message: "Account not found" });
    return;
  }
  const result = await testAccountConnection(acct);
  res.json(result);
});

router.post("/accounts/:id/scan", async (req, res) => {
  const { id } = ScanAccountParams.parse({ id: Number(req.params["id"]) });
  const acct = await findLiveAccount(id);
  if (!acct) {
    res.status(404).json({
      scanned: 0,
      matched: 0,
      forwarded: 0,
      message: "Account not found",
    });
    return;
  }
  const result = await scanAccount(acct);
  res.json(result);
});

export default router;
