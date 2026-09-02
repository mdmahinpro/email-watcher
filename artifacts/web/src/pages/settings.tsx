import { useState, useEffect } from "react";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useUpdateSettings,
} from "@workspace/api-client-react";
import { Save, Plus, X, Search, Clock, Forward, AlertCircle, HardDrive } from "lucide-react";
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

  const [localKeywords, setLocalKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [forwardEmail, setForwardEmail] = useState("");
  const [pollInterval, setPollInterval] = useState(DEFAULT_POLL_SECONDS);
  const [forwardingEnabled, setForwardingEnabled] = useState(true);
  const [retainBodiesDays, setRetainBodiesDays] = useState(0);
  const [retainMessagesDays, setRetainMessagesDays] = useState(0);

  // Initialize local state when settings data loads
  useEffect(() => {
    if (settings) {
      setLocalKeywords(settings.keywords || []);
      setForwardEmail(settings.forwardToEmail || "");
      setPollInterval(settings.pollIntervalSeconds || DEFAULT_POLL_SECONDS);
      setForwardingEnabled(settings.forwardingEnabled ?? true);
      setRetainBodiesDays(settings.retainBodiesDays ?? 0);
      setRetainMessagesDays(settings.retainMessagesDays ?? 0);
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
    updateSettings.mutate({
      data: {
        keywords: localKeywords,
        forwardToEmail: trimmedForwardEmail || null,
        pollIntervalSeconds: pollInterval,
        forwardingEnabled: forwardingEnabled,
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
                retentionOrderWrong
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
