import { Router, type IRouter } from "express";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getSettings, updateSettings } from "../lib/settings";
import { restartScheduler } from "../lib/scheduler";
import { applyRetentionSafely } from "../lib/retention";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function serialize(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    keywords: s.keywords,
    forwardToEmail: s.forwardToEmail,
    pollIntervalSeconds: s.pollIntervalSeconds,
    forwardingEnabled: s.forwardingEnabled,
    retainBodiesDays: s.retainBodiesDays,
    retainMessagesDays: s.retainMessagesDays,
  };
}

router.get("/settings", async (_req, res) => {
  const s = await getSettings();
  res.json(serialize(s));
});

router.put("/settings", async (req, res) => {
  const body = UpdateSettingsBody.parse(req.body);
  const previous = await getSettings();
  const updated = await updateSettings({
    keywords: body.keywords,
    forwardToEmail:
      body.forwardToEmail !== undefined ? body.forwardToEmail : undefined,
    pollIntervalSeconds: body.pollIntervalSeconds,
    forwardingEnabled: body.forwardingEnabled,
    retainBodiesDays: body.retainBodiesDays,
    retainMessagesDays: body.retainMessagesDays,
  });
  // Re-arm only when the cadence actually changed.
  if (updated.pollIntervalSeconds !== previous.pollIntervalSeconds) {
    await restartScheduler().catch((err: unknown) => {
      logger.error({ err }, "Failed to restart scheduler after settings update");
    });
  }

  // Applying a shorter retention window should take effect now, not up to an
  // hour later, since the reason for shortening it is usually a full database.
  const retentionTightened =
    (updated.retainBodiesDays > 0 &&
      updated.retainBodiesDays !== previous.retainBodiesDays) ||
    (updated.retainMessagesDays > 0 &&
      updated.retainMessagesDays !== previous.retainMessagesDays);
  if (retentionTightened) {
    void applyRetentionSafely();
  }

  res.json(serialize(updated));
});

export default router;
