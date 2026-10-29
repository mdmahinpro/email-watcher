import { useState } from "react";
import {
  AlertCircle,
  Activity,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  BatchScanResult,
  BatchTestResult,
} from "@workspace/api-client-react";

/**
 * Result panel for "Test all" and "Scan all".
 *
 * A toast cannot carry this: a dozen accounts produce a dozen distinct outcomes,
 * and the per-account reason is the whole reason to run the batch. Failures are
 * listed first because they are the only rows that need action.
 */

type BatchResult =
  | { kind: "test"; data: BatchTestResult }
  | { kind: "scan"; data: BatchScanResult };

export function BatchResultPanel({
  result,
  onDismiss,
}: {
  result: BatchResult;
  onDismiss: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const rows =
    result.kind === "test"
      ? result.data.results.map((r) => ({
          accountId: r.accountId,
          label: r.label,
          emailAddress: r.emailAddress,
          ok: r.ok,
          message: r.message,
        }))
      : result.data.results.map((r) => ({
          accountId: r.accountId,
          label: r.label,
          emailAddress: r.emailAddress,
          ok: r.ok,
          message: r.message,
        }));

  const failures = rows.filter((r) => !r.ok);
  const successes = rows.filter((r) => r.ok);
  // Failures always shown; successes are noise once you know the count.
  const visible = showAll ? [...failures, ...successes] : failures;

  const headline =
    result.kind === "test"
      ? `Tested ${result.data.tested}: ${result.data.succeeded} connected, ${result.data.failed} failed`
      : `Scanned ${result.data.scannedAccounts} account${result.data.scannedAccounts === 1 ? "" : "s"}: ` +
        `${result.data.totalMatched} matched, ${result.data.totalArchived} archived` +
        (result.data.totalForwarded > 0
          ? `, ${result.data.totalForwarded} forwarded`
          : "") +
        (result.data.totalNotified > 0
          ? `, ${result.data.totalNotified} Telegram alert${result.data.totalNotified === 1 ? "" : "s"}`
          : "") +
        (result.data.failed > 0 ? `, ${result.data.failed} failed` : "");

  const allGood = failures.length === 0;

  return (
    <div
      className={`pin-card border p-4 sm:p-5 ${
        allGood ? "border-green-500/30" : "border-destructive/30"
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {allGood ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-400" />
          ) : (
            <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{headline}</h3>
            {result.kind === "scan" && result.data.skipped > 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {result.data.skipped} paused account
                {result.data.skipped === 1 ? "" : "s"} skipped. Pausing means do
                not poll, so a manual scan respects it.
              </p>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full"
          aria-label="Dismiss results"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {visible.length > 0 ? (
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {visible.map((r) => (
            <li
              key={r.accountId}
              className="rounded-lg border border-white/10 bg-black/20 p-2.5"
            >
              <div className="flex items-start gap-2">
                {r.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-400" />
                ) : (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                )}
                <div className="min-w-0">
                  <span className="pin-break block font-mono text-xs text-foreground">
                    {r.emailAddress}
                  </span>
                  {/* The full reason, not truncated: it names the remedy. */}
                  <span className="pin-break mt-0.5 block text-xs text-muted-foreground">
                    {r.message}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {successes.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 text-xs font-medium text-sidebar-primary hover:underline"
        >
          {showAll
            ? "Hide successful accounts"
            : `Show ${successes.length} successful account${successes.length === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </div>
  );
}

/** Shared button pair, so Accounts and Hostinger stay consistent. */
export function BatchActionButtons({
  onTestAll,
  onScanAll,
  isTesting,
  isScanning,
  disabled,
}: {
  onTestAll: () => void;
  onScanAll: () => void;
  isTesting: boolean;
  isScanning: boolean;
  disabled: boolean;
}) {
  // Either operation opens many mail connections, so running both at once would
  // double the load for no benefit.
  const busy = isTesting || isScanning;

  return (
    <>
      <Button
        variant="outline"
        className="w-full sm:w-auto"
        onClick={onTestAll}
        disabled={disabled || busy}
      >
        {isTesting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Activity className="mr-2 h-4 w-4" />
        )}
        {isTesting ? "Testing..." : "Test All"}
      </Button>
      <Button
        variant="outline"
        className="w-full sm:w-auto"
        onClick={onScanAll}
        disabled={disabled || busy}
      >
        <RefreshCw
          className={`mr-2 h-4 w-4 ${isScanning ? "animate-spin" : ""}`}
        />
        {isScanning ? "Scanning..." : "Scan All"}
      </Button>
    </>
  );
}
