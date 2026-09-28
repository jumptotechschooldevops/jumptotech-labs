/**
 * Authentication state for the app — PLATFORM-010.
 *
 * One provider, one hook, one source of truth: the API. The state here is a
 * *cache* of `GET /auth/session`, refreshed on load, when the tab regains
 * focus, and whenever anything reports a 401. It is never authoritative — the
 * server decides, and every route re-decides on every request.
 *
 * ```text
 *   'loading'        first query in flight
 *   'authenticated'  identity in hand
 *   'anonymous'      nobody signed in (a normal state, not an error)
 *   'unavailable'    the API could not be reached
 * ```
 *
 * `unavailable` is separate from `anonymous` on purpose. Rendering "please sign
 * in" when the API is simply down sends the user round a loop that cannot
 * succeed, and hides an outage behind what looks like a permissions problem.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AUTH_EXPIRED_EVENT,
  fetchAuthSession,
  signIn as startSignIn,
  signOut as endSession,
  takeSignInFailure,
  type AuthIdentity,
  type AuthSession,
  type SignInFailure,
} from './auth';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unavailable';

export interface AuthState {
  status: AuthStatus;
  identity: AuthIdentity | null;
  /** False when this deployment has no identity provider configured. */
  signInAvailable: boolean;
  mode: 'oidc' | 'development';
  /** Set when the last refresh failed to reach the API. */
  error: string | null;
  /**
   * True when this tab was signed in and a re-check found it no longer is —
   * the sign-in expired or was ended elsewhere. Not set by Sign out, and not on
   * a first visit: both are ordinary signed-out states.
   */
  expired: boolean;
  /** Why the sign-in this browser just came back from did not complete. */
  signInFailure: SignInFailure | null;
  refresh: () => Promise<void>;
  signIn: (returnTo?: string) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Injected by tests so they never touch the network. */
  loadSession?: () => Promise<AuthSession>;
  signOutImpl?: () => Promise<{ signedOut: boolean; endSessionUrl?: string }>;
  signInImpl?: (returnTo?: string) => void;
}

export function AuthProvider({
  children,
  loadSession = fetchAuthSession,
  signOutImpl = endSession,
  signInImpl = startSignIn,
}: AuthProviderProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  /** The status as last rendered, so a refresh can tell "signed out" from "no longer signed in". */
  const statusRef = useRef<AuthStatus>(status);
  statusRef.current = status;
  const [signInFailure, setSignInFailure] = useState<SignInFailure | null>(() => takeSignInFailure());
  /** Guards against a late response from a superseded refresh overwriting a newer one. */
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await loadSession();
      if (generation.current !== mine) return;
      setSession(next);
      if (next.authenticated) setExpired(false);
      else if (statusRef.current === 'authenticated') setExpired(true);
      setStatus(next.authenticated ? 'authenticated' : 'anonymous');
      setError(null);
    } catch (cause) {
      if (generation.current !== mine) return;
      setError(cause instanceof Error ? cause.message : 'Could not reach the API.');
      /*
       * A failed *re*-check is not a sign-out.
       *
       * This runs again whenever the tab becomes visible and after any 401. If
       * the API is restarting at that moment (`prod up -d api` changes the
       * capacity ceiling during a class), unmounting the app would close the
       * student's terminal socket and throw away a workspace that does not
       * depend on the API while it is open. So a signed-in browser stays
       * mounted, with the error shown by the gate as a banner; only a definite
       * "signed out" answer takes the app away. Nothing is granted by staying
       * mounted: every request is still authenticated by the server.
       */
      setStatus((current) => (current === 'authenticated' ? 'authenticated' : 'unavailable'));
      setSession((current) => (current?.authenticated ? current : null));
    }
  }, [loadSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * Anything that saw a 401 asks for a re-check.
   *
   * The alternative — each caller deciding for itself that the user is signed
   * out — produces a UI where one panel says signed in and another says signed
   * out. One listener, one answer, from the server.
   */
  useEffect(() => {
    const onExpired = () => {
      void refresh();
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [refresh]);

  /*
   * Re-check when the tab comes back.
   *
   * A browser session can expire, or be signed out in another tab, while this
   * one sits idle. Without this the user finds out by having an action fail.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const signOut = useCallback(async () => {
    let result: { signedOut: boolean; endSessionUrl?: string };
    try {
      result = await signOutImpl();
    } catch {
      // The local cookie may or may not be gone. Re-querying the server is the
      // only honest way to find out, and it is what `refresh` does.
      await refresh();
      return;
    }

    // A re-check still in flight was answered while signed in; landing after
    // this it would put the signed-in app back.
    generation.current += 1;
    setSession((current) => (current ? { ...current, authenticated: false } : current));
    setStatus('anonymous');
    setExpired(false);

    /*
     * Forget where this student was. Sign-in returns to the current address, so
     * on a shared computer the next student would otherwise land on the page the
     * last one left — their lab's workspace, their learning stage. An expired
     * sign-in keeps its place on purpose: the same student signs back in.
     */
    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }

    /*
     * Complete the provider's single logout when it publishes one.
     *
     * The platform session is already destroyed server-side by this point, so
     * this is about not leaving the user silently signed in *at the provider* —
     * where the next sign-in would skip the password prompt and look, to them,
     * like sign-out did not work.
     */
    if (result.endSessionUrl && typeof window !== 'undefined') {
      window.location.assign(result.endSessionUrl);
    }
  }, [signOutImpl, refresh]);

  const signIn = useCallback(
    (returnTo?: string) => {
      setSignInFailure(null);
      signInImpl(returnTo);
    },
    [signInImpl],
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      identity: session?.identity ?? null,
      signInAvailable: session?.signInAvailable ?? false,
      mode: session?.mode ?? 'oidc',
      error,
      expired,
      signInFailure,
      refresh,
      signIn,
      signOut,
    }),
    [status, session, error, expired, signInFailure, refresh, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an AuthProvider');
  return value;
}
