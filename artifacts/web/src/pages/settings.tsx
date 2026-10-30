import { useState, useEffect, useRef } from "react";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useUpdateSettings,
  useTestTelegram,
  useDownloadBackup,
  getDownloadBackupQueryKey,
  useRestoreBackup,
} from "@workspace/api-client-react";
import {
  Save,
  Plus,
  X,
  Search,
  Clock,
  Forward,
  AlertCircle,
  HardDrive,
  Bell,
  Send,
  Globe,
  DatabaseBackup,
  Download,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
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

/** Mirrors `pollIntervalSeconds` minimum in the API spec and the server clamp. */
const MIN_POLL_SECONDS = 30;
/** Mirrors the server-side default in app_settings. */
const DEFAULT_POLL_SECONDS = 120;

/**
 * Retention choices, in days. 0 means keep forever.
 *
 * A discrete list rather than a free number field: the meaningful decision is
 * "roughly how long", and a typo in a free field silently destroys data.
 */
const RETENTION_CHOICES = [
  { value: 0, label: "Keep forever" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "1 year" },
  { value: 730, label: "2 years" },
] as const;

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: settings,
    isLoading,
    isError,
    error,
  } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });

  const updateSettings = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Settings saved successfully" });
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      },
      onError: (err) => {
        toast({
          title: "Failed to save settings",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  // Sends one real message with the STORED settings, so it verifies exactly
  // what a scan would use — which is why the hint says to save first.
  const testTelegram = useTestTelegram({    mutation: {
      onSuccess: (result) => {
        if (result.ok) {
          toast({ title: "Telegram test sent", description: result.message });
        } else {
          toast({
            title: "Telegram test failed",
            description: result.message,
            variant: "destructive",
          });
        }
      },
      onError: (err) => {
        toast({
          title: "Telegram test failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  // Whole-database backup and restore. The backup is downloaded as a JSON file;
  // the restore reads such a file and only adds what is missing, so it is safe
  // to run more than once and cannot overwrite live data.
  const backupRef = useRef<HTMLInputElement>(null);
  const [restoreFileName, setRestoreFileName] = useState<string | null>(null);
  const [restorePayload, setRestorePayload] = useState<unknown>(null);

  // A GET, so it is a query, not a mutation: fetched only when the button is
  // pressed, never on mount (a backup can be large).
  const backupQuery = useDownloadBackup({
    query: {
      queryKey: getDownloadBackupQueryKey(),
      enabled: false,
      gcTime: 0,
    },
  });

  const downloadBackup = async () => {
    try {
      const result = await backupQuery.refetch();
      if (result.error || !result.data) {
        toast({
          title: "Backup failed",
          description:
            result.error instanceof Error
              ? result.error.message
              : "The server did not return a backup.",
          variant: "destructive",
        });
        return;
      }
      const data = result.data;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `email-watcher-backup-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const counts = (data as { counts?: Record<string, number> }).counts;
      const total = counts
        ? Object.values(counts).reduce((a, b) => a + b, 0)
        : undefined;
      toast({
        title: "Backup downloaded",
        description:
          total !== undefined
            ? `${total} rows. Keep this file private — it holds mailbox passwords.`
            : "Keep this file private — it holds mailbox passwords.",
      });
    } catch (err) {
      toast({
        title: "Backup failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  };

  const restoreBackup = useRestoreBackup({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Restore finished",
          description: data.message,
        });
        setRestoreFileName(null);
        setRestorePayload(null);
        if (backupRef.current) backupRef.current.value = "";
        queryClient.invalidateQueries();
      },
      onError: (err) => {
        toast({
          title: "Restore failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const handleBackupFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setRestorePayload(parsed);
      setRestoreFileName(file.name);
    } catch {
      setRestorePayload(null);
      setRestoreFileName(null);
      toast({
        title: "Not a backup file",
        description: "That file is not valid JSON.",
        variant: "destructive",
      });
    }
  };

  const [localKeywords, setLocalKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [criticalKeywords, setCriticalKeywords] = useState<string[]>([]);
  const [newCriticalKeyword, setNewCriticalKeyword] = useState("");
  const [forwardEmail, setForwardEmail] = useState("");
  const [pollInterval, setPollInterval] = useState(DEFAULT_POLL_SECONDS);
  const [forwardingEnabled, setForwardingEnabled] = useState(true);
  const [retainBodiesDays, setRetainBodiesDays] = useState(0);
  const [retainMessagesDays, setRetainMessagesDays] = useState(0);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramBotTokenSet, setTelegramBotTokenSet] = useState(false);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [appUrl, setAppUrl] = useState("");

  // Initialize local state when settings data loads
  useEffect(() => {
    if (settings) {
      setLocalKeywords(settings.keywords || []);
      setCriticalKeywords(settings.criticalKeywords || []);
      setForwardEmail(settings.forwardToEmail || "");
      setPollInterval(settings.pollIntervalSeconds || DEFAULT_POLL_SECONDS);
      setForwardingEnabled(settings.forwardingEnabled ?? true);
      setRetainBodiesDays(settings.retainBodiesDays ?? 0);
      setRetainMessagesDays(settings.retainMessagesDays ?? 0);
      setTelegramEnabled(settings.telegramEnabled ?? false);
      setTelegramBotTokenSet(settings.telegramBotTokenSet ?? false);
      setTelegramChatId(settings.telegramChatId || "");
      setAppUrl(settings.appUrl || "");
    }
  }, [settings]);

  const handleAddKeyword = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = newKeyword.trim();
    if (!clean) return;
    // Matching is case-insensitive, so treat differently-cased entries as the
    // same keyword rather than storing a redundant duplicate.
    const isDuplicate = localKeywords.some(
      (k) => k.toLowerCase() === clean.toLowerCase(),
    );
    if (isDuplicate) {
      toast({ title: `"${clean}" is already in the list` });
      setNewKeyword("");
      return;
    }
    setLocalKeywords([...localKeywords, clean]);
    setNewKeyword("");
  };

  const handleRemoveKeyword = (keywordToRemove: string) => {
    setLocalKeywords(localKeywords.filter(k => k !== keywordToRemove));
  };

  const handleAddCriticalKeyword = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = newCriticalKeyword.trim();
    if (!clean) return;
    const isDuplicate = criticalKeywords.some(
      (k) => k.toLowerCase() === clean.toLowerCase(),
    );
    if (isDuplicate) {
      toast({ title: `"${clean}" is already in the critical list` });
      setNewCriticalKeyword("");
      return;
    }
    setCriticalKeywords([...criticalKeywords, clean]);
    setNewCriticalKeyword("");
  };

  const handleRemoveCriticalKeyword = (keywordToRemove: string) => {
    setCriticalKeywords(criticalKeywords.filter(k => k !== keywordToRemove));
  };

  const trimmedForwardEmail = forwardEmail.trim();
  const pollIntervalInvalid =
    !Number.isFinite(pollInterval) || pollInterval < MIN_POLL_SECONDS;
  const forwardTargetMissing = forwardingEnabled && trimmedForwardEmail === "";
  // Deleting whole rows before clearing their bodies would be contradictory: the
  // row would already be gone by the time the body window elapsed.
  const retentionOrderWrong =
    retainMessagesDays > 0 &&
    retainBodiesDays > 0 &&
    retainMessagesDays < retainBodiesDays;
  // Telegram cannot push anything without all three: a token (typed now or
  // saved before), a chat to push to, and at least one keyword to be critical
  // about. Caught here rather than by a silent no-op at scan time.
  const tokenAvailable = telegramBotTokenSet || telegramBotToken.trim() !== "";
  const telegramIncomplete =
    telegramEnabled &&
    (!tokenAvailable || telegramChatId.trim() === "" || criticalKeywords.length === 0);

  const handleSave = () => {
    if (pollIntervalInvalid) {
      toast({
        title: "Invalid polling interval",
        description: `Must be at least ${MIN_POLL_SECONDS} seconds.`,
        variant: "destructive",
      });
      return;
    }
    if (forwardTargetMissing) {
      toast({
        title: "Forward destination required",
        description:
          "Enter an address to forward to, or turn forwarding off.",
        variant: "destructive",
      });
      return;
    }
    if (retentionOrderWrong) {
      toast({
        title: "Retention windows conflict",
        description:
          "Messages are deleted before their bodies would be cleared. Set the delete window longer than the body window.",
        variant: "destructive",
      });
      return;
    }
    if (telegramIncomplete) {
      toast({
        title: "Telegram setup incomplete",
        description:
          "Enable needs a bot token, a chat id, and at least one critical keyword.",
        variant: "destructive",
      });
      return;
    }
    updateSettings.mutate({
      data: {
        keywords: localKeywords,
        criticalKeywords,
        forwardToEmail: trimmedForwardEmail || null,
        pollIntervalSeconds: pollInterval,
        forwardingEnabled: forwardingEnabled,
        // Sent only when replacing: an empty field means "keep the stored
        // token", matching the account-password convention.
        ...(telegramBotToken.trim()
          ? { telegramBotToken: telegramBotToken.trim() }
          : {}),
        telegramChatId: telegramChatId.trim() || null,
        appUrl: appUrl.trim() || null,
        telegramEnabled,
        retainBodiesDays,
        retainMessagesDays,
      }
    });
  };

  if (isError) {
    return (
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <h1 className="pin-section-title">Settings</h1>
        </div>
        <div className="pin-card flex items-start gap-3 border border-destructive/30 p-4 sm:p-6">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Could not load settings
            </h3>
            <p className="pin-break mt-1 text-sm text-muted-foreground">
              {error?.message ?? "The API server did not respond."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-5 sm:space-y-6">
        <div>
          <h1 className="pin-section-title">Settings</h1>
          <p className="text-muted-foreground mt-1 text-sm">Configure global application behavior.</p>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-[200px] w-full rounded-2xl" />
          <Skeleton className="h-[200px] w-full rounded-2xl" />
          <Skeleton className="h-[160px] w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 sm:space-y-6">
      <div>
        <h1 className="pin-section-title">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Configure matching criteria and forwarding behavior.
        </p>
      </div>

      <div className="space-y-5 sm:space-y-6">
        {/* Keywords Card */}
        <div className="pin-card">
          <div className="p-4 pb-3 sm:p-6 sm:pb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
                <Search className="h-4 w-4 text-sidebar-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Matching Keywords</h3>
            </div>
            {/* No hanging indent on mobile: the 42px offset cost 15% of a narrow
                content column. */}
            <p className="text-xs text-muted-foreground sm:ml-[42px]">
              An email is flagged when its subject, sender, or body contains any
              of these keywords (case-insensitive substring match).
            </p>
          </div>
          <div className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="min-h-[60px] rounded-xl border border-white/10 bg-black/30 p-3 sm:p-4">
              {localKeywords.length === 0 ? (
                <span className="text-sm italic text-muted-foreground">
                  No keywords defined. App will not match any emails.
                </span>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {localKeywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="pin-badge max-w-full gap-1 py-0 pr-0"
                    >
                      <span className="pin-break min-w-0 py-1">{keyword}</span>
                      {/* 32px tap target: this was a bare 12px glyph with no
                          padding, so the wrong keyword was easy to delete. */}
                      <button
                        type="button"
                        aria-label={`Remove keyword ${keyword}`}
                        onClick={() => handleRemoveKeyword(keyword)}
                        className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-white/10 md:hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <form
              onSubmit={handleAddKeyword}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <Input
                placeholder="Add a new keyword..."
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                className="pin-input sm:max-w-md"
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={!newKeyword.trim()}
                className="w-full rounded-full sm:w-auto"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </form>
          </div>
        </div>

        {/* Critical Keywords Card */}
        <div className="pin-card">
          <div className="p-4 pb-3 sm:p-6 sm:pb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
                <Bell className="h-4 w-4 text-red-400" />
              </div>
              <h3 className="font-semibold text-foreground">Critical Keywords</h3>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-[42px]">
              The short list worth interrupting you for. A match against these
              also pushes a Telegram message with the whole email and a button
              to its exact web view; regular keywords are only listed in
              Messages.
            </p>
          </div>
          <div className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="min-h-[60px] rounded-xl border border-white/10 bg-black/30 p-3 sm:p-4">
              {criticalKeywords.length === 0 ? (
                <span className="text-sm italic text-muted-foreground">
                  No critical keywords. Nothing will trigger a Telegram push.
                </span>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {criticalKeywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="pin-badge max-w-full gap-1 py-0 pr-0 border-red-500/30 text-red-300"
                    >
                      <span className="pin-break min-w-0 py-1">{keyword}</span>
                      <button
                        type="button"
                        aria-label={`Remove critical keyword ${keyword}`}
                        onClick={() => handleRemoveCriticalKeyword(keyword)}
                        className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-white/10 md:hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <form
              onSubmit={handleAddCriticalKeyword}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <Input
                placeholder="Add a critical keyword..."
                value={newCriticalKeyword}
                onChange={(e) => setNewCriticalKeyword(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                className="pin-input sm:max-w-md"
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={!newCriticalKeyword.trim()}
                className="w-full rounded-full sm:w-auto"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </form>

            <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3">
              <p className="text-xs text-muted-foreground">
                Keep this list small and high-signal — every hit here is a push
                notification. It is matched with the same broad rules as the
                regular list (subject, sender, recipient, body, links,
                case-insensitive), in every account regardless of capture mode.
              </p>
            </div>
          </div>
        </div>

        {/* Forwarding Card */}
        <div className="pin-card">
          <div className="p-4 pb-3 sm:p-6 sm:pb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
                <Forward className="h-4 w-4 text-sidebar-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Auto-Forwarding</h3>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-[42px]">
              Automatically forward any matched emails to a central command address.
            </p>
          </div>
          <div className="space-y-5 px-4 pb-4 sm:px-6 sm:pb-6 sm:space-y-6">
            <div className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/30 p-3 sm:items-center sm:p-4">
              <div className="min-w-0 space-y-0.5">
                <Label className="text-sm font-semibold">Enable Forwarding</Label>
                <p className="text-xs text-muted-foreground">
                  Matched emails are relayed using the receiving account's SMTP
                  settings.
                </p>
              </div>
              <Switch
                className="mt-0.5 shrink-0 sm:mt-0"
                checked={forwardingEnabled}
                onCheckedChange={setForwardingEnabled}
                aria-label="Enable forwarding"
              />
            </div>

            <Separator className="bg-white/10" />

            <div className="space-y-2">
              <Label htmlFor="forwardToEmail" className="pin-meta-label">
                Forward Destination Address
              </Label>
              <Input
                id="forwardToEmail"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="central.command@example.com"
                value={forwardEmail}
                onChange={(e) => setForwardEmail(e.target.value)}
                disabled={!forwardingEnabled}
                aria-invalid={forwardTargetMissing}
                className="pin-input sm:max-w-md"
              />
              {forwardTargetMissing ? (
                <p className="text-sm text-destructive">
                  Required while forwarding is enabled.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  All forwarded emails will be sent to this single address.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Telegram Card */}
        <div className="pin-card">
          <div className="p-4 pb-3 sm:p-6 sm:pb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
                <Send className="h-4 w-4 text-sidebar-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Telegram Alerts</h3>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-[42px]">
              Push a message to yourself for every critical-keyword match, with
              the whole email and a link to its exact web view.
            </p>
          </div>
          <div className="space-y-5 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/30 p-3 sm:items-center sm:p-4">
              <div className="min-w-0 space-y-0.5">
                <Label className="text-sm font-semibold">Enable Alerts</Label>
                <p className="text-xs text-muted-foreground">
                  Only critical keywords push; everything else stays listed in
                  Messages.
                </p>
              </div>
              <Switch
                className="mt-0.5 shrink-0 sm:mt-0"
                checked={telegramEnabled}
                onCheckedChange={setTelegramEnabled}
                aria-label="Enable Telegram alerts"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegramBotToken" className="pin-meta-label">
                Bot Token
              </Label>
              <Input
                id="telegramBotToken"
                type="password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={
                  telegramBotTokenSet
                    ? "Saved — leave blank to keep, paste to replace"
                    : "From @BotFather (e.g. 123456:ABC-DEF...)"
                }
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                disabled={!telegramEnabled}
                className="pin-input sm:max-w-md"
              />
              <p className="text-xs text-muted-foreground">
                Create a bot with @BotFather and paste its token here. It is
                stored once and never shown again.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegramChatId" className="pin-meta-label">
                Chat ID
              </Label>
              <Input
                id="telegramChatId"
                inputMode="numeric"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Your numeric id, e.g. 123456789"
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                disabled={!telegramEnabled}
                className="pin-input sm:max-w-md"
              />
              <p className="text-xs text-muted-foreground">
                Message your bot once, then get the number from @userinfobot —
                it appears as the chat id of the message you sent.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="appUrl" className="pin-meta-label">
                App URL <span className="ml-1 inline-flex align-middle"><Globe className="h-3 w-3" /></span>
              </Label>
              <Input
                id="appUrl"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://your-deployment.onrender.com"
                value={appUrl}
                onChange={(e) => setAppUrl(e.target.value)}
                disabled={!telegramEnabled}
                className="pin-input sm:max-w-md"
              />
              <p className="text-xs text-muted-foreground">
                The public address of this app. It is used to build the "Open
                in Email Watcher" button inside each alert, which opens the
                exact email without a login. Left empty, the deployment's
                RENDER_EXTERNAL_URL is used; the button is omitted when neither
                is set.
              </p>
            </div>

            {telegramIncomplete ? (
              <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3">
                <p className="text-xs text-muted-foreground">
                  Alerts need a bot token, a chat id, and at least one critical
                  keyword before they can be enabled.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Uses the saved settings — press Save first when you changed
                  anything above.
                </p>
                <Button
                  variant="outline"
                  className="w-full rounded-full sm:w-auto"
                  disabled={
                    testTelegram.isPending ||
                    !telegramEnabled ||
                    !tokenAvailable ||
                    telegramChatId.trim() === ""
                  }
                  onClick={() => testTelegram.mutate()}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {testTelegram.isPending ? "Sending..." : "Send test message"}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Storage Card */}
        <div className="pin-card">
          <div className="p-4 pb-3 sm:p-6 sm:pb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
                <HardDrive className="h-4 w-4 text-sidebar-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Storage Retention</h3>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-[42px]">
              Archived mail grows without limit unless bounded. A message with its
              full body costs roughly 13 KB, so a 500 MB free database holds about
              38,000 of them.
            </p>
          </div>
          <div className="space-y-5 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="space-y-2">
              <Label htmlFor="retainBodies" className="pin-meta-label">
                Clear message bodies after
              </Label>
              <Select
                value={String(retainBodiesDays)}
                onValueChange={(v) => setRetainBodiesDays(Number(v))}
              >
                <SelectTrigger id="retainBodies" className="rounded-xl sm:max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETENTION_CHOICES.map((c) => (
                    <SelectItem key={c.value} value={String(c.value)}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Keeps the message, its subject, sender, and preview — only the
                stored body is dropped. Recovers about 92% of the space while
                history stays searchable. Start here.
              </p>
            </div>

            <Separator className="bg-white/10" />

            <div className="space-y-2">
              <Label htmlFor="retainMessages" className="pin-meta-label">
                Delete messages entirely after
              </Label>
              <Select
                value={String(retainMessagesDays)}
                onValueChange={(v) => setRetainMessagesDays(Number(v))}
              >
                <SelectTrigger
                  id="retainMessages"
                  aria-invalid={retentionOrderWrong}
                  className="rounded-xl sm:max-w-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETENTION_CHOICES.map((c) => (
                    <SelectItem key={c.value} value={String(c.value)}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {retentionOrderWrong ? (
                <p className="text-sm text-destructive">
                  This is shorter than the body window above, so messages would be
                  deleted before their bodies were ever cleared. Make it longer.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Permanently removes the record. Only needed if even the ~1 KB
                  metadata rows accumulate too far.
                </p>
              )}
            </div>

            {retainBodiesDays > 0 || retainMessagesDays > 0 ? (
              <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3">
                <p className="text-xs text-muted-foreground">
                  Retention is applied hourly and immediately after saving. Deleted
                  data cannot be recovered — the original emails remain in their
                  mailboxes, but anything already outside these windows is dropped
                  on the next pass.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {/* Backup & Restore Card */}
        <div className="pin-card">
          <div className="p-4 pb-3 sm:p-6 sm:pb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
                <DatabaseBackup className="h-4 w-4 text-sidebar-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Backup &amp; Restore</h3>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-[42px]">
              Your data lives in the managed Postgres database behind
              DATABASE_URL, not on this server. Download a full copy any time —
              settings, accounts, and every stored message with its body.
            </p>
          </div>
          <div className="space-y-5 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div className="min-w-0 space-y-0.5">
                <Label className="text-sm font-semibold">Download a full backup</Label>
                <p className="text-xs text-muted-foreground">
                  One JSON file with everything. It contains mailbox passwords,
                  so store it somewhere private.
                </p>
              </div>
              <Button
                variant="outline"
                className="w-full shrink-0 rounded-full sm:w-auto"
                disabled={backupQuery.isFetching}
                onClick={() => void downloadBackup()}
              >
                <Download className="mr-2 h-4 w-4" />
                {backupQuery.isFetching ? "Preparing..." : "Download backup"}
              </Button>
            </div>

            <Separator className="bg-white/10" />

            <div className="space-y-2">
              <Label htmlFor="restoreFile" className="pin-meta-label">
                Restore from a backup file
              </Label>
              <Input
                id="restoreFile"
                ref={backupRef}
                type="file"
                accept="application/json,.json"
                onChange={(e) => void handleBackupFile(e.target.files?.[0])}
                className="pin-input file:mr-3 file:rounded-full file:border-0 file:bg-sidebar-accent/70 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-sidebar-accent-foreground"
              />
              {restoreFileName ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="secondary"
                      className="w-full rounded-full sm:w-auto"
                      disabled={restoreBackup.isPending}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      {restoreBackup.isPending
                        ? "Restoring..."
                        : `Restore ${restoreFileName}`}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="font-bold">
                        Restore from {restoreFileName}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Missing rows are added and existing ones are left as
                        they are — nothing is deleted or overwritten, so this is
                        safe to run more than once. Use it after a fresh
                        deployment to recover everything, or to regain messages
                        that were lost.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="rounded-full">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="rounded-full"
                        onClick={() =>
                          restoreBackup.mutate({
                            data: restorePayload as never,
                          })
                        }
                      >
                        Restore now
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Choose a file downloaded above. Rows already present are
                  skipped, so restoring an older backup cannot remove newer
                  mail. Files up to 64 MB; for larger archives use your
                  database provider's own backup tools.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* System Card */}
        <div className="pin-card">
          <div className="p-4 pb-3 sm:p-6 sm:pb-4">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
                <Clock className="h-4 w-4 text-sidebar-primary" />
              </div>
              <h3 className="font-semibold text-foreground">System</h3>
            </div>
            <p className="text-xs text-muted-foreground sm:ml-[42px]">
              Background worker configuration.
            </p>
          </div>
          <div className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="space-y-2">
              <Label htmlFor="pollInterval" className="pin-meta-label">
                Polling Interval (Seconds)
              </Label>
              <Input
                id="pollInterval"
                type="number"
                inputMode="numeric"
                min={MIN_POLL_SECONDS}
                step={30}
                value={pollInterval}
                onChange={(e) => {
                  // Empty input becomes 0 rather than NaN, which React would
                  // reject as a controlled value.
                  const parsed = parseInt(e.target.value, 10);
                  setPollInterval(Number.isNaN(parsed) ? 0 : parsed);
                }}
                aria-invalid={pollIntervalInvalid}
                className="pin-input sm:max-w-[200px]"
              />
              {pollIntervalInvalid ? (
                <p className="text-sm text-destructive">
                  Must be at least {MIN_POLL_SECONDS} seconds.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  How often the background worker checks all active accounts.
                  Minimum {MIN_POLL_SECONDS} seconds.
                </p>
              )}
            </div>
          </div>
          <div className="border-t border-white/10 bg-white/[0.02] px-4 py-3 sm:flex sm:justify-end sm:px-6 sm:py-4">
            <Button
              className="pin-btn-primary w-full sm:w-auto"
              onClick={handleSave}
              disabled={
                updateSettings.isPending ||
                pollIntervalInvalid ||
                forwardTargetMissing ||
                retentionOrderWrong ||
                telegramIncomplete
              }
            >
              {updateSettings.isPending ? "Saving..." : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save All Settings
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
