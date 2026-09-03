import { useMemo, useState } from "react";
import {
  useListAccounts,
  getListAccountsQueryKey,
  useGetHostingerDefaults,
  getGetHostingerDefaultsQueryKey,
  useCreateHostingerAccounts,
  useDeleteAccount,
  useTestAccount,
  useScanAccount,
  useUpdateAccount,
  getListMessagesQueryKey,
  getGetStatsSummaryQueryKey,
  getGetAccountActivityQueryKey,
  getGetKeywordBreakdownQueryKey,
  type EmailAccount,
  type HostingerMailbox,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import {
  Plus,
  Trash2,
  RefreshCw,
  Activity,
  AlertCircle,
  CheckCircle2,
  PauseCircle,
  Pause,
  Play,
  Server,
  Info,
  KeyRound,
  Globe,
  Archive,
  Filter as FilterIcon,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { parseMailboxLines } from "@/lib/mailbox-lines";

/** Matches the server-side cap in the OpenAPI spec. */
const MAX_MAILBOXES = 200;

type SmtpMode = "ssl" | "starttls";
type CaptureMode = "all" | "keywords";

const CAPTURE_LABEL: Record<
  CaptureMode,
  { label: string; description: string; Icon: typeof Archive }
> = {
  all: {
    label: "All mail",
    description: "Every message is archived to Hostinger Inbox, unfiltered.",
    Icon: Archive,
  },
  keywords: {
    label: "Keyword matches",
    description:
      "Only keyword matches are stored, to Messages, and those are forwarded.",
    Icon: FilterIcon,
  },
};

type AccountStatus = "active" | "failing" | "paused";

function statusOf(account: EmailAccount): AccountStatus {
  if (!account.active) return "paused";
  if (account.lastError) return "failing";
  return "active";
}

const STATUS_BADGE: Record<
  AccountStatus,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  active: {
    label: "Active",
    className: "bg-green-500/10 text-green-400 border-green-500/25",
    Icon: CheckCircle2,
  },
  failing: {
    label: "Failing",
    className: "bg-red-500/10 text-red-400 border-red-500/25",
    Icon: AlertCircle,
  },
  paused: {
    label: "Paused",
    className: "bg-muted text-muted-foreground border-white/15",
    Icon: PauseCircle,
  },
};

export default function Hostinger() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const listParams = { provider: "hostinger" } as const;

  const {
    data: accounts,
    isLoading,
    isError,
    error,
  } = useListAccounts(listParams, {
    query: { queryKey: getListAccountsQueryKey(listParams) },
  });
  const accountsList = accounts ?? [];

  const { data: defaults } = useGetHostingerDefaults({
    query: {
      queryKey: getGetHostingerDefaultsQueryKey(),
      // Provider constants never change at runtime.
      staleTime: Infinity,
    },
  });

  const invalidateAccountViews = () => {
    // No params: the shared prefix of both the filtered and unfiltered lists.
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetStatsSummaryQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetAccountActivityQueryKey(),
    });
  };

  const invalidateAfterScan = () => {
    invalidateAccountViews();
    queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetKeywordBreakdownQueryKey(),
    });
  };

  const testAccount = useTestAccount({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: data.ok ? "Connection Successful" : "Connection Failed",
          description: data.message,
          ...(data.ok ? {} : { variant: "destructive" as const }),
        });
        invalidateAccountViews();
      },
      onError: (err) => {
        toast({
          title: "Connection test failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const scanAccount = useScanAccount({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Scan Complete",
          description: `Scanned ${data.scanned}, Matched ${data.matched}, Forwarded ${data.forwarded}`,
        });
        invalidateAfterScan();
      },
      onError: (err) => {
        toast({
          title: "Scan failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const updateAccount = useUpdateAccount({
    mutation: {
      onSuccess: () => invalidateAccountViews(),
      onError: (err) => {
        toast({
          title: "Failed to update mailbox",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const deleteAccount = useDeleteAccount({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Mailbox removed",
          description: "Its matched messages were kept in history.",
        });
        invalidateAfterScan();
      },
      onError: (err) => {
        toast({
          title: "Failed to remove mailbox",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const isBusy = (
    mutation: { isPending: boolean; variables?: { id: number } | undefined },
    id: number,
  ) => mutation.isPending && mutation.variables?.id === id;

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 sm:space-y-6">
      <div className="min-w-0">
        <h1 className="pin-section-title">Hostinger Mailboxes</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Add Hostinger email accounts with just an address and password. Server
          settings are filled in automatically, and all incoming mail is archived
          to{" "}
          <Link href="/inbox" className="text-sidebar-primary hover:underline">
            Hostinger Inbox
          </Link>{" "}
          without keyword filtering.
        </p>
      </div>

      <ServerSettingsCard defaults={defaults} />

      <AddHostingerMailboxes
        onCreated={invalidateAccountViews}
        existingCount={accountsList.length}
      />

      {isError ? (
        <div className="pin-card flex items-start gap-3 border border-destructive/30 p-4 sm:p-6">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Could not load mailboxes
            </h3>
            <p className="pin-break mt-1 text-sm text-muted-foreground">
              {error?.message ?? "The API server did not respond."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Monitored Hostinger Mailboxes
            {accountsList.length > 0 ? (
              <span className="ml-2 font-normal text-muted-foreground">
                ({accountsList.length})
              </span>
            ) : null}
          </h2>
          {accountsList.length > 0 ? (
            <Link
              href="/inbox"
              className="text-sm font-medium text-sidebar-primary hover:underline"
            >
              View archived mail →
            </Link>
          ) : null}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : accountsList.length > 0 ? (
          <div className="space-y-3">
            {accountsList.map((account) => {
              const status = statusOf(account);
              const badge = STATUS_BADGE[status];
              const capture =
                CAPTURE_LABEL[
                  (account.captureMode as CaptureMode) ?? "all"
                ];
              return (
                <div key={account.id} className="pin-card overflow-hidden">
                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="pin-break font-mono text-sm font-semibold">
                          {account.emailAddress}
                        </span>
                        <Badge
                          className={`h-5 shrink-0 rounded-full px-2 text-[11px] uppercase ${badge.className}`}
                        >
                          <badge.Icon className="mr-1 h-3 w-3" /> {badge.label}
                        </Badge>
                        {/* Which list this mailbox feeds; the whole point of the
                            Hostinger screen is that this is normally "All mail". */}
                        <Badge
                          variant="outline"
                          className="h-5 shrink-0 rounded-full px-2 text-[11px]"
                          title={capture.description}
                        >
                          <capture.Icon className="mr-1 h-3 w-3" />
                          {capture.label}
                        </Badge>
                      </div>
                      {/* Only surfaced when it differs from the address, which
                          is the default, to avoid repeating the same string. */}
                      {account.label !== account.emailAddress ? (
                        <p className="pin-break mt-1 text-xs text-muted-foreground">
                          {account.label}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">
                          {account.imapHost}:{account.imapPort}
                        </span>
                        <span className="font-mono">
                          {account.smtpHost}:{account.smtpPort}
                          {account.smtpSecure ? " SSL" : " STARTTLS"}
                        </span>
                        <span>
                          Last checked:{" "}
                          {account.lastCheckedAt
                            ? format(
                                new Date(account.lastCheckedAt),
                                "MMM d, HH:mm",
                              )
                            : "Never"}
                        </span>
                      </div>
                      {account.lastError ? (
                        <p className="pin-break mt-2 text-xs text-destructive">
                          {account.lastError}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full text-xs"
                        onClick={() => testAccount.mutate({ id: account.id })}
                        disabled={isBusy(testAccount, account.id)}
                      >
                        <Activity className="mr-1.5 h-3.5 w-3.5" />
                        Test
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full text-xs"
                        onClick={() => scanAccount.mutate({ id: account.id })}
                        disabled={isBusy(scanAccount, account.id)}
                      >
                        <RefreshCw
                          className={`mr-1.5 h-3.5 w-3.5 ${
                            isBusy(scanAccount, account.id)
                              ? "animate-spin"
                              : ""
                          }`}
                        />
                        Scan
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full"
                        title={account.active ? "Pause monitoring" : "Resume monitoring"}
                        aria-label={
                          account.active
                            ? "Pause monitoring"
                            : "Resume monitoring"
                        }
                        disabled={isBusy(updateAccount, account.id)}
                        onClick={() =>
                          updateAccount.mutate({
                            id: account.id,
                            data: { active: !account.active },
                          })
                        }
                      >
                        {account.active ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Remove mailbox"
                            aria-label="Remove mailbox"
                            className="rounded-full text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle className="font-bold">
                              Remove this mailbox?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              <span className="pin-break font-semibold text-foreground">
                                {account.emailAddress}
                              </span>{" "}
                              will stop being monitored. Its matched messages stay
                              in history. To stop temporarily, pause it instead.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="rounded-full">
                              Cancel
                            </AlertDialogCancel>
                            <AlertDialogAction
                              className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() =>
                                deleteAccount.mutate({ id: account.id })
                              }
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="pin-card flex flex-col items-center justify-center border-2 border-dashed border-white/10 p-6 text-center sm:p-10">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted/50">
              <Globe className="h-6 w-6 text-muted-foreground/40" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              No Hostinger mailboxes yet
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Add addresses above to start monitoring them. Accounts added on the
              Accounts page with custom servers appear there instead.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ServerSettingsCard({
  defaults,
}: {
  defaults:
    | {
        imapHost: string;
        imapPort: number;
        imapSecure: boolean;
        smtpHost: string;
        smtpPortSsl: number;
        smtpPortStartTls: number;
      }
    | undefined;
}) {
  return (
    <div className="pin-card p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
          <Info className="h-4 w-4 text-sidebar-primary" />
        </div>
        <h2 className="text-sm font-semibold text-foreground">
          Hostinger Server Settings
        </h2>
      </div>
      {defaults ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <span className="pin-meta-label">IMAP (Incoming)</span>
            <p className="pin-break mt-1 font-mono text-xs">
              {defaults.imapHost}:{defaults.imapPort}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {defaults.imapSecure ? "SSL/TLS" : "Insecure"}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <span className="pin-meta-label">SMTP (Outgoing)</span>
            <p className="pin-break mt-1 font-mono text-xs">
              {defaults.smtpHost}:{defaults.smtpPortSsl}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              SSL/TLS, or STARTTLS on {defaults.smtpPortStartTls}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-[86px] rounded-xl" />
          <Skeleton className="h-[86px] rounded-xl" />
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Applied to every mailbox added here. The username is set to the full email
        address, which is what Hostinger expects.
      </p>
    </div>
  );
}

function AddHostingerMailboxes({
  onCreated,
  existingCount,
}: {
  onCreated: () => void;
  existingCount: number;
}) {
  const { toast } = useToast();
  const [raw, setRaw] = useState("");
  const [sharedPassword, setSharedPassword] = useState("");
  const [smtpMode, setSmtpMode] = useState<SmtpMode>("ssl");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("all");
  const [failures, setFailures] = useState<
    Array<{ emailAddress: string; reason: string }>
  >([]);

  const rows = useMemo(() => parseMailboxLines(raw), [raw]);
  const invalid = rows.filter((r) => !r.valid);
  const needingShared = rows.filter((r) => !r.password);
  const overLimit = rows.length > MAX_MAILBOXES;
  const sharedMissing = needingShared.length > 0 && sharedPassword.trim() === "";

  const createHostinger = useCreateHostingerAccounts({
    mutation: {
      onSuccess: (data) => {
        setFailures(data.failed);
        onCreated();

        if (data.failed.length === 0) {
          toast({
            title: `Added ${data.created.length} mailbox${data.created.length === 1 ? "" : "es"}`,
          });
          // Clear only on a clean run, so a partial failure keeps the input for
          // correction.
          setRaw("");
          setSharedPassword("");
          return;
        }
        toast({
          title: `Added ${data.created.length}, skipped ${data.failed.length}`,
          description: "See the details below.",
          variant: "destructive",
        });
      },
      onError: (err) => {
        toast({
          title: "Failed to add mailboxes",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const canSubmit =
    rows.length > 0 &&
    invalid.length === 0 &&
    !overLimit &&
    !sharedMissing &&
    !createHostinger.isPending;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setFailures([]);
    const mailboxes: HostingerMailbox[] = rows.map((r) => ({
      emailAddress: r.emailAddress,
      ...(r.password ? { password: r.password } : {}),
    }));

    createHostinger.mutate({
      data: {
        mailboxes,
        // Only sent when at least one line needs it; the API rejects an empty
        // string, and an unused shared password should not be transmitted.
        ...(needingShared.length > 0
          ? { password: sharedPassword.trim() }
          : {}),
        smtpMode,
        captureMode,
      },
    });
  }

  return (
    <div className="pin-card">
      <div className="p-4 pb-3 sm:p-5 sm:pb-4">
        <div className="mb-1 flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
            <Plus className="h-4 w-4 text-sidebar-primary" />
          </div>
          <h2 className="text-sm font-semibold text-foreground">
            Add Mailboxes
          </h2>
        </div>
        <p className="text-xs text-muted-foreground sm:ml-[42px]">
          One mailbox per line. Add a password after the address to use a
          different one for that mailbox.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 px-4 pb-4 sm:px-5 sm:pb-5">
        <div className="space-y-2">
          <Label htmlFor="hostinger-mailboxes" className="pin-meta-label">
            Mailboxes
          </Label>
          <Textarea
            id="hostinger-mailboxes"
            rows={5}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={
              "sales@yourdomain.com\nsupport@yourdomain.com, differentPassword123\nbilling@yourdomain.com"
            }
            className="pin-input font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Separate an inline password with a comma, colon, or space.
            {rows.length > 0 ? (
              <>
                {" "}
                <span
                  className={
                    invalid.length > 0 || overLimit
                      ? "font-medium text-destructive"
                      : "font-medium text-foreground"
                  }
                >
                  {rows.length} mailbox{rows.length === 1 ? "" : "es"} detected
                  {rows.length - needingShared.length > 0
                    ? `, ${rows.length - needingShared.length} with an inline password`
                    : ""}
                  {overLimit ? ` (max ${MAX_MAILBOXES})` : ""}
                </span>
              </>
            ) : null}
          </p>
          {invalid.length > 0 ? (
            <p className="pin-break text-sm text-destructive">
              Not a valid email address on line{invalid.length === 1 ? "" : "s"}{" "}
              {invalid.map((r) => r.line).join(", ")}:{" "}
              {invalid
                .slice(0, 3)
                .map((r) => r.emailAddress)
                .join(", ")}
              {invalid.length > 3 ? "…" : ""}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="hostinger-password" className="pin-meta-label">
              Shared Password
            </Label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="hostinger-password"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={sharedPassword}
                onChange={(e) => setSharedPassword(e.target.value)}
                aria-invalid={sharedMissing}
                className="pin-input pl-9"
              />
            </div>
            {sharedMissing ? (
              <p className="text-sm text-destructive">
                {needingShared.length} mailbox
                {needingShared.length === 1 ? "" : "es"} above{" "}
                {needingShared.length === 1 ? "has" : "have"} no inline password,
                so a shared password is required.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Used for any mailbox without an inline password.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="hostinger-smtp-mode" className="pin-meta-label">
              SMTP Encryption
            </Label>
            <Select
              value={smtpMode}
              onValueChange={(v) => setSmtpMode(v as SmtpMode)}
            >
              <SelectTrigger id="hostinger-smtp-mode" className="rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ssl">SSL — port 465 (default)</SelectItem>
                <SelectItem value="starttls">
                  STARTTLS — port 587
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Switch to STARTTLS only if port 465 is blocked on your network.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="hostinger-capture-mode" className="pin-meta-label">
            What to capture
          </Label>
          <Select
            value={captureMode}
            onValueChange={(v) => setCaptureMode(v as CaptureMode)}
          >
            <SelectTrigger
              id="hostinger-capture-mode"
              className="rounded-xl sm:max-w-md"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                All mail — archive everything (default)
              </SelectItem>
              <SelectItem value="keywords">
                Keyword matches only — send to Messages
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {CAPTURE_LABEL[captureMode].description}
            {captureMode === "all"
              ? " Forwarding is skipped in this mode."
              : ""}
          </p>
        </div>

        {failures.length > 0 ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-semibold text-foreground">
              Skipped {failures.length} mailbox
              {failures.length === 1 ? "" : "es"}
            </p>
            <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
              {failures.map((f) => (
                <li key={f.emailAddress} className="text-xs">
                  <span className="pin-break block font-mono text-foreground">
                    {f.emailAddress}
                  </span>
                  <span className="pin-break block text-muted-foreground">
                    {f.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {existingCount > 0
              ? `${existingCount} Hostinger mailbox${existingCount === 1 ? "" : "es"} already monitored.`
              : "Addresses already monitored are skipped automatically."}
          </p>
          <Button
            type="submit"
            disabled={!canSubmit}
            className="pin-btn-primary w-full sm:w-auto"
          >
            {createHostinger.isPending ? (
              "Adding..."
            ) : (
              <>
                <Server className="mr-2 h-4 w-4" />
                Add {rows.length || ""} Mailbox
                {rows.length === 1 ? "" : "es"}
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
