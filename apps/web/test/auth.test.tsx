/**
 * PLATFORM-010 — what the browser does about authentication.
 *
 * Three properties, in order of how much they matter:
 *
 *   1. **Nothing is stored.** No token, no identifier, no session value in
 *      `localStorage` or `sessionStorage`. The session is an HttpOnly cookie
 *      the page cannot read, and auth state in React is a cache of a server
 *      answer.
 *   2. **The four states are distinguished.** "Signed out", "the API is down",
 *      and "no identity provider is configured" are different problems with
 *      different remedies, and conflating them sends a user round a loop that
 *      cannot succeed.
 *   3. **A 401 re-queries the server** rather than each caller deciding for
 *      itself what one meant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthGate } from '../src/components/AuthGate';
import { UserMenu } from '../src/components/UserMenu';
import { AuthProvider, useAuth } from '../src/lib/AuthContext';
import { AUTH_EXPIRED_EVENT, announceAuthExpired, type AuthSession } from '../src/lib/auth';

const SIGNED_IN: AuthSession = {
  authenticated: true,
  signInAvailable: true,
  mode: 'oidc',
  identity: {
    subject: 'auth0|alice',
    issuer: 'https://issuer.test/',
    email: 'alice@example.test',
    displayName: 'Alice Example',
    role: 'STUDENT',
    source: 'oidc',
  },
};

const SIGNED_OUT: AuthSession = { authenticated: false, signInAvailable: true, mode: 'oidc' };

function renderGate(options: {
  loadSession: () => Promise<AuthSession>;
  signInImpl?: (returnTo?: string) => void;
  signOutImpl?: () => Promise<{ signedOut: boolean; endSessionUrl?: string }>;
}) {
  return render(
    <AuthProvider
      loadSession={options.loadSession}
      signInImpl={options.signInImpl ?? (() => undefined)}
      signOutImpl={options.signOutImpl ?? (() => Promise.resolve({ signedOut: true }))}
    >
      <AuthGate>
        <div>the catalog</div>
        <UserMenu />
      </AuthGate>
    </AuthProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------ the states

describe('the sign-in gate', () => {
  it('shows the app to a signed-in student', async () => {
    renderGate({ loadSession: () => Promise.resolve(SIGNED_IN) });

    expect(await screen.findByText('the catalog')).toBeTruthy();
    expect(screen.getByText('Alice Example')).toBeTruthy();
  });

  it('offers sign-in, and renders nothing of the app, when signed out', async () => {
    renderGate({ loadSession: () => Promise.resolve(SIGNED_OUT) });

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    // The app is not merely hidden — it never mounted, so it fired no request
    // that would have come back 401.
    expect(screen.queryByText('the catalog')).toBeNull();
  });

  it('says the API is unreachable rather than asking for a sign-in that cannot work', async () => {
    renderGate({ loadSession: () => Promise.reject(new Error('Cannot reach the API.')) });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Cannot reach the labs API/)).toBeTruthy();
    // Crucially not a sign-in button: the problem is not that nobody signed in.
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('names the missing configuration when no identity provider is set up', async () => {
    renderGate({
      loadSession: () => Promise.resolve({ ...SIGNED_OUT, signInAvailable: false }),
    });

    await screen.findByRole('alert');
    expect(screen.getByText(/no identity provider configured/i)).toBeTruthy();
    // A button that leads to a 503 is worse than no button.
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText('OIDC_CLIENT_SECRET')).toBeTruthy();
  });

  it('retries when asked, and mounts the app once the API answers', async () => {
    let attempt = 0;
    renderGate({
      loadSession: () => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('down')) : Promise.resolve(SIGNED_IN);
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('the catalog')).toBeTruthy();
  });
});

// ------------------------------------------------------------- sign in/out

describe('signing in and out', () => {
  it('starts sign-in by navigating, not by fetching', async () => {
    const signInImpl = vi.fn();
    renderGate({ loadSession: () => Promise.resolve(SIGNED_OUT), signInImpl });

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

    // A fetch would follow the provider's redirect in the background and land
    // its HTML in a JavaScript string. Sign-in belongs in the address bar.
    expect(signInImpl).toHaveBeenCalledTimes(1);
  });

  it('signs out and falls back to the signed-out view', async () => {
    const signOutImpl = vi.fn().mockResolvedValue({ signedOut: true });
    renderGate({ loadSession: () => Promise.resolve(SIGNED_IN), signOutImpl });

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOutImpl).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('the catalog')).toBeNull();
  });

  it('re-enables the button when sign-out fails, so it can be retried', async () => {
    const signOutImpl = vi.fn().mockRejectedValue(new Error('network'));
    renderGate({ loadSession: () => Promise.resolve(SIGNED_IN), signOutImpl });

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

// ------------------------------------------------------------- expiry path

describe('an expired session', () => {
  it('re-queries the server when anything reports a 401', async () => {
    let signedIn = true;
    const loadSession = vi.fn(() => Promise.resolve(signedIn ? SIGNED_IN : SIGNED_OUT));
    renderGate({ loadSession });

    expect(await screen.findByText('the catalog')).toBeTruthy();

    // The API client dispatches this on any 401. The provider is the single
    // listener, so every part of the UI reaches the same conclusion at once
    // rather than each deciding for itself.
    signedIn = false;
    announceAuthExpired();

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(loadSession).toHaveBeenCalledTimes(2);
  });

  it('dispatches exactly one event per announcement', () => {
    const listener = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, listener);
    announceAuthExpired();
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------- storage rule

describe('nothing sensitive is stored in the browser', () => {
  it('writes nothing to localStorage or sessionStorage', async () => {
    const localSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderGate({ loadSession: () => Promise.resolve(SIGNED_IN) });
    await screen.findByText('the catalog');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Sign in' });

    /*
     * The whole argument for the backend-for-frontend design is that there is
     * nothing in the page for a script to steal. A `setItem` anywhere in the
     * auth path would quietly undo it.
     */
    expect(localSpy).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('never renders the internal user id, because it never receives one', async () => {
    renderGate({ loadSession: () => Promise.resolve(SIGNED_IN) });
    await screen.findByText('the catalog');

    expect(document.body.innerHTML).not.toMatch(/userId/i);
  });
});

