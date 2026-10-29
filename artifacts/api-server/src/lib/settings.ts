import { eq } from "drizzle-orm";
import { db, appSettingsTable, type AppSettings } from "@workspace/db";

const DEFAULT_KEYWORDS = [
  "claim",
  "$",
  "capterra",
  "review",
  "softwarereviews",
  "eGift",
  "Verify",
];

/**
 * `app_settings` holds a single row. Reads and writes always target the lowest
 * id so that a stray extra row can never make the effective settings depend on
 * physical row order.
 */
export async function getSettings(): Promise<AppSettings> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .orderBy(appSettingsTable.id)
    .limit(1);
  if (rows.length > 0) return rows[0]!;

  const [created] = await db
    .insert(appSettingsTable)
    .values({
      keywords: DEFAULT_KEYWORDS,
      criticalKeywords: [],
      forwardToEmail: null,
      pollIntervalSeconds: 120,
      forwardingEnabled: true,
      telegramEnabled: false,
      telegramBotToken: null,
      telegramChatId: null,
      appUrl: null,
    })
    .returning();
  return created!;
}

export async function updateSettings(
  patch: Partial<{
    keywords: string[];
    criticalKeywords: string[];
    forwardToEmail: string | null;
    pollIntervalSeconds: number;
    forwardingEnabled: boolean;
    telegramEnabled: boolean;
    telegramBotToken: string | null;
    telegramChatId: string | null;
    appUrl: string | null;
    retainBodiesDays: number;
    retainMessagesDays: number;
  }>,
): Promise<AppSettings> {
  const current = await getSettings();
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      keywords: patch.keywords ?? current.keywords,
      criticalKeywords: patch.criticalKeywords ?? current.criticalKeywords,
      forwardToEmail:
        patch.forwardToEmail !== undefined
          ? patch.forwardToEmail
          : current.forwardToEmail,
      pollIntervalSeconds:
        patch.pollIntervalSeconds ?? current.pollIntervalSeconds,
      forwardingEnabled:
        patch.forwardingEnabled !== undefined
          ? patch.forwardingEnabled
          : current.forwardingEnabled,
      telegramEnabled:
        patch.telegramEnabled !== undefined
          ? patch.telegramEnabled
          : current.telegramEnabled,
      // The bot token is a secret: an omitted value keeps the stored one, and
      // an empty string clears it. It is never echoed back by the API.
      telegramBotToken:
        patch.telegramBotToken !== undefined
          ? patch.telegramBotToken
          : current.telegramBotToken,
      telegramChatId:
        patch.telegramChatId !== undefined
          ? patch.telegramChatId
          : current.telegramChatId,
      appUrl: patch.appUrl !== undefined ? patch.appUrl : current.appUrl,
      retainBodiesDays:
        patch.retainBodiesDays ?? current.retainBodiesDays,
      retainMessagesDays:
        patch.retainMessagesDays ?? current.retainMessagesDays,
      updatedAt: new Date(),
    })
    .where(eq(appSettingsTable.id, current.id))
    .returning();
  return updated!;
}
