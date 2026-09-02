import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scanAllActiveAccounts = vi.hoisted(() => vi.fn(async () => undefined));
const getSettings = vi.hoisted(() =>
  vi.fn(async () => ({ pollIntervalSeconds: 120 })),
);

vi.mock("./mail-scanner", () => ({ scanAllActiveAccounts }));
vi.mock("./settings", () => ({ getSettings }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { startScheduler, stopScheduler, restartScheduler } = await import(
  "./scheduler"
);

/** Advance fake timers and drain the promise queue the timer callbacks create. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  scanAllActiveAccounts.mockClear();
  getSettings.mockClear();
  getSettings.mockResolvedValue({ pollIntervalSeconds: 120 });
});

afterEach(async () => {
  await stopScheduler();
  vi.useRealTimers();
});

describe("startScheduler", () => {
  it("runs one scan shortly after boot", async () => {
    await startScheduler();

    expect(scanAllActiveAccounts).not.toHaveBeenCalled();
    await advance(5_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(1);
  });

  it("scans once per configured interval", async () => {
    await startScheduler();

    await advance(5_000); // boot scan
    await advance(120_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(2);
    await advance(120_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(3);
  });

  it("enforces a 30 second floor on the configured interval", async () => {
    getSettings.mockResolvedValue({ pollIntervalSeconds: 1 });
    await startScheduler();

    // The interval is measured from arming, so at t=29s only the t=5s boot scan
    // has run. A 1 second cadence would have produced many more by now.
    await advance(29_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(1);

    await advance(2_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(2);
  });
});

describe("stopScheduler", () => {
  it("stops further scans", async () => {
    await startScheduler();
    await advance(5_000);
    scanAllActiveAccounts.mockClear();

    await stopScheduler();
    await advance(600_000);

    expect(scanAllActiveAccounts).not.toHaveBeenCalled();
  });

  it("cancels a pending boot scan", async () => {
    await startScheduler();
    await stopScheduler();

    await advance(60_000);

    expect(scanAllActiveAccounts).not.toHaveBeenCalled();
  });
});

describe("restartScheduler", () => {
  it("does not trigger an extra scan", async () => {
    await startScheduler();
    await advance(5_000);
    scanAllActiveAccounts.mockClear();

    await restartScheduler();
    await advance(10_000);

    expect(scanAllActiveAccounts).not.toHaveBeenCalled();
  });

  it("adopts the new interval", async () => {
    await startScheduler();
    await advance(5_000);

    getSettings.mockResolvedValue({ pollIntervalSeconds: 30 });
    await restartScheduler();
    scanAllActiveAccounts.mockClear();

    await advance(30_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(2);
  });

  it("replaces the previous interval instead of stacking a second one", async () => {
    await startScheduler();
    await advance(5_000);

    await restartScheduler();
    await restartScheduler();
    scanAllActiveAccounts.mockClear();

    await advance(120_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(1);
  });
});

describe("overlapping ticks", () => {
  it("skips a tick while the previous scan is still running", async () => {
    let release: (() => void) | undefined;
    scanAllActiveAccounts.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    await startScheduler();
    await advance(5_000); // boot scan starts and hangs
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(1);

    // Two intervals elapse while the first scan is still in flight.
    await advance(240_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(1);

    release?.();
    scanAllActiveAccounts.mockResolvedValue(undefined);
    await advance(120_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(2);
  });

  it("keeps scanning after a tick throws", async () => {
    scanAllActiveAccounts.mockRejectedValueOnce(new Error("imap exploded"));

    await startScheduler();
    await advance(5_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(1);

    await advance(120_000);
    expect(scanAllActiveAccounts).toHaveBeenCalledTimes(2);
  });
});
