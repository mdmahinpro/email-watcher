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
      forwardToEmail: null,
      pollIntervalSeconds: 120,
      forwardingEnabled: true,
    })
    .returning();
  return created!;
}

export async function updateSettings(
  patch: Partial<{
    keywords: string[];
    forwardToEmail: string | null;
    pollIntervalSeconds: number;
    forwardingEnabled: boolean;
    retainBodiesDays: number;
    retainMessagesDays: number;
  }>,
): Promise<AppSettings> {
  const current = await getSettings();
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      keywords: patch.keywords ?? current.keywords,
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
