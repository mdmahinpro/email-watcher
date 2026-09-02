import { useState } from "react";
import {
  useListMessages,
  getListMessagesQueryKey,
  useGetMessage,
  getGetMessageQueryKey,
  useListAccounts,
  getListAccountsQueryKey,
  useDeleteMessage,
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
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Link } from "wouter";
import { MessageViewer } from "@/components/message-viewer";

const PAGE_SIZE = 50;

export default function Messages() {
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const accountIdParam =
    selectedAccountId !== "all" ? parseInt(selectedAccountId) : undefined;

  const { data: accounts } = useListAccounts(undefined, {
    query: { queryKey: getListAccountsQueryKey() },
  });
  const accountsList = accounts ?? [];

  const listParams = {
    ...(accountIdParam !== undefined ? { accountId: accountIdParam } : {}),
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
            Emails that matched your keywords. Unfiltered Hostinger mail is under{" "}
            <Link href="/inbox" className="text-sidebar-primary hover:underline">
              Hostinger Inbox
            </Link>
            .
          </p>
        </div>
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

      {/* Message List */}
      <div className="space-y-3">
        {messagesLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : messagesList.length > 0 ? (
          messagesList.map((msg) => (
            <div key={msg.id} className="pin-card overflow-hidden">
              {/* Opens the full message. The snippet in the list is only a
                  preview; the body is fetched on demand. */}
              <button
                type="button"
                className="w-full cursor-pointer p-4 text-left transition-colors active:bg-muted/40 md:hover:bg-muted/40"
                onClick={() => setOpenId(msg.id)}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="pin-break text-sm font-semibold">
                        {msg.subject}
                      </span>
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
          ))
        ) : (
          <div className="pin-card flex flex-col items-center justify-center p-6 text-center sm:p-12">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted/50">
              <Inbox className="h-7 w-7 text-muted-foreground/40" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {page > 0 ? "No more messages" : "No messages yet"}
            </h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {page > 0
                ? "You have reached the end of the history."
                : "Matched emails will appear here. Add keywords in Settings to start filtering."}
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
