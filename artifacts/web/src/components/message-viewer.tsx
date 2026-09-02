import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Check,
  Code2,
  Eye,
  FileText,
  ImageOff,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { format } from "date-fns";
import type { MessageDetail } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

type ViewMode = "rendered" | "text" | "source";

/**
 * Build the document loaded into the preview iframe.
 *
 * Email HTML is fully untrusted, so it is never inserted into this document. It
 * goes into a `sandbox`ed iframe via srcdoc, with:
 *
 * - no `allow-scripts` and no `allow-same-origin`, so scripts cannot run and the
 *   frame has an opaque origin with no access to our cookies or DOM;
 * - a CSP that blocks every remote fetch by default. Marketing email is full of
 *   tracking pixels, and loading them would tell the sender the address is live
 *   and being read. Images are opt-in per message.
 * - `allow-popups` omitted, and a `base target="_blank"` so a clicked link cannot
 *   replace the app frame.
 */
function buildPreviewDocument(html: string, allowRemote: boolean): string {
  const imgSrc = allowRemote ? "https: data:" : "data:";
  const csp = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    // Inline styles are how all email is formatted; there is no script to pair
    // them with because script-src stays 'none'.
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  :root { color-scheme: light; }
  html, body {
    margin: 0;
    padding: 16px;
    background: #ffffff;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    /* Email tables are routinely 600-800px wide; let them scroll rather than
       forcing a horizontal scrollbar onto the whole app. */
    overflow-x: auto;
    -webkit-text-size-adjust: 100%;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #b00f1c; }
  pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head><body>${html}</body></html>`;
}

/** Rough byte size of a string, for the truncation notice. */
function approxSize(text: string): string {
  const bytes = new Blob([text]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageViewer({
  open,
  onClose,
  message,
  isLoading,
  isError,
  error,
  onDelete,
  isDeleting,
}: {
  open: boolean;
  onClose: () => void;
  message: MessageDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onDelete?: () => void;
  isDeleting?: boolean;
}) {
  const { toast } = useToast();
  const [maximized, setMaximized] = useState(false);
  const [mode, setMode] = useState<ViewMode>("rendered");
  const [allowRemote, setAllowRemote] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const hasHtml = Boolean(message?.bodyHtml);
  const hasText = Boolean(message?.bodyText);

  // Reset per-message: a new message must not inherit the previous one's view
  // mode or its decision to load remote images.
  useEffect(() => {
    setMode(hasHtml ? "rendered" : "text");
    setAllowRemote(false);
    setCopied(false);
  }, [message?.id, hasHtml]);

  // Escape closes, matching the dialog convention this replaces.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock background scroll while the viewer is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const previewDoc = useMemo(
    () =>
      message?.bodyHtml
        ? buildPreviewDocument(message.bodyHtml, allowRemote)
        : "",
    [message?.bodyHtml, allowRemote],
  );

  const plainForCopy = message?.bodyText ?? message?.snippet ?? "";

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(plainForCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Could not copy",
        description: "Clipboard access was denied by the browser.",
        variant: "destructive",
      });
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={message?.subject ?? "Message"}
      // Click-outside to dismiss, but only on the backdrop itself so a drag
      // inside the message does not close it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex flex-col overflow-hidden border border-white/10 bg-background shadow-2xl ${
          maximized
            ? "h-dvh w-full rounded-none"
            : "h-dvh w-full rounded-none sm:h-[85dvh] sm:max-w-3xl sm:rounded-2xl"
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-white/10 p-3 sm:p-4">
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <Skeleton className="h-5 w-2/3" />
            ) : (
              <h2 className="pin-break text-sm font-semibold text-foreground sm:text-base">
                {message?.subject ?? "Message"}
              </h2>
            )}
            {message ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="pin-break">{message.fromAddress}</span>
                <span>
                  {format(new Date(message.receivedAt), "MMM d, yyyy HH:mm")}
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              // Maximize is pointless on a phone, where the viewer is already
              // full-screen.
              className="hidden rounded-full sm:inline-flex"
              title={maximized ? "Restore size" : "Maximize"}
              aria-label={maximized ? "Restore size" : "Maximize"}
              onClick={() => setMaximized((m) => !m)}
            >
              {maximized ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>
            <Button
              ref={closeRef}
              variant="ghost"
              size="icon"
              className="rounded-full"
              title="Close"
              aria-label="Close"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Toolbar */}
        {message ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2 sm:px-4">
            <div className="flex items-center gap-1 rounded-full border border-white/10 p-0.5">
              {hasHtml ? (
                <ModeButton
                  active={mode === "rendered"}
                  onClick={() => setMode("rendered")}
                  icon={Eye}
                  label="Preview"
                />
              ) : null}
              <ModeButton
                active={mode === "text"}
                onClick={() => setMode("text")}
                icon={FileText}
                label="Text"
                disabled={!hasText}
              />
              {hasHtml ? (
                <ModeButton
                  active={mode === "source"}
                  onClick={() => setMode("source")}
                  icon={Code2}
                  label="Source"
                />
              ) : null}
            </div>

            {mode === "rendered" && hasHtml ? (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full text-xs"
                onClick={() => setAllowRemote((v) => !v)}
                title={
                  allowRemote
                    ? "Block remote images again"
                    : "Remote images can tell the sender you opened this email"
                }
              >
                {allowRemote ? (
                  <>
                    <ImageIcon className="mr-1.5 h-3.5 w-3.5" />
                    Images on
                  </>
                ) : (
                  <>
                    <ImageOff className="mr-1.5 h-3.5 w-3.5" />
                    Load images
                  </>
                )}
              </Button>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              className="rounded-full text-xs"
              onClick={copyBody}
              disabled={!plainForCopy}
            >
              {copied ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copy text
                </>
              )}
            </Button>

            {onDelete ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isDeleting}
                    className="ml-auto rounded-full text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-bold">
                      Delete this message?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      It will be removed from your history permanently, including
                      the full body stored here. The original email in the mailbox
                      is not touched.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="rounded-full">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => {
                        onDelete();
                        onClose();
                      }}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        ) : null}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="p-4 sm:p-6">
              <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4">
                <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">
                    Could not load this message
                  </h3>
                  <p className="pin-break mt-1 text-sm text-muted-foreground">
                    {error?.message ?? "The API server did not respond."}
                  </p>
                </div>
              </div>
            </div>
          ) : message ? (
            <>
              <MetaBlock message={message} />

              {message.bodyTruncated ? (
                <div className="mx-3 mb-3 flex items-start gap-2 rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3 sm:mx-4">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
                  <p className="text-xs text-muted-foreground">
                    This email exceeded the stored size limit, so the end of the
                    body was cut. Everything shown is verbatim.
                  </p>
                </div>
              ) : null}

              {mode === "rendered" && message.bodyHtml ? (
                <div className="px-3 pb-3 sm:px-4 sm:pb-4">
                  {!allowRemote ? (
                    <p className="mb-2 text-xs text-muted-foreground">
                      Remote images are blocked. Loading them tells the sender you
                      opened this email.
                    </p>
                  ) : null}
                  <iframe
                    // Untrusted content. No allow-scripts and no
                    // allow-same-origin: the frame gets an opaque origin, cannot
                    // run JS, and cannot reach this page's DOM or cookies.
                    sandbox=""
                    srcDoc={previewDoc}
                    title="Email preview"
                    // referrerPolicy stops the app's URL leaking to any image
                    // host once remote content is enabled.
                    referrerPolicy="no-referrer"
                    className={`w-full rounded-xl border border-white/10 bg-white ${
                      maximized ? "h-[calc(100dvh-22rem)] min-h-[20rem]" : "h-[60dvh]"
                    }`}
                  />
                </div>
              ) : mode === "text" ? (
                <pre className="pin-break whitespace-pre-wrap px-3 pb-4 font-mono text-xs leading-relaxed text-foreground/85 sm:px-4 sm:text-sm">
                  {message.bodyText ??
                    "This email had no plain-text part. Switch to Preview or Source."}
                </pre>
              ) : (
                <pre className="pin-break whitespace-pre-wrap px-3 pb-4 font-mono text-[11px] leading-relaxed text-foreground/70 sm:px-4 sm:text-xs">
                  {message.bodyHtml}
                </pre>
              )}

              {!message.bodyText && !message.bodyHtml ? (
                <div className="px-3 pb-4 sm:px-4">
                  <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <p className="text-sm text-muted-foreground">
                      No body was stored for this message. It was captured before
                      full bodies were recorded; only the preview below is
                      available.
                    </p>
                    <p className="pin-break mt-2 text-sm italic text-foreground/75">
                      "{message.snippet}"
                    </p>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Eye;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`inline-flex min-h-9 items-center rounded-full px-3 text-xs font-medium transition-colors disabled:opacity-40 ${
        active
          ? "bg-sidebar-accent/80 text-sidebar-accent-foreground"
          : "text-muted-foreground active:bg-white/10 md:hover:text-foreground"
      }`}
    >
      <Icon className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function MetaBlock({ message }: { message: MessageDetail }) {
  return (
    <div className="space-y-3 p-3 sm:p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="From" value={message.fromAddress} mono />
        <Field label="To" value={message.toAddress} mono />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field
          label="Mailbox"
          value={
            message.accountDeleted
              ? `${message.accountEmail} (since removed)`
              : message.accountEmail
          }
          mono
        />
        {message.messageId ? (
          <Field label="Message-ID" value={message.messageId} mono />
        ) : null}
      </div>

      {message.matchedKeywords && message.matchedKeywords.length > 0 ? (
        <div>
          <span className="pin-meta-label mb-1.5">Matched keywords</span>
          <div className="flex flex-wrap gap-1.5">
            {message.matchedKeywords.map((k) => (
              <span key={k} className="pin-badge">
                {k}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {message.forwardError ? (
        <div>
          <span className="pin-meta-label mb-1.5">Forwarding error</span>
          <div className="pin-break rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 font-mono text-xs text-destructive">
            {message.forwardError}
          </div>
        </div>
      ) : message.forwarded ? (
        <Badge className="h-5 rounded-full border-green-500/25 bg-green-500/10 px-2 text-[11px] uppercase text-green-400">
          Forwarded
        </Badge>
      ) : null}

      {message.bodyHtml || message.bodyText ? (
        <p className="text-[11px] text-muted-foreground">
          Stored body:{" "}
          {message.bodyText ? `text ${approxSize(message.bodyText)}` : "no text"}
          {message.bodyHtml ? `, HTML ${approxSize(message.bodyHtml)}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span className="pin-meta-label mb-1.5">{label}</span>
      <div
        className={`pin-break rounded-lg border border-white/10 bg-black/30 p-2.5 text-xs ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
