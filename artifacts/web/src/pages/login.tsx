import { useState } from "react";
import { AlertCircle, Loader2, Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { useAuth } from "@/hooks/use-auth";

/**
 * The access gate.
 *
 * Deliberately says as little as possible: no hint about who the operator is, no
 * distinction between "wrong password" and "no password configured on the server"
 * beyond what the server itself reports, and no mailbox or domain names. An
 * unauthenticated visitor should learn nothing except that a password is needed.
 */
export default function Login() {
  const { signIn, isSigningIn, authRequired, isError, error } = useAuth();
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setFailure(null);
    try {
      await signIn(password);
      // On success the provider clears the cache and re-reads the session, which
      // swaps this screen out; no navigation needed.
    } catch (err) {
      // The server distinguishes 401 (wrong password), 429 (rate limited), and
      // 503 (not configured); surface its message rather than inventing one.
      setFailure(
        err instanceof Error ? err.message : "Sign in failed. Try again.",
      );
      setPassword("");
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="h-16 w-16" />
          <h1 className="mt-4 text-xl font-bold tracking-tight text-foreground">
            Email Watcher
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This instance is private.
          </p>
        </div>

        {!authRequired ? (
          <div className="pin-card mb-4 flex items-start gap-3 border border-yellow-500/30 p-4">
            <ShieldAlert className="h-5 w-5 shrink-0 text-yellow-400" />
            <div className="min-w-0 text-sm">
              <h2 className="font-semibold text-foreground">
                No password configured
              </h2>
              <p className="mt-1 text-muted-foreground">
                The server has no <code className="font-mono">APP_PASSWORD_HASH</code>,
                so every request is refused. Run{" "}
                <code className="pin-break font-mono">
                  pnpm --filter @workspace/scripts run set-password
                </code>{" "}
                and restart the API server.
              </p>
            </div>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="pin-card space-y-4 p-5 sm:p-6">
          <div className="space-y-2">
            <Label htmlFor="password" className="pin-meta-label">
              Password
            </Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                // The browser password manager is the intended place to keep
                // this, so let it offer to save and fill.
                autoComplete="current-password"
                // Autofocus is appropriate here: the field is the only control
                // on the page and the sole reason for the visit.
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSigningIn || !authRequired}
                aria-invalid={failure !== null}
                aria-describedby={failure ? "login-error" : undefined}
                placeholder="••••••••••••"
                className="pin-input pl-9"
              />
            </div>
          </div>

          {failure ? (
            <div
              id="login-error"
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
              <p className="pin-break text-sm text-destructive">{failure}</p>
            </div>
          ) : null}

          {isError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
              <p className="pin-break text-sm text-destructive">
                Cannot reach the server.{" "}
                {error?.message ?? "Check that the API is running."}
              </p>
            </div>
          ) : null}

          <Button
            type="submit"
            disabled={isSigningIn || password.length === 0 || !authRequired}
            className="pin-btn-primary w-full"
          >
            {isSigningIn ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Attempts are rate limited.
        </p>
      </div>
    </div>
  );
}
