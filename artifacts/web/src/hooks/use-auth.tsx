import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  useLogin,
  useLogout,
} from "@workspace/api-client-react";

interface AuthContextValue {
  /** Undefined while the session is still being resolved. */
  authenticated: boolean | undefined;
  /** False when the server has no password configured. */
  authRequired: boolean;
  isLoading: boolean;
  /** True when the session check itself failed (server down, network error). */
  isError: boolean;
  error: Error | null;
  signIn: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  isSigningIn: boolean;
  /** Re-read the session, e.g. after a 401 from another request. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const session = useGetAuthSession({
    query: {
      queryKey: getGetAuthSessionQueryKey(),
      // The session is the gate for everything else, so never serve a stale
      // answer from cache on mount.
      staleTime: 0,
      // A 401 here is impossible by contract, so a retry would only delay the
      // login screen when the server is down.
      retry: false,
    },
  });

  const login = useLogin();
  const logout = useLogout();

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: getGetAuthSessionQueryKey(),
    });
  }, [queryClient]);

  const signIn = useCallback(
    async (password: string) => {
      await login.mutateAsync({ data: { password } });
      // Everything cached before sign-in was fetched without a session, so drop
      // it rather than showing empty lists from failed requests.
      queryClient.clear();
      await refresh();
    },
    [login, queryClient, refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await logout.mutateAsync();
    } finally {
      // Clear local data even if the request failed: the intent was to stop
      // showing mailbox contents on this screen.
      queryClient.clear();
      await refresh();
    }
  }, [logout, queryClient, refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      authenticated: session.data?.authenticated,
      authRequired: session.data?.authRequired ?? true,
      isLoading: session.isLoading,
      isError: session.isError,
      error: session.error ?? null,
      signIn,
      signOut,
      isSigningIn: login.isPending,
      refresh,
    }),
    [
      session.data,
      session.isLoading,
      session.isError,
      session.error,
      signIn,
      signOut,
      login.isPending,
      refresh,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
