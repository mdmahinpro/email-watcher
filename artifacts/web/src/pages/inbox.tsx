import { useState } from "react";
import {
  useListInboxMessages,
  getListInboxMessagesQueryKey,
  useGetInboxMessage,
  getGetInboxMessageQueryKey,
  useDeleteInboxMessage,
  useListAccounts,
  getListAccountsQueryKey,
  getGetStatsSummaryQueryKey,
  type ListInboxMessagesParams,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import {
  Inbox,
  Filter,
  AlertCircle,
  Archive,
  Search,
  X,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { MessageViewer } from "@/components/message-viewer";

const PAGE_SIZE = 50;
/** Long enough that typing does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

export default function InboxPage() {
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");
  const [searchInput, setSearchInput] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const search = useDebouncedValue(searchInput.trim(), SEARCH_DEBOUNCE_MS);

  // Only Hostinger mailboxes archive unfiltered mail today, so the account
  // filter lists exactly those.
  const accountParams = { provider: "hostinger" } as const;
  const { data: accounts } = useListAccounts(accountParams, {
    query: { queryKey: getListAccountsQueryKey(accountParams) },
  });
  const accountsList = accounts ?? [];

  const listParams: ListInboxMessagesParams = {
    provider: "hostinger",
    ...(selectedAccountId !== "all"
      ? { accountId: Number(selectedAccountId) }
      : {}),
    ...(search ? { search } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const {
    data: messages,
    isLoading,
    isFetching,
    isError,
    error,
  } = useListInboxMessages(listParams, {
    query: { queryKey: getListInboxMessagesQueryKey(listParams) },
  });
  const messagesList = messages ?? [];
  // A full page implies there may be another; the API returns no total count.
  const hasNextPage = messagesList.length === PAGE_SIZE;

  // Bodies are large, so the list omits them and the full message is fetched only
  // when one is opened.
  const detail = useGetInboxMessage(openId ?? 0, {
    query: {
      queryKey: getGetInboxMessageQueryKey(openId ?? 0),
      enabled: openId !== null,
      // A stored email never changes, so there is no reason to refetch it.
      staleTime: Infinity,
    },
  });

  const deleteMessage = useDeleteInboxMessage({
    mutation: {
      onSuccess: () => {
        toast({ title: "Message deleted" });
        queryClient.invalidateQueries({
          queryKey: getListInboxMessagesQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: getGetStatsSummaryQueryKey() });
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

  const resetPaging = () => {
    setPage(0);
  };

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 sm:space-y-6">
      <div className="min-w-0">
        <h1 className="pin-section-title">Hostinger Inbox</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every email received in your Hostinger mailboxes, unfiltered. Tap a
          message to read it in full.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              resetPaging();
            }}
            placeholder="Search subject, sender, or body..."
            autoCapitalize="none"
            autoCorrect="off"
            aria-label="Search archived mail"
            className="pin-input pl-9 pr-10"
          />
          {searchInput ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setSearchInput("");
                resetPaging();
              }}
              className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-white/10 md:hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        <Select
          value={selectedAccountId}
          onValueChange={(v) => {
            setSelectedAccountId(v);
            resetPaging();
          }}
        >
          <SelectTrigger className="w-full rounded-xl sm:w-[240px]">
            <Filter className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <SelectValue placeholder="All mailboxes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Mailboxes</SelectItem>
            {accountsList.map((acc) => (
              <SelectItem key={acc.id} value={acc.id.toString()}>
                {acc.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isError ? (
        <div className="pin-card flex items-start gap-3 border border-destructive/30 p-4 sm:p-6">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Could not load mail
            </h3>
            <p className="pin-break mt-1 text-sm text-muted-foreground">
              {error?.message ?? "The API server did not respond."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : messagesList.length > 0 ? (
          messagesList.map((msg) => (
            <div key={msg.id} className="pin-card overflow-hidden">
              <button
                type="button"
                className="w-full cursor-pointer p-4 text-left transition-colors active:bg-muted/40 md:hover:bg-muted/40"
                onClick={() => setOpenId(msg.id)}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <span className="pin-break block text-sm font-semibold">
                      {msg.subject}
                    </span>
                    <span className="pin-break block text-xs text-muted-foreground">
                      {msg.fromAddress}
                    </span>
                    <p className="pin-break line-clamp-2 text-xs text-muted-foreground/80">
                      {msg.snippet}
                    </p>
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
          ))
        ) : (
          <div className="pin-card flex flex-col items-center justify-center p-6 text-center sm:p-12">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted/50">
              <Inbox className="h-7 w-7 text-muted-foreground/40" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {search
                ? "No matches"
                : page > 0
                  ? "No more mail"
                  : "No mail archived yet"}
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {search
                ? `Nothing in the archive matches "${search}".`
                : page > 0
                  ? "You have reached the end of the archive."
                  : "Mail from Hostinger mailboxes appears here after the next scan. Add mailboxes on the Hostinger page."}
            </p>
          </div>
        )}
      </div>

      {(page > 0 || hasNextPage) && (
        <div className="flex items-center justify-between gap-3">
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
