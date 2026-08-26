/**
 * Minimal hash routing — the MVP has three views and no router dependency is
 * worth carrying yet.
 *
 *   #/                → catalog
 *   #/progress        → the student's saved progress
 *   #/labs/K8S-001    → lab workspace
 */
import { useCallback, useEffect, useState } from 'react';
import { AuthGate } from './components/AuthGate';
import { AuthProvider } from './lib/AuthContext';
import { CatalogPage } from './pages/CatalogPage';
import { LabPage } from './pages/LabPage';
import { ProgressPage } from './pages/ProgressPage';

type Route = { view: 'catalog' } | { view: 'progress' } | { view: 'lab'; labId: string };

function routeFromHash(hash: string): Route {
  const lab = /^#\/labs\/([A-Za-z0-9-]{1,16})$/.exec(hash);
  if (lab) return { view: 'lab', labId: lab[1]!.toUpperCase() };
  if (/^#\/progress\/?$/.test(hash)) return { view: 'progress' };
  return { view: 'catalog' };
}

/**
 * The signed-in application.
 *
 * Split from `App` so the gate can decide whether to mount it at all: an
 * unauthenticated browser never renders a catalog, never fires a lab request,
 * and never gets a 401 it has to explain away.
 */
function AuthenticatedApp() {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const openLab = useCallback((id: string) => {
    window.location.hash = `#/labs/${id}`;
  }, []);

  const goHome = useCallback(() => {
    window.location.hash = '#/';
  }, []);

  const openProgress = useCallback(() => {
    window.location.hash = '#/progress';
  }, []);

  if (route.view === 'lab') {
    return (
      <LabPage key={route.labId} labId={route.labId} onBack={goHome} onOpenLab={openLab} />
    );
  }
  if (route.view === 'progress') {
    return <ProgressPage onBack={goHome} onOpenLab={openLab} />;
  }
  return <CatalogPage onOpenLab={openLab} onOpenProgress={openProgress} />;
}

/**
 * Identity first, then everything else — PLATFORM-010.
 *
 * `AuthProvider` owns the answer to "who is this", `AuthGate` decides whether
 * the app is mounted, and no page below has to think about it.
 */
export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <AuthenticatedApp />
      </AuthGate>
    </AuthProvider>
  );
}
