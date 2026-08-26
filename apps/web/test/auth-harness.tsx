/**
 * Rendering a page the way the application actually renders it — PLATFORM-010.
 *
 * Every page below the gate runs inside an `AuthProvider`, so a test that
 * renders one without a provider is not testing the shipped component. This
 * wraps it, with an injected session so no test touches the network.
 *
 * The default identity is a signed-in student, because that is the only state
 * in which these pages are mounted at all — `AuthGate` does not render them for
 * anyone else. Tests that care about a different state pass one.
 */
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { AuthProvider } from '../src/lib/AuthContext';
import type { AuthSession } from '../src/lib/auth';

export const TEST_SESSION: AuthSession = {
  authenticated: true,
  signInAvailable: true,
  mode: 'oidc',
  identity: {
    subject: 'auth0|test-student',
    issuer: 'https://issuer.test/',
    email: 'student@example.test',
    displayName: 'Test Student',
    role: 'STUDENT',
    source: 'oidc',
  },
};

export interface RenderWithAuthOptions extends Omit<RenderOptions, 'wrapper'> {
  session?: AuthSession;
}

export function renderWithAuth(
  ui: ReactElement,
  options: RenderWithAuthOptions = {},
): RenderResult {
  const { session = TEST_SESSION, ...rest } = options;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider
      loadSession={() => Promise.resolve(session)}
      // Neither is reachable from these tests; supplied so a stray call cannot
      // navigate the jsdom window or hit the network.
      signOutImpl={() => Promise.resolve({ signedOut: true })}
      signInImpl={() => undefined}
    >
      {children}
    </AuthProvider>
  );
  return render(ui, { wrapper, ...rest });
}
