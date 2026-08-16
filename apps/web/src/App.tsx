/**
 * Minimal hash routing — the MVP has exactly two views and no router
 * dependency is worth carrying yet.
 *
 *   #/                → catalog
 *   #/labs/K8S-001    → lab workspace
 */
import { useCallback, useEffect, useState } from 'react';
import { CatalogPage } from './pages/CatalogPage';
import { LabPage } from './pages/LabPage';

function labIdFromHash(hash: string): string | null {
  const match = /^#\/labs\/([A-Za-z0-9-]{1,16})$/.exec(hash);
  return match ? match[1]!.toUpperCase() : null;
}

export function App() {
  const [labId, setLabId] = useState<string | null>(() => labIdFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setLabId(labIdFromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const openLab = useCallback((id: string) => {
    window.location.hash = `#/labs/${id}`;
  }, []);

  const goHome = useCallback(() => {
    window.location.hash = '#/';
  }, []);

  return labId ? (
    <LabPage key={labId} labId={labId} onBack={goHome} onOpenLab={openLab} />
  ) : (
    <CatalogPage onOpenLab={openLab} />
  );
}
