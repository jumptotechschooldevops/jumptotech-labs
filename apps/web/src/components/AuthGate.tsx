/**
 * What the app renders before anybody has signed in — PLATFORM-010.
 *
 * Four states, four honest answers. The one this component exists to avoid is a
 * sign-in button on a deployment that cannot complete a sign-in, and its mirror
 * image: "please sign in" shown when the real problem is that the API is down.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../lib/AuthContext';
import { clearSignInFailure, readSignInFailure, type SignInFailure } from '../lib/auth';

export interface AuthGateProps {
  children: ReactNode;
}

/**
 * What to tell a student the API sent back from a sign-in that did not finish.
 * The private beta admits only invited accounts, and the identity provider is
 * what refuses the rest — so "refused" has to say that, not "try again".
 */
const SIGN_IN_FAILURE_TEXT: Readonly<Record<SignInFailure, string>> = {
  refused:
    'Your sign-in was refused. This beta is open only to invited students: sign in with the account you were invited with, or ask your instructor to add yours.',
  expired: 'That sign-in did not finish — it may have expired or been started in another tab. Sign in again.',
  unavailable: 'Sign-in is unavailable right now: the identity provider could not be reached. Try again in a few minutes.',
  failed: 'Sign-in could not be completed. Sign in again; if it keeps failing, tell your instructor.',
};

export function AuthGate({ children }: AuthGateProps) {
  const auth = useAuth();
  // Read once, then taken out of the address bar: a reload must not repeat it.
  const [signInFailure] = useState(readSignInFailure);
  useEffect(() => clearSignInFailure(), []);

  if (auth.status === 'loading') {
    return (
      <main className="auth-gate" aria-busy="true">
        <p className="auth-gate__status">Checking your session…</p>
      </main>
    );
  }

  if (auth.status === 'unavailable') {
    return (
      <main className="auth-gate">
        <h1 className="auth-gate__title">JumpToTech Labs</h1>
        <p className="auth-gate__status auth-gate__status--error" role="alert">
          Cannot reach the labs API.
        </p>
        {/* The cause, not a guess at it — an operator reads this too. */}
        {auth.error ? <p className="auth-gate__detail">{auth.error}</p> : null}
        <button type="button" className="btn btn--ghost" onClick={() => void auth.refresh()}>
          Try again
        </button>
      </main>
    );
  }

  if (auth.status === 'anonymous') {
    return (
      <main className="auth-gate">
        <h1 className="auth-gate__title">JumpToTech Labs</h1>
        <p className="auth-gate__lede">
          Sign in to start a lab. Every sandbox belongs to one student, and your progress
          follows your account.
        </p>

        {signInFailure ? (
          <p className="auth-gate__status auth-gate__status--error" role="alert">
            {SIGN_IN_FAILURE_TEXT[signInFailure]}
          </p>
        ) : null}

        {auth.signInAvailable ? (
          <button type="button" className="btn btn--primary btn--lg" onClick={() => auth.signIn()}>
            Sign in
          </button>
        ) : (
          /*
           * No identity provider is configured here. Saying so beats a button
           * that leads to a 503, and it names what an operator has to set.
           */
          <div className="auth-gate__unconfigured" role="alert">
            <p>This deployment has no identity provider configured.</p>
            <p className="auth-gate__detail">
              Set <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>,{' '}
              <code>OIDC_CLIENT_SECRET</code> and <code>OIDC_AUDIENCE</code> on the API, or
              run with <code>AUTH_MODE=development</code> for local work.
            </p>
          </div>
        )}
      </main>
    );
  }

  return (
    <>
      {/* Signed in, but the last re-check could not reach the API: say so, keep the lab. */}
      {auth.error ? (
        <div className="notice notice--warning auth-gate__banner" role="status">
          <p className="notice__message">
            Cannot reach the labs API right now. Your lab keeps running; actions that need the
            server may fail until it is back.
          </p>
          <div className="notice__actions">
            <button type="button" className="btn btn--ghost" onClick={() => void auth.refresh()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
}