// ------------------------------------------------------------ the contract

describe('useAuth', () => {
  it('refuses to be used outside a provider', () => {
    function Orphan() {
      useAuth();
      return null;
    }
    // Loud rather than a silently empty state: a page rendered without the
    // provider is not the page that ships.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Orphan />)).toThrow(/must be used inside an AuthProvider/);
  });
});

// --------------------------------------------------------------- user menu

describe('the user menu', () => {
  it('labels a development identity as one', async () => {
    renderGate({
      loadSession: () =>
        Promise.resolve({
          ...SIGNED_IN,
          mode: 'development',
          identity: { ...SIGNED_IN.identity!, source: 'development' },
        }),
    });

    expect(await screen.findByText('DEV IDENTITY')).toBeTruthy();
  });

  it('shows a role badge only when it is not the ordinary one', async () => {
    renderGate({ loadSession: () => Promise.resolve(SIGNED_IN) });
    await screen.findByText('the catalog');
    // A badge that is always there stops being read.
    expect(screen.queryByText('STUDENT')).toBeNull();

    screen.getByText('Alice Example');
  });

  it('shows an instructor their role', async () => {
    renderGate({
      loadSession: () =>
        Promise.resolve({ ...SIGNED_IN, identity: { ...SIGNED_IN.identity!, role: 'INSTRUCTOR' } }),
    });

    expect(await screen.findByText('INSTRUCTOR')).toBeTruthy();
  });

  it('falls back to the email, then the subject, for a nameless identity', async () => {
    renderGate({
      loadSession: () =>
        Promise.resolve({
          ...SIGNED_IN,
          identity: { ...SIGNED_IN.identity!, displayName: undefined },
        }),
    });

    expect(await screen.findByText('alice@example.test')).toBeTruthy();
  });
});
