import { Router, type IRouter } from "express";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getSettings, updateSettings } from "../lib/settings";
import { restartScheduler } from "../lib/scheduler";
import { applyRetentionSafely } from "../lib/retention";
import { sendTelegramTestMessage, telegramActive } from "../lib/telegram";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The bot token is a secret, so it is never serialized back. The UI gets a
 * boolean instead and sends the token only when it is being replaced.
 */
function serialize(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    keywords: s.keywords,
    criticalKeywords: s.criticalKeywords,
    forwardToEmail: s.forwardToEmail,
    pollIntervalSeconds: s.pollIntervalSeconds,
    forwardingEnabled: s.forwardingEnabled,
    telegramEnabled: s.telegramEnabled,
    telegramBotTokenSet: Boolean(s.telegramBotToken?.trim()),
    telegramChatId: s.telegramChatId,
    appUrl: s.appUrl,
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
    criticalKeywords: body.criticalKeywords,
    forwardToEmail:
      body.forwardToEmail !== undefined ? body.forwardToEmail : undefined,
    pollIntervalSeconds: body.pollIntervalSeconds,
    forwardingEnabled: body.forwardingEnabled,
    telegramEnabled: body.telegramEnabled,
    // Omitted means "keep the stored token"; an empty string clears it.
    telegramBotToken:
      body.telegramBotToken !== undefined
        ? body.telegramBotToken.trim() || null
        : undefined,
    telegramChatId:
      body.telegramChatId !== undefined
        ? body.telegramChatId?.trim() || null
        : undefined,
    appUrl:
      body.appUrl !== undefined ? body.appUrl?.trim() || null : undefined,
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

/**
 * Send a test Telegram message using the stored configuration.
 *
 * The button exists because the rest of the setup is silent: a typo'd chat id
 * or a token from the wrong bot otherwise surfaces only when a critical match
 * fails to arrive, which is the worst possible moment to debug it.
 */
router.post("/settings/telegram-test", async (_req, res) => {
  const settings = await getSettings();
  const result = await sendTelegramTestMessage({
    telegramEnabled: settings.telegramEnabled,
    telegramBotToken: settings.telegramBotToken,
    telegramChatId: settings.telegramChatId,
  });

  if (!result.ok && !telegramActive({
    telegramEnabled: settings.telegramEnabled,
    telegramBotToken: settings.telegramBotToken,
    telegramChatId: settings.telegramChatId,
  })) {
    // A configuration problem, not a Telegram outage: the stored settings are
    // incomplete, and the message already says what is missing.
    res.json(result);
    return;
  }

  logger.info({ ok: result.ok }, "Telegram test message attempted");
  res.json(result);
});

export default router;
