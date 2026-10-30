import { Router, type IRouter } from "express";
import { backupChunks, restoreBackup, RestoreError, BACKUP_VERSION } from "../lib/backup";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Download everything as one JSON file.
 *
 * Streamed in batches: a backup includes full message bodies and can be far
 * larger than the instance's memory, so the response is written incrementally
 * rather than built as one string. The file carries credentials (mailbox
 * passwords, the Telegram bot token), so the UI tells the operator to keep it
 * private.
 */
router.get("/backup", async (_req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="email-watcher-backup-${stamp}.json"`,
  );
  // No transform (compression) on the way out: streaming a generator through a
  // compressor buffers unpredictably, and the download is a deliberate act.
  res.setHeader("Cache-Control", "no-store");

  try {
    for await (const chunk of backupChunks()) {
      // Respect backpressure so a slow client cannot balloon the response buffer.
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
    res.end();
    logger.info("Backup downloaded");
  } catch (err) {
    logger.error({ err }, "Backup failed mid-stream");
    // Headers may already be sent; ending the response is all that is left. The
    // truncated JSON is obvious to the client and must not be restored.
    if (!res.headersSent) {
      res.status(500).json({ error: "InternalServerError", message: "Backup failed" });
    } else {
      res.end();
    }
  }
});

/**
 * Restore rows from a backup file.
 *
 * Merge-only: inserts skip anything that already exists, so this can never
 * delete a message or overwrite newer data. Run it on a fresh deployment to
 * recover everything, or on a live one to regain rows that were lost. The body
 * arrives already parsed; its size is governed by the raised JSON limit mounted
 * on this path in app.ts.
 */
router.post("/backup/restore", async (req, res) => {
  try {
    const result = await restoreBackup(req.body);
    res.json(result);
  } catch (err) {
    if (err instanceof RestoreError) {
      res.status(400).json({ error: "ValidationError", message: err.message });
      return;
    }
    logger.error({ err }, "Restore failed");
    res.status(500).json({
      error: "InternalServerError",
      message:
        err instanceof Error ? err.message : "Restore failed unexpectedly",
    });
  }
});

/** The version this build writes and accepts, so the UI can say so. */
router.get("/backup/version", (_req, res) => {
  res.json({ version: BACKUP_VERSION });
});

export default router;
