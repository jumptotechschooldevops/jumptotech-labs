/**
 * Mount the whole routed student app at a given hash.
 *
 * Separate from `app-harness.tsx` because the routed app imports the workspace,
 * and with it the terminal emulator; tests that use this mock `LabTerminal`.
 */
import { render, type RenderResult } from '@testing-library/react';
import { StudentApp } from '../src/App';
import { AuthProvider } from '../src/lib/AuthContext';
import { TEST_SESSION } from './auth-harness';

export function renderApp(hash = '#/'): RenderResult {
  window.history.replaceState(null, '', `/${hash}`);
  return render(
    <AuthProvider
      loadSession={() => Promise.resolve(TEST_SESSION)}
      signOutImpl={() => Promise.resolve({ signedOut: true })}
      signInImpl={() => undefined}
    >
      <StudentApp />
    </AuthProvider>,
  );
}

/** Follow a hash link the way a browser would: change the hash, fire hashchange. */
export function go(hash: string): void {
  window.history.replaceState(null, '', `/${hash}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
