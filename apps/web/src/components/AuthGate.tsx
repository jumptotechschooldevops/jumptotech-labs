/**
 * What the app renders before anybody has signed in — PLATFORM-010.
 *
 * Four states, four honest answers. The one this component exists to avoid is a
 * sign-in button on a deployment that cannot complete a sign-in, and its mirror
 * image: "please sign in" shown when the real problem is that the API is down.
 */
import { Fragment, type ReactNode } from 'react';
import type { SignInFailure } from '../lib/auth';
import { useAuth } from '../lib/AuthContext';

const SIGN_IN_FAILURE_TEXT: Record<SignInFailure, { title: string; message: string }> = {
  cancelled: {
    title: 'Sign-in was cancelled',
    message: 'You are not signed in. Press Sign in when you are ready to try again.',
  },
  expired: {
    title: 'That sign-in did not finish',
    message:
      'It was left open too long, or it was started again in another tab or window. Press Sign in to start a fresh one.',
  },
  unavailable: {
    title: 'Sign-in is unavailable right now',
    message:
      'The sign-in service could not be reached. Wait a minute, then press Sign in again. If it keeps happening, let your instructor know.',
  },
  failed: {
    title: 'Sign-in did not complete',
    message: 'Press Sign in to try again. If it keeps happening, let your instructor know.',
  },
};

/** A sign-in the student just came back from without being signed in: say what happened. */
function SignInFailureNotice({ reason }: { reason: SignInFailure }) {
  const text = SIGN_IN_FAILURE_TEXT[reason];
  return (
    <div className="notice notice--warning auth-gate__notice" role="alert">
      <p className="notice__title">{text.title}</p>
      <p className="notice__message">{text.message}</p>
    </div>
  );
}

export interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const auth = useAuth();

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
        <p className="auth-gate__lede">
          Check your internet connection, then press Try again. If the platform is restarting, this can take a
          minute. A lab you have running is not affected.
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
        {auth.signInFailure ? <SignInFailureNotice reason={auth.signInFailure} /> : null}
        {auth.expired ? (
          /*
           * The student was working a moment ago and every page just vanished.
           * Say why, and that nothing they did was lost; the generic welcome
           * below reads as if they had never signed in.
           */
          <div className="notice notice--warning auth-gate__expired" role="alert">
            <p className="notice__title">Your sign-in has expired</p>
            <p className="notice__message">
              Sign in again to carry on where you were. Your saved progress is not affected, and a lab you had
              running keeps running until it times out.
            </p>
          </div>
        ) : (
          <p className="auth-gate__lede">
            Sign in to start a lab. Every sandbox belongs to one student, and your progress
            follows your account.
          </p>
        )}

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

  /*
   * The app below belongs to one student. Keyed by who that is, so a re-check
   * that answers "signed in" as somebody else — a shared computer, another tab
   * signed in as a different student — starts it afresh instead of keeping the
   * previous student's sessions, terminal grants, open terminal and progress.
   * The same student keeps everything (the key does not change).
   */
  const who = auth.identity ? `${auth.identity.issuer}|${auth.identity.subject}` : 'unknown';

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
      <Fragment key={who}>{children}</Fragment>
    </>
  );
}
