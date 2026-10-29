import { useState } from "react";
import {
  useListMessages,
  getListMessagesQueryKey,
  useGetMessage,
  getGetMessageQueryKey,
  useListAccounts,
  getListAccountsQueryKey,
  useDeleteMessage,
  useExportMessages,
  useDeleteMessagesBulk,
  useRecheckArchiveForMatches,
  getGetStatsSummaryQueryKey,
  getGetKeywordBreakdownQueryKey,
  getGetAccountActivityQueryKey,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import {
  Inbox,
  Filter,
  AlertCircle,
  AlertTriangle,
  Archive,
  ChevronRight,
  Download,
  Search,
  SearchCheck,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Link } from "wouter";
import { MessageViewer } from "@/components/message-viewer";
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

const PAGE_SIZE = 50;
/** Long enough that typing does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

/** Saves any payload as a pretty-printed JSON file download. */
function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Messages() {
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");
  const [searchInput, setSearchInput] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const search = useDebouncedValue(searchInput.trim(), SEARCH_DEBOUNCE_MS);
  const accountIdParam =
    selectedAccountId !== "all" ? parseInt(selectedAccountId) : undefined;

  const { data: accounts } = useListAccounts(undefined, {
    query: { queryKey: getListAccountsQueryKey() },
  });
  const accountsList = accounts ?? [];

  const listParams = {
    ...(accountIdParam !== undefined ? { accountId: accountIdParam } : {}),
    ...(search ? { search } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const {
    data: messages,
    isLoading: messagesLoading,
    isFetching,
    isError,
    error,
  } = useListMessages(listParams, {
    query: { queryKey: getListMessagesQueryKey(listParams) },
  });
  const messagesList = messages ?? [];
  // A full page implies there may be another; the API returns no total count.
  const hasNextPage = messagesList.length === PAGE_SIZE;

  // Bodies are large, so the list omits them and the full message is fetched only
  // when one is opened.
  const detail = useGetMessage(openId ?? 0, {
    query: {
      queryKey: getGetMessageQueryKey(openId ?? 0),
      enabled: openId !== null,
      // A stored email never changes, so there is no reason to refetch it.
      staleTime: Infinity,
    },
  });

  const invalidateMessageViews = () => {
    queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetStatsSummaryQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetKeywordBreakdownQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetAccountActivityQueryKey(),
    });
  };

  const deleteMessage = useDeleteMessage({
    mutation: {
      onSuccess: () => {
        toast({ title: "Message deleted" });
        invalidateMessageViews();
      },
      onError: (err) => {
        toast({
          title: "Failed to delete message",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  // Export selection or every match for the current filters; the server packs
  // full bodies either way, so both land as one complete-JSON download.
  const exportMessages = useExportMessages({
    mutation: {
      onSuccess: (data, variables) => {
        const bySelection =
          variables.data.ids !== undefined && variables.data.ids.length > 0;
        const count = Array.isArray(data) ? data.length : 0;
        const stamp = format(new Date(), "yyyy-MM-dd-HHmmss");
        downloadJson(
          `messages-${bySelection ? "selection" : "matching"}-${stamp}.json`,
          data,
        );
        toast({
          title: `Exported ${count} message${count === 1 ? "" : "s"}`,
          description: bySelection
            ? "Selected messages with their complete bodies."
            : "Every message matching the current search and filters.",
        });
      },
      onError: (err) => {
        toast({
          title: "Export failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const deleteBulk = useDeleteMessagesBulk({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: `Deleted ${data.deleted.length} message${data.deleted.length === 1 ? "" : "s"}`,
          description:
            data.notFound.length > 0
              ? `${data.notFound.length} were already gone.`
              : undefined,
        });
        setSelectedIds(new Set());
        invalidateMessageViews();
      },
      onError: (err) => {
        toast({
          title: "Failed to delete messages",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  const recheckArchive = useRecheckArchiveForMatches({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: `${data.inserted} new match${data.inserted === 1 ? "" : "es"} found`,
          description: data.message,
        });
        invalidateMessageViews();
      },
      onError: (err) => {
        toast({
          title: "Re-check failed",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  // Derived, not raw: a refetch can drop a row that is still in selectedIds.
  // Reading the selection through the visible list keeps the count and the ids
  // sent to the server in agreement, and it self-heals without an effect.
  const selectedMessages = messagesList.filter((m) => selectedIds.has(m.id));
  const selectedCount = selectedMessages.length;

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectPage = () =>
    setSelectedIds(new Set(messagesList.map((m) => m.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const onFilterChange = (value: string) => {
    setSelectedAccountId(value);
    setPage(0);
  };

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="pin-section-title">Messages</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Emails that matched your keywords, across every account and folder.
            Unfiltered Hostinger mail is under{" "}
            <Link href="/inbox" className="text-sidebar-primary hover:underline">
              Hostinger Inbox
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="outline"
            className="w-full rounded-full sm:w-auto"
            disabled={recheckArchive.isPending}
            title="Re-test every archived message with the current keywords and surface the hits here. Recovers matches missed before a keyword was added or by the older matcher."
            onClick={() => recheckArchive.mutate()}
          >
            <SearchCheck
              className={`mr-2 h-4 w-4 ${recheckArchive.isPending ? "animate-pulse" : ""}`}
            />
            {recheckArchive.isPending ? "Re-checking..." : "Re-check Archive"}
          </Button>
          <Select value={selectedAccountId} onValueChange={onFilterChange}>
            {/* Full width on mobile so the control is easy to hit. */}
            <SelectTrigger className="w-full rounded-xl sm:w-[220px]">
              <Filter className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Accounts</SelectItem>
              {accountsList.map((acc) => (
                <SelectItem key={acc.id} value={acc.id.toString()}>
                  {acc.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setPage(0);
          }}
          placeholder="Search subject, sender, recipient, or body..."
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Search matched messages"
          className="pin-input pl-9 pr-10"
        />
        {searchInput ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setSearchInput("");
              setPage(0);
            }}
            className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-white/10 md:hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {isError ? (
        <div className="pin-card flex items-start gap-3 border border-destructive/30 p-4 sm:p-6">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Could not load messages
            </h3>
            <p className="pin-break mt-1 text-sm text-muted-foreground">
              {error?.message ?? "The API server did not respond."}
            </p>
          </div>
        </div>
      ) : null}

      {/* Selection bar. Sticky at the top, matching the Accounts page. */}
      {selectedCount > 0 ? (
        <div className="sticky top-14 z-30 md:top-0">
          <div className="pin-card flex flex-wrap items-center justify-between gap-3 border border-sidebar-primary/40 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-semibold text-foreground">
                {selectedCount} selected
              </span>
              <button
                type="button"
                onClick={selectPage}
                className="text-xs font-medium text-sidebar-primary hover:underline"
              >
                Select page
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs font-medium text-muted-foreground hover:underline"
              >
                Clear
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                disabled={exportMessages.isPending}
                onClick={() =>
                  exportMessages.mutate({
                    data: { ids: selectedMessages.map((m) => m.id) },
                  })
                }
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {exportMessages.isPending
                  ? "Exporting..."
                  : `Export ${selectedCount} (JSON)`}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deleteBulk.isPending}
                    className="rounded-full text-destructive hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {deleteBulk.isPending
                      ? "Deleting..."
                      : `Delete ${selectedCount}`}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-bold">
                      Delete {selectedCount} message
                      {selectedCount === 1 ? "" : "s"}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      They are removed from the queue permanently. The same
                      email is not re-captured, because scans only read mail
                      that arrives after the last pass.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="max-h-40 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2.5">
                    <ul className="space-y-1">
                      {selectedMessages.map((m) => (
                        <li
                          key={m.id}
                          className="pin-break text-xs text-muted-foreground"
                        >
                          {m.subject}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="rounded-full">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() =>
                        deleteBulk.mutate({
                          data: { ids: selectedMessages.map((m) => m.id) },
                        })
                      }
                    >
                      Delete {selectedCount}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </div>
      ) : null}

      {/* Message List */}
      <div className="space-y-3">
        {messagesLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : messagesList.length > 0 ? (
          messagesList.map((msg) => {
            const isSelected = selectedIds.has(msg.id);
            return (
              <div
                key={msg.id}
                className={`pin-card overflow-hidden ${
                  isSelected ? "ring-2 ring-sidebar-primary/60" : ""
                }`}
              >
                <div className="flex">
                  {/* A 44px checkbox target beside the card, mirroring the
                      Accounts page; the rest of the row opens the message. */}
                  <label
                    className="-m-0 flex w-11 shrink-0 cursor-pointer items-center justify-center"
                    title={
                      isSelected ? "Deselect message" : "Select message"
                    }
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelected(msg.id)}
                      aria-label={`Select ${msg.subject}`}
                    />
                  </label>
                  {/* Opens the full message. The snippet in the list is only a
                      preview; the body is fetched on demand. */}
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer p-4 text-left transition-colors active:bg-muted/40 md:hover:bg-muted/40"
                    onClick={() => setOpenId(msg.id)}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="pin-break text-sm font-semibold">
                            {msg.subject}
                          </span>
                          {msg.folder && msg.folder !== "INBOX" ? (
                            <Badge
                              variant="outline"
                              className="h-5 shrink-0 rounded-full px-2 text-[11px] uppercase text-yellow-400"
                            >
                              {msg.folder}
                            </Badge>
                          ) : null}
                          {msg.forwarded ? (
                            <Badge className="h-5 rounded-full border-green-500/25 bg-green-500/10 px-2 text-[11px] uppercase text-green-400">
                              Forwarded
                            </Badge>
                          ) : msg.forwardError ? (
                            <Badge className="h-5 rounded-full border-red-500/25 bg-red-500/10 px-2 text-[11px] uppercase text-red-400">
                              <AlertTriangle className="mr-1 h-3 w-3" />
                              Forward failed
                            </Badge>
                          ) : null}
                        </div>
                        <div className="pin-break text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">
                            {msg.fromAddress}
                          </span>
                        </div>
                        <p className="pin-break line-clamp-2 text-xs text-muted-foreground/80">
                          {msg.snippet}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {msg.matchedKeywords.map((k) => (
                            <span key={k} className="pin-badge">
                              {k}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2 sm:shrink-0 sm:flex-col sm:items-end">
                        <div className="text-xs text-muted-foreground sm:text-right">
                          <span className="font-medium text-foreground/70">
                            {format(new Date(msg.receivedAt), "MMM d, yyyy")}
                          </span>
                          <span className="sm:block">
                            {" "}
                            {format(new Date(msg.receivedAt), "HH:mm")}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="h-5 min-w-0 rounded-full font-mono text-[11px]"
                            title={msg.accountEmail}
                          >
                            <span className="truncate">{msg.accountLabel}</span>
                          </Badge>
                          {msg.accountDeleted ? (
                            <Badge
                              variant="outline"
                              className="h-5 shrink-0 rounded-full px-2 text-[11px] uppercase text-muted-foreground"
                            >
                              <Archive className="mr-1 h-3 w-3" />
                              Removed
                            </Badge>
                          ) : null}
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </div>
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="pin-card flex flex-col items-center justify-center p-6 text-center sm:p-12">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted/50">
              <Inbox className="h-7 w-7 text-muted-foreground/40" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {search
                ? "No matches"
                : page > 0
                  ? "No more messages"
                  : "No messages yet"}
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {search
                ? `Nothing matches "${search}". Search covers subject, sender, recipient, and body.`
                : page > 0
                  ? "You have reached the end of the history."
                  : "Matched emails will appear here. Add keywords in Settings to start filtering."}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="outline"
          className="rounded-full"
          disabled={exportMessages.isPending || messagesLoading}
          title="Download every message matching the current search and account filter, complete with full bodies — not just the visible page."
          onClick={() =>
            exportMessages.mutate({
              data: {
                ...(accountIdParam !== undefined
                  ? { accountId: accountIdParam }
                  : {}),
                ...(search ? { search } : {}),
              },
            })
          }
        >
          <Download className="mr-2 h-4 w-4" />
          {exportMessages.isPending
            ? "Exporting..."
            : "Export all matching (JSON)"}
        </Button>

        {(page > 0 || hasNextPage) && (
          <div className="flex flex-1 items-center justify-end gap-3">
            <Button
              variant="outline"
              className="flex-1 rounded-full sm:flex-none"
              disabled={page === 0 || isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <span className="shrink-0 text-xs text-muted-foreground">
              Page {page + 1}
            </span>
            <Button
              variant="outline"
              className="flex-1 rounded-full sm:flex-none"
              disabled={!hasNextPage || isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      <MessageViewer
        open={openId !== null}
        onClose={() => setOpenId(null)}
        message={detail.data}
        isLoading={detail.isLoading}
        isError={detail.isError}
        error={detail.error ?? null}
        onDelete={
          openId !== null ? () => deleteMessage.mutate({ id: openId }) : undefined
        }
        isDeleting={deleteMessage.isPending}
      />
    </div>
  );
}
