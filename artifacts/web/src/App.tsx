import { Switch, Route, Router as WouterRouter } from "wouter";
import { useEffect } from "react";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  MutationCache,
} from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Logo } from "@/components/logo";

// Pages
import Dashboard from "@/pages/dashboard";
import Messages from "@/pages/messages";
import InboxPage from "@/pages/inbox";
import Accounts from "@/pages/accounts";
import Hostinger from "@/pages/hostinger";
import Settings from "@/pages/settings";
import Login from "@/pages/login";

/**
 * A session can expire while the tab is open, or be invalidated by a password
 * change. Any 401 therefore means "the gate closed"; re-read the session so the
 * app swaps itself for the login screen instead of showing a wall of failed
 * requests.
 */
function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 401
  );
}

let onUnauthorized: () => void = () => undefined;

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) onUnauthorized();
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isUnauthorized(error)) onUnauthorized();
    },
  }),
  defaultOptions: {
    queries: {
      // Reads are cheap and the backend mutates data on its own schedule, so
      // keep data briefly fresh but always revalidate on remount.
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) =>
        // Retrying a 401 cannot succeed and only delays the login screen.
        !isUnauthorized(error) && failureCount < 1,
    },
    mutations: {
      // Mutations are not idempotent (scan, forward, delete): never auto-retry.
      retry: 0,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/messages" component={Messages} />
        <Route path="/inbox" component={InboxPage} />
        <Route path="/accounts" component={Accounts} />
        <Route path="/hostinger" component={Hostinger} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

/**
 * Decides between the login screen and the app.
 *
 * The app tree is not rendered at all until the session resolves as valid, so an
 * unauthenticated visitor never mounts a component that would request mailbox
 * data. The server enforces this independently; this only avoids a flash of
 * empty UI and a burst of doomed requests.
 */
function AuthGate() {
  const { authenticated, isLoading, refresh } = useAuth();

  useEffect(() => {
    onUnauthorized = () => {
      void refresh();
    };
    return () => {
      onUnauthorized = () => undefined;
    };
  }, [refresh]);

  if (isLoading || authenticated === undefined) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background">
        <Logo className="h-12 w-12" />
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Checking session</span>
      </div>
    );
  }

  return authenticated ? <Router /> : <Login />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthGate />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
