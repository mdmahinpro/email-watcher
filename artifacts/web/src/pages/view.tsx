import {
  useGetViewMessage,
  getGetViewMessageQueryKey,
} from "@workspace/api-client-react";
import { useParams } from "wouter";
import { Logo } from "@/components/logo";
import { MessageViewer } from "@/components/message-viewer";

/**
 * The public page behind a signed Telegram link: one exact email, no session.
 *
 * Everything else in the app sits behind the login gate; this page is reached
 * through an unguessable, expiring token minted per message (see
 * `/api/view/:token`), which is why it is mounted before the gate in App.tsx.
 * The viewer is reused deliberately — the sandboxed-iframe rendering of the
 * untrusted email body is the security-relevant part, and duplicating it here
 * would be a second copy to get wrong.
 */
export default function MessageViewPage() {
  const params = useParams<{ token?: string }>();
  const token = params.token ?? "";

  const detail = useGetViewMessage(token, {
    query: {
      queryKey: getGetViewMessageQueryKey(token),
      enabled: token !== "",
      // The token either opens this message or it does not; it cannot become
      // valid again, so never refetch.
      staleTime: Infinity,
      retry: false,
    },
  });

  return (
    <div className="min-h-dvh bg-background">
      {/* The fixed overlay covers the whole page anyway; this bar shows where
          you are while the viewer loads and behind any error state. */}
      <div className="flex items-center justify-center gap-3 border-b border-white/10 bg-background px-4 py-3">
        <Logo className="h-6 w-6" />
        <span className="text-sm font-semibold text-foreground">
          Email Watcher
        </span>
      </div>
      <MessageViewer
        open
        onClose={() => {
          // Opened from Telegram, the natural way out is back; only a direct
          // visit has no history to return to.
          if (window.history.length > 1) {
            window.history.back();
          } else {
            window.location.assign("/");
          }
        }}
        message={detail.data}
        isLoading={detail.isLoading}
        isError={detail.isError}
        error={detail.error ?? null}
      />
    </div>
  );
}
