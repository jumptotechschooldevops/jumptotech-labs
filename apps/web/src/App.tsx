/**
 * Minimal hash routing — the MVP has three views and no router dependency is
 * worth carrying yet.
 *
 *   #/                → catalog
 *   #/progress        → the student's saved progress
 *   #/labs/K8S-001    → lab workspace
 */
import { useCallback, useEffect, useState } from 'react';
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

export function App() {
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
