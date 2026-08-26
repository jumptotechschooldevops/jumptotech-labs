/**
 * Who you are signed in as, and how to stop being — PLATFORM-010.
 *
 * Renders nothing when nobody is signed in, so a page can place it
 * unconditionally in its header without every caller repeating the check.
 *
 * The role badge is shown only for INSTRUCTOR and ADMIN. Labelling the common
 * case "STUDENT" adds nothing a student needs, and a badge that is always there
 * stops being read.
 */
import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { displayNameFor } from '../lib/auth';

export function UserMenu() {
  const auth = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  if (auth.status !== 'authenticated' || !auth.identity) return null;

  const identity = auth.identity;
  const name = displayNameFor(identity);

  return (
    <div className="user-menu">
      <span className="user-menu__identity" title={identity.email ?? identity.subject}>
        {name}
      </span>

      {identity.role !== 'STUDENT' ? (
        <span className="user-menu__role">{identity.role}</span>
      ) : null}

      {/*
        A development identity is labelled as one, in the UI, permanently.
        The API refuses to run this mode in production — but a developer
        looking at a screenshot should never have to guess which mode it was.
      */}
      {identity.source === 'development' ? (
        <span className="user-menu__role user-menu__role--dev" title="Nobody proved this identity">
          DEV IDENTITY
        </span>
      ) : null}

      <button
        type="button"
        className="btn btn--ghost btn--small"
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          // `finally` rather than `then`: a failed sign-out must not leave the
          // button disabled forever with no way to retry.
          void auth.signOut().finally(() => setSigningOut(false));
        }}
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
