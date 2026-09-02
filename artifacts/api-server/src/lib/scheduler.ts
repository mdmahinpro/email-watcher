import { scanAllActiveAccounts } from "./mail-scanner";
import { getSettings } from "./settings";
import { beatSafely } from "./heartbeat";
import { applyRetentionSafely } from "./retention";
import { logger } from "./logger";

/** Matches the `minimum: 30` constraint on `pollIntervalSeconds` in the API spec. */
const MIN_POLL_SECONDS = 30;
const BOOT_SCAN_DELAY_MS = 5_000;

/**
 * How often the daily heartbeat and retention pass run.
 *
 * Both are idempotent within a day, so an hourly attempt is simply cheap
 * insurance: on a free host the process can be restarted at any time, and tying
 * these to a precise midnight timer would mean a restart could skip a day
 * entirely.
 */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.warn("Previous scan still running; skipping this tick");
    return;
  }
  running = true;
  try {
    await scanAllActiveAccounts();
  } catch (err) {
    logger.error({ err }, "Scheduler tick failed");
  } finally {
    running = false;
  }
}

/**
 * Database housekeeping, independent of mailbox scanning.
 *
 * Kept out of `tick` deliberately: the heartbeat must still run when every
 * mailbox is unreachable, which is exactly when a scan does no database work and
 * a free-tier database would otherwise drift toward being paused.
 */
async function maintenance(): Promise<void> {
  await beatSafely();
  await applyRetentionSafely();
}

function clearTimers(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

/**
 * Arm the polling interval from the stored settings.
 *
 * `scanImmediately` schedules one extra scan shortly after arming. It is used on
 * boot so a freshly started server does not wait a whole interval before its
 * first scan; a settings-driven restart does not need it.
 */
async function arm(scanImmediately: boolean): Promise<void> {
  const settings = await getSettings();
  const intervalSeconds = Math.max(
    MIN_POLL_SECONDS,
    settings.pollIntervalSeconds,
  );

  clearTimers();

  timer = setInterval(() => {
    void tick();
  }, intervalSeconds * 1000);

  maintenanceTimer = setInterval(() => {
    void maintenance();
  }, MAINTENANCE_INTERVAL_MS);

  if (scanImmediately) {
    bootTimer = setTimeout(() => {
      bootTimer = null;
      void tick();
      // Beat on boot too: on a free host a restart may be the only thing that
      // happens for a while, and it must still count as database activity.
      void maintenance();
    }, BOOT_SCAN_DELAY_MS);
  }

  logger.info({ intervalSeconds }, "Email scan scheduler armed");
}

export async function startScheduler(): Promise<void> {
  await arm(true);
}

export async function stopScheduler(): Promise<void> {
  if (!timer && !bootTimer && !maintenanceTimer) return;
  clearTimers();
  logger.info("Scheduler stopped");
}

/**
 * Re-read the poll interval and re-arm. Does not trigger an extra scan, so
 * saving settings repeatedly cannot stack up scans.
 */
export async function restartScheduler(): Promise<void> {
  await arm(false);
}
