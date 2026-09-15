/**
 * Render a page the way the application renders it.
 *
 * Every signed-in page runs inside the auth, catalog and active-session
 * providers, so a test that renders one without them is not testing the
 * shipped component. To mount the whole routed app, use `routed-app.tsx`.
 */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { ActiveSessionProvider } from '../src/lib/ActiveSessionContext';
import { AuthProvider } from '../src/lib/AuthContext';
import { CatalogProvider } from '../src/lib/CatalogContext';
import { TEST_SESSION } from './auth-harness';

function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider
      loadSession={() => Promise.resolve(TEST_SESSION)}
      signOutImpl={() => Promise.resolve({ signedOut: true })}
      signInImpl={() => undefined}
    >
      <CatalogProvider>
        <ActiveSessionProvider>{children}</ActiveSessionProvider>
      </CatalogProvider>
    </AuthProvider>
  );
}

export function renderWithProviders(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: Providers });
}
