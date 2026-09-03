import { useMemo, useState } from "react";
import {
  useListAccounts,
  getListAccountsQueryKey,
  useDeleteAccount,
  useTestAccount,
  useScanAccount,
  useCreateAccount,
  useCreateAccountsBulk,
  useUpdateAccount,
  getListMessagesQueryKey,
  getGetStatsSummaryQueryKey,
  getGetAccountActivityQueryKey,
  getGetKeywordBreakdownQueryKey,
  type EmailAccount,
  type CreateAccountBody,
  type UpdateAccountBody,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  Plus,
  Server,
  Trash2,
  RefreshCw,
  Activity,
  AlertCircle,
  CheckCircle2,
  Shield,
  ShieldAlert,
  Pencil,
  Pause,
  Play,
  PauseCircle,
  Users,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { distinctDomains, parseMailboxLines } from "@/lib/mailbox-lines";

const PORT_RANGE = { min: 1, max: 65535 } as const;
/** Matches the server-side cap in the OpenAPI spec. */
const BULK_MAX_ACCOUNTS = 200;

const port = (fallback: number) =>
  z.coerce
    .number()
    .int("Port must be a whole number")
    .min(PORT_RANGE.min, `Port must be ${PORT_RANGE.min}-${PORT_RANGE.max}`)
    .max(PORT_RANGE.max, `Port must be ${PORT_RANGE.min}-${PORT_RANGE.max}`)
    .default(fallback);

/**
 * Shared shape for both dialogs. `password` is optional here because an edit
 * leaves it blank to keep the stored credential; the create flow tightens it
 * via `createAccountSchema` below.
 */
const accountSchema = z.object({
  label: z.string().min(1, "Label is required"),
  emailAddress: z.string().email("Valid email is required"),
  imapHost: z.string().min(1, "IMAP Host is required"),
  imapPort: port(993),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().min(1, "SMTP Host is required"),
  smtpPort: port(465),
  smtpSecure: z.boolean().default(true),
  username: z.string().min(1, "Username is required"),
  password: z.string(),
  allowInvalidCert: z.boolean().default(false),
});

const createAccountSchema = accountSchema.extend({
  password: z.string().min(1, "Password is required"),
});

type AccountFormValues = z.infer<typeof accountSchema>;

// Type-only contract guards: if the generated OpenAPI bodies drift from this
// form, the typecheck fails here instead of the form silently sending a payload
// the API rejects at runtime.
type AssertAssignable<T extends U, U> = T;
type _FormMatchesCreateBody = AssertAssignable<
  z.infer<typeof createAccountSchema>,
  CreateAccountBody
>;
type _FormMatchesUpdateBody = AssertAssignable<
  AccountFormValues,
  UpdateAccountBody
>;

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

type DialogState =
  | { mode: "create" }
  | { mode: "bulk" }
  | { mode: "edit"; account: EmailAccount }
  | null;

export default function Accounts() {
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidateAccountViews = () => {
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetStatsSummaryQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetAccountActivityQueryKey(),
    });
  };

  // A scan can add matched messages, so the message-derived views go stale too.
  // getListMessagesQueryKey() with no params is the shared prefix of every
  // filtered messages query.
  const invalidateAfterScan = () => {
    invalidateAccountViews();
    queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetKeywordBreakdownQueryKey(),
    });
  };

  const {
    data: accounts,
    isLoading,
    isError,
    error,
  } = useListAccounts(undefined, {
    query: { queryKey: getListAccountsQueryKey() },
  });
  const accountsList = accounts ?? [];

  const deleteAccount = useDeleteAccount({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Account removed",
          description: "Its matched messages were kept in history.",
        });
        invalidateAfterScan();
      },
      onError: (err) => {
        toast({
          title: "Failed to remove account",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

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
      onSuccess: () => {
        invalidateAccountViews();
      },
      onError: (err) => {
        toast({
          title: "Failed to update account",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const toggleActive = (account: EmailAccount) => {
    updateAccount.mutate(
      { id: account.id, data: { active: !account.active } },
      {
        onSuccess: (updated) => {
          toast({
            title: updated.active
              ? `Resumed monitoring ${updated.label}`
              : `Paused monitoring ${updated.label}`,
          });
        },
      },
    );
  };

  const isBusy = (
    mutation: { isPending: boolean; variables?: { id: number } | undefined },
    id: number,
  ) => mutation.isPending && mutation.variables?.id === id;

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="pin-section-title">Monitored Accounts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your connected IMAP/SMTP inboxes. For Hostinger mailboxes, use
            the{" "}
            <Link href="/hostinger" className="text-sidebar-primary hover:underline">
              Hostinger
            </Link>{" "}
            page instead.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:shrink-0">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => setDialogState({ mode: "bulk" })}
          >
            <Users className="h-4 w-4 mr-2" />
            Bulk Add
          </Button>
          <Button
            className="pin-btn-primary w-full sm:w-auto"
            onClick={() => setDialogState({ mode: "create" })}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Account
          </Button>
        </div>
      </div>

      <AccountDialogs
        state={dialogState}
        onClose={() => setDialogState(null)}
        onSaved={invalidateAccountViews}
      />

      {isError ? (
        <div className="pin-card flex items-start gap-3 border border-destructive/30 p-4 sm:p-6">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Could not load accounts
            </h3>
            <p className="pin-break mt-1 text-sm text-muted-foreground">
              {error?.message ?? "The API server did not respond."}
            </p>
          </div>
        </div>
      ) : null}

      {/* Account Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          [...Array(3)].map((_, i) => (
            <div key={i} className="pin-card overflow-hidden">
              <div className="p-4 pb-3 sm:p-5 sm:pb-4">
                <Skeleton className="h-6 w-1/2 mb-3" />
                <Skeleton className="h-4 w-3/4" />
              </div>
              <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                <Skeleton className="h-20 w-full rounded-xl" />
              </div>
            </div>
          ))
        ) : accountsList.length > 0 ? (
          accountsList.map((account) => {
            const status = statusOf(account);
            const badge = STATUS_BADGE[status];
            return (
              <div
                key={account.id}
                className="pin-card flex flex-col overflow-hidden"
              >
                <div className="p-4 pb-3 sm:p-5 sm:pb-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
                          <Server className="h-4 w-4 text-sidebar-primary" />
                        </div>
                        <h3 className="min-w-0 truncate text-sm font-semibold">
                          {account.label}
                        </h3>
                      </div>
                      {/* No hanging indent on mobile: a 42px offset costs too
                          much of a narrow column. */}
                      <p className="pin-break mt-2 font-mono text-xs text-muted-foreground sm:ml-[42px]">
                        {account.emailAddress}
                      </p>
                      {/* Hostinger accounts are managed on their own page; the
                          badge explains why their servers are preset. */}
                      {account.provider === "hostinger" ? (
                        <Link
                          href="/hostinger"
                          className="pin-badge mt-2 gap-1 text-[11px] sm:ml-[42px]"
                        >
                          <Globe className="h-3 w-3" />
                          Hostinger
                        </Link>
                      ) : null}
                    </div>
                    <Badge
                      className={`h-5 shrink-0 rounded-full px-2 text-[11px] uppercase ${badge.className}`}
                    >
                      <badge.Icon className="mr-1 h-3 w-3" /> {badge.label}
                    </Badge>
                  </div>
                </div>

                <div className="flex-1 px-4 pb-4 sm:px-5">
                  <div className="space-y-3 rounded-xl border border-white/10 bg-black/30 p-3.5">
                    {/* Single column on mobile: side-by-side left ~124px per
                        column, which truncated every real hostname. */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="min-w-0">
                        <span className="pin-meta-label">IMAP</span>
                        <div className="pin-break mt-1 font-mono text-xs">
                          {account.imapHost}:{account.imapPort}
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          {account.imapSecure ? (
                            <Shield className="h-3.5 w-3.5 shrink-0 text-green-500" />
                          ) : (
                            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
                          )}
                          <span className="text-[11px] text-muted-foreground">
                            {account.imapSecure ? "SSL/TLS" : "Insecure"}
                            {/* An unverified certificate is a real security
                                trade-off, so never leave it invisible. */}
                            {account.allowInvalidCert ? ", unverified" : ""}
                          </span>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <span className="pin-meta-label">SMTP</span>
                        <div className="pin-break mt-1 font-mono text-xs">
                          {account.smtpHost}:{account.smtpPort}
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          {account.smtpSecure ? (
                            <Shield className="h-3.5 w-3.5 shrink-0 text-green-500" />
                          ) : (
                            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
                          )}
                          <span className="text-[11px] text-muted-foreground">
                            {account.smtpSecure ? "SSL/TLS" : "Insecure"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-white/10 pt-2.5">
                      <span className="pin-meta-label mb-1">Last Checked</span>
                      <span className="text-xs font-medium">
                        {account.lastCheckedAt
                          ? format(
                              new Date(account.lastCheckedAt),
                              "MMM d, HH:mm",
                            )
                          : "Never"}
                      </span>
                      {account.lastError ? (
                        // Full text, not a 2-line clamp behind a title tooltip:
                        // `title` never fires on touch, so the reason for a
                        // failure was unreadable on a phone.
                        <p className="pin-break mt-1.5 text-xs text-destructive">
                          {account.lastError}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-white/[0.02] px-3 py-2.5 sm:px-5 sm:py-3">
                  <div className="flex gap-2">
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
                          isBusy(scanAccount, account.id) ? "animate-spin" : ""
                        }`}
                      />
                      Scan
                    </Button>
                  </div>

                  {/* gap-1 (not gap-0.5): these were three 32px targets 2px
                      apart, and mis-tapping Edit hit the unconfirmed Pause. */}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-full"
                      title={
                        account.active ? "Pause monitoring" : "Resume monitoring"
                      }
                      aria-label={
                        account.active ? "Pause monitoring" : "Resume monitoring"
                      }
                      onClick={() => toggleActive(account)}
                      disabled={isBusy(updateAccount, account.id)}
                    >
                      {account.active ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-full"
                      title="Edit account"
                      aria-label="Edit account"
                      onClick={() => setDialogState({ mode: "edit", account })}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Remove account"
                          aria-label="Remove account"
                          className="rounded-full text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle className="font-bold">
                            Remove Account?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            <span className="pin-break font-semibold text-foreground">
                              {account.label}
                            </span>{" "}
                            will stop being monitored and will disappear from
                            this list. Its matched messages stay in history and
                            remain attributed to it. To stop monitoring
                            temporarily, pause the account instead.
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
                            Remove Account
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="col-span-full">
            <div className="pin-card flex flex-col items-center justify-center border-2 border-dashed border-white/10 p-6 text-center sm:p-12">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted/50">
                <Server className="h-7 w-7 text-muted-foreground/40" />
              </div>
              <h3 className="text-base font-semibold text-foreground">
                No Accounts Configured
              </h3>
              <p className="mt-1 mb-6 max-w-sm text-sm text-muted-foreground">
                Add your first email account to start monitoring for important
                messages.
              </p>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                <Button
                  onClick={() => setDialogState({ mode: "create" })}
                  className="pin-btn-primary w-full sm:w-auto"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Account
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setDialogState({ mode: "bulk" })}
                  className="w-full sm:w-auto"
                >
                  <Users className="mr-2 h-4 w-4" />
                  Bulk Add
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountDialogs({
  state,
  onClose,
  onSaved,
}: {
  state: DialogState;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px]">
        {state?.mode === "bulk" ? (
          <BulkAccountForm onClose={onClose} onSaved={onSaved} />
        ) : state ? (
          <AccountForm
            // Remount on target change so the form never shows another
            // account's values.
            key={state.mode === "edit" ? `edit-${state.account.id}` : "create"}
            state={state}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AccountForm({
  state,
  onClose,
  onSaved,
}: {
  state: { mode: "create" } | { mode: "edit"; account: EmailAccount };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isEdit = state.mode === "edit";
  const account = state.mode === "edit" ? state.account : null;

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(isEdit ? accountSchema : createAccountSchema),
    defaultValues: {
      label: account?.label ?? "",
      emailAddress: account?.emailAddress ?? "",
      imapHost: account?.imapHost ?? "",
      imapPort: account?.imapPort ?? 993,
      imapSecure: account?.imapSecure ?? true,
      smtpHost: account?.smtpHost ?? "",
      smtpPort: account?.smtpPort ?? 465,
      smtpSecure: account?.smtpSecure ?? true,
      username: account?.username ?? "",
      password: "",
      allowInvalidCert: account?.allowInvalidCert ?? false,
    },
  });

  const createAccount = useCreateAccount({
    mutation: {
      onSuccess: () => {
        toast({ title: "Account added successfully" });
        onSaved();
        onClose();
      },
      onError: (err) => {
        toast({
          title: "Failed to add account",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const updateAccount = useUpdateAccount({
    mutation: {
      onSuccess: () => {
        toast({ title: "Account updated" });
        onSaved();
        onClose();
      },
      onError: (err) => {
        toast({
          title: "Failed to update account",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const isPending = createAccount.isPending || updateAccount.isPending;

  function onSubmit(values: AccountFormValues) {
    if (account) {
      const { password, ...rest } = values;
      // An empty field means "keep the stored password".
      const data: UpdateAccountBody = password
        ? { ...rest, password }
        : { ...rest };
      updateAccount.mutate({ id: account.id, data });
      return;
    }
    createAccount.mutate({ data: values });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base font-bold sm:text-lg">
          <span className="pin-break">
            {isEdit ? `Edit ${account?.label}` : "Add Email Account"}
          </span>
        </DialogTitle>
        <DialogDescription>
          Configure IMAP for reading and SMTP for forwarding capability. App
          passwords are recommended.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 pt-2">
          {/* Single column on mobile: two inputs cannot fit side by side at
              360px, and they overflowed the dialog. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="pin-meta-label">
                    Account Label
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Personal Gmail"
                      className="pin-input"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="emailAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="pin-meta-label">
                    Email Address
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="user@example.com"
                      type="email"
                      inputMode="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="pin-input"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <ServerFieldset
            title="IMAP Settings (Incoming)"
            control={form.control}
            hostName="imapHost"
            portName="imapPort"
            secureName="imapSecure"
            hostPlaceholder="imap.gmail.com"
          />

          <ServerFieldset
            title="SMTP Settings (Outgoing)"
            control={form.control}
            hostName="smtpHost"
            portName="smtpPort"
            secureName="smtpSecure"
            hostPlaceholder="smtp.gmail.com"
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="pin-meta-label">Username</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Usually email address"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="pin-input"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="pin-meta-label">
                    Password / App Password
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="pin-input"
                      {...field}
                    />
                  </FormControl>
                  {isEdit ? (
                    <FormDescription className="text-xs">
                      Leave blank to keep the current password.
                    </FormDescription>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="allowInvalidCert"
            render={({ field }) => (
              <FormItem className="rounded-xl border border-white/10 bg-black/20 p-3 sm:p-4">
                <div className="flex flex-row items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <FormLabel className="flex items-center gap-1.5 text-sm font-medium">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-yellow-400" />
                      Accept mismatched TLS certificate
                    </FormLabel>
                    <FormDescription className="text-xs">
                      Enable if the connection test fails with a certificate or
                      hostname error. Shared cPanel hosting often serves the
                      provider's own certificate on{" "}
                      <code className="font-mono">mail.yourdomain.com</code>,
                      which a strict client rejects even though the mailbox works.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      className="mt-0.5 shrink-0"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </div>
                {field.value ? (
                  <p className="mt-2 text-xs text-yellow-400/90">
                    The connection stays encrypted, but the server's identity is
                    no longer verified, so a network attacker could impersonate
                    it. Leave off unless a test actually fails.
                  </p>
                ) : null}
              </FormItem>
            )}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="rounded-full"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending} className="rounded-full">
              {isPending
                ? isEdit
                  ? "Saving..."
                  : "Adding..."
                : isEdit
                  ? "Save Changes"
                  : "Add Account"}
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </>
  );
}

/** Host + port + TLS block, shared by the IMAP and SMTP halves of the form. */
function ServerFieldset({
  title,
  control,
  hostName,
  portName,
  secureName,
  hostPlaceholder,
}: {
  title: string;
  control: ReturnType<typeof useForm<AccountFormValues>>["control"];
  hostName: "imapHost" | "smtpHost";
  portName: "imapPort" | "smtpPort";
  secureName: "imapSecure" | "smtpSecure";
  hostPlaceholder: string;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-white/10 bg-black/20 p-3 sm:p-5">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
          <Server className="h-3.5 w-3.5 text-sidebar-primary" />
        </div>
        {title}
      </h4>
      {/* Host takes the full width on mobile; port is narrow enough to sit
          beside it only from sm up. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FormField
          control={control}
          name={hostName}
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel className="pin-meta-label">Host</FormLabel>
              <FormControl>
                <Input
                  placeholder={hostPlaceholder}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="pin-input"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={portName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="pin-meta-label">Port</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  className="pin-input"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <FormField
        control={control}
        name={secureName}
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 p-3 sm:p-4">
            <div className="min-w-0 space-y-0.5">
              <FormLabel className="text-sm font-medium">Use SSL/TLS</FormLabel>
            </div>
            <FormControl>
              <Switch
                className="shrink-0"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  );
}

const bulkSchema = z.object({
  addresses: z.string().min(1, "Enter at least one email address"),
  password: z.string(),
  // Blank means "derive mail.<domain> per address", which is what lets one paste
  // cover mailboxes on several different domains.
  imapHost: z.string(),
  imapPort: port(993),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string(),
  smtpPort: port(465),
  smtpSecure: z.boolean().default(true),
  allowInvalidCert: z.boolean().default(false),
});

type BulkFormValues = z.infer<typeof bulkSchema>;

function BulkAccountForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [result, setResult] = useState<{
    created: number;
    failed: Array<{ emailAddress: string; reason: string }>;
  } | null>(null);

  const form = useForm<BulkFormValues>({
    resolver: zodResolver(bulkSchema),
    defaultValues: {
      addresses: "",
      password: "",
      imapHost: "",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "",
      smtpPort: 465,
      smtpSecure: true,
      allowInvalidCert: false,
    },
  });

  const addressesRaw = form.watch("addresses");
  const imapHostRaw = form.watch("imapHost");
  const smtpHostRaw = form.watch("smtpHost");
  const sharedPassword = form.watch("password");

  const rows = useMemo(() => parseMailboxLines(addressesRaw), [addressesRaw]);
  const invalid = useMemo(() => rows.filter((r) => !r.valid), [rows]);
  const domains = useMemo(() => distinctDomains(rows), [rows]);
  const needingShared = useMemo(() => rows.filter((r) => !r.password), [rows]);
  const overLimit = rows.length > BULK_MAX_ACCOUNTS;

  const derivingHosts = imapHostRaw.trim() === "" || smtpHostRaw.trim() === "";
  const sharedMissing =
    needingShared.length > 0 && sharedPassword.trim() === "";

  const createBulk = useCreateAccountsBulk({
    mutation: {
      onSuccess: (data) => {
        setResult({ created: data.created.length, failed: data.failed });
        onSaved();
        if (data.failed.length === 0) {
          toast({
            title: `Added ${data.created.length} account${data.created.length === 1 ? "" : "s"}`,
          });
          onClose();
          return;
        }
        toast({
          title: `Added ${data.created.length}, skipped ${data.failed.length}`,
          description: "See the details in the dialog.",
          variant: "destructive",
        });
      },
      onError: (err) => {
        toast({
          title: "Bulk add failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  function onSubmit(values: BulkFormValues) {
    if (invalid.length > 0) {
      form.setError("addresses", {
        message: `Not a valid address on line${invalid.length === 1 ? "" : "s"} ${invalid
          .map((r) => r.line)
          .join(", ")}`,
      });
      return;
    }
    if (overLimit) {
      form.setError("addresses", {
        message: `At most ${BULK_MAX_ACCOUNTS} addresses per batch.`,
      });
      return;
    }
    if (sharedMissing) {
      form.setError("password", {
        message: `${needingShared.length} address${needingShared.length === 1 ? "" : "es"} have no inline password, so a shared one is required.`,
      });
      return;
    }

    setResult(null);
    const imapHost = values.imapHost.trim();
    const smtpHost = values.smtpHost.trim();

    createBulk.mutate({
      data: {
        accounts: rows.map((r) => ({
          emailAddress: r.emailAddress,
          ...(r.password ? { password: r.password } : {}),
        })),
        // Omit rather than send empty: absent means "derive per address" on the
        // server, and an empty string would fail its minLength check.
        ...(needingShared.length > 0
          ? { password: values.password.trim() }
          : {}),
        ...(imapHost ? { imapHost } : {}),
        ...(smtpHost ? { smtpHost } : {}),
        imapPort: values.imapPort,
        imapSecure: values.imapSecure,
        smtpPort: values.smtpPort,
        smtpSecure: values.smtpSecure,
        allowInvalidCert: values.allowInvalidCert,
      },
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base font-bold sm:text-lg">
          Bulk Add Accounts
        </DialogTitle>
        <DialogDescription>
          Each address gets <code className="font-mono">mail.&lt;its own domain&gt;</code>{" "}
          by default, so a list spanning several domains works in one paste. Fix
          any that differ by editing the account afterwards.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 pt-2">
          <FormField
            control={form.control}
            name="addresses"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="pin-meta-label">
                  Email Addresses
                </FormLabel>
                <FormControl>
                  <Textarea
                    rows={6}
                    placeholder={
                      "sales@example.com\nsupport@otherdomain.com, itsOwnPassword\nbilling@third.co.uk"
                    }
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="pin-input font-mono"
                    {...field}
                  />
                </FormControl>
                <FormDescription className="text-xs">
                  One per line. Add a password after the address to use a
                  different one for that mailbox.
                  {rows.length > 0 ? (
                    <>
                      {" "}
                      <span
                        className={
                          overLimit || invalid.length > 0
                            ? "font-medium text-destructive"
                            : "font-medium text-foreground"
                        }
                      >
                        {rows.length} address{rows.length === 1 ? "" : "es"}
                        {domains.length > 1
                          ? ` across ${domains.length} domains`
                          : ""}
                        {rows.length - needingShared.length > 0
                          ? `, ${rows.length - needingShared.length} with an inline password`
                          : ""}
                        {overLimit ? ` (max ${BULK_MAX_ACCOUNTS})` : ""}
                        {invalid.length > 0
                          ? `, ${invalid.length} malformed`
                          : ""}
                      </span>
                    </>
                  ) : null}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Show exactly which servers will be used, so a wrong guess is caught
              before 12 broken accounts are created. */}
          {derivingHosts && domains.length > 0 ? (
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <span className="pin-meta-label mb-2">
                Servers that will be used
              </span>
              <ul className="max-h-32 space-y-1 overflow-y-auto">
                {domains.map((d) => (
                  <li key={d} className="pin-break font-mono text-xs">
                    <span className="text-muted-foreground">{d}</span>
                    {" → "}
                    <span className="text-foreground">mail.{d}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Set a host below to override this for every address instead.
              </p>
            </div>
          ) : null}

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="pin-meta-label">
                  Shared Password / App Password
                </FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    aria-invalid={sharedMissing}
                    className="pin-input"
                    {...field}
                  />
                </FormControl>
                <FormDescription className="text-xs">
                  Used for any address without an inline password. Leave blank if
                  every line carries its own.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <ServerFieldsetBulk
            title="IMAP Settings (Incoming)"
            control={form.control}
            hostName="imapHost"
            portName="imapPort"
            secureName="imapSecure"
            hostPlaceholder="Leave blank to use mail.<domain>"
          />

          <ServerFieldsetBulk
            title="SMTP Settings (Outgoing)"
            control={form.control}
            hostName="smtpHost"
            portName="smtpPort"
            secureName="smtpSecure"
            hostPlaceholder="Leave blank to use mail.<domain>"
          />

          <FormField
            control={form.control}
            name="allowInvalidCert"
            render={({ field }) => (
              <FormItem className="rounded-xl border border-white/10 bg-black/20 p-3 sm:p-4">
                <div className="flex flex-row items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <FormLabel className="flex items-center gap-1.5 text-sm font-medium">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-yellow-400" />
                      Accept mismatched TLS certificates
                    </FormLabel>
                    <FormDescription className="text-xs">
                      Applies to every address in this batch. Shared cPanel
                      hosting typically serves the provider's own certificate on
                      mail.&lt;domain&gt;, so leave this on for such mailboxes and
                      turn it off per account later if not needed.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      className="mt-0.5 shrink-0"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />

          {result && result.failed.length > 0 ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-sm font-semibold text-foreground">
                Added {result.created}, skipped {result.failed.length}
              </p>
              <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
                {result.failed.map((f) => (
                  <li key={f.emailAddress} className="text-xs">
                    <span className="pin-break font-mono text-foreground">
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

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="rounded-full"
            >
              {result ? "Done" : "Cancel"}
            </Button>
            <Button
              type="submit"
              disabled={createBulk.isPending || rows.length === 0}
              className="rounded-full"
            >
              {createBulk.isPending
                ? "Adding..."
                : `Add ${rows.length || ""} Account${rows.length === 1 ? "" : "s"}`.trim()}
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </>
  );
}

/** Same layout as ServerFieldset, bound to the bulk form's field names. */
function ServerFieldsetBulk({
  title,
  control,
  hostName,
  portName,
  secureName,
  hostPlaceholder,
}: {
  title: string;
  control: ReturnType<typeof useForm<BulkFormValues>>["control"];
  hostName: "imapHost" | "smtpHost";
  portName: "imapPort" | "smtpPort";
  secureName: "imapSecure" | "smtpSecure";
  hostPlaceholder: string;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-white/10 bg-black/20 p-3 sm:p-5">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10">
          <Server className="h-3.5 w-3.5 text-sidebar-primary" />
        </div>
        {title}
      </h4>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FormField
          control={control}
          name={hostName}
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel className="pin-meta-label">Host</FormLabel>
              <FormControl>
                <Input
                  placeholder={hostPlaceholder}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="pin-input"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={portName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="pin-meta-label">Port</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  className="pin-input"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <FormField
        control={control}
        name={secureName}
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 p-3 sm:p-4">
            <div className="min-w-0 space-y-0.5">
              <Label className="text-sm font-medium">Use SSL/TLS</Label>
            </div>
            <FormControl>
              <Switch
                className="shrink-0"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  );
}
