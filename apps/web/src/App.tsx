/**
 * The student application.
 *
 * ```text
 *   AuthProvider → AuthGate          who is this (PLATFORM-010); nothing below mounts signed out
 *     CatalogProvider                labs, tracks and progress, loaded once
 *       ActiveSessionProvider        this student's running lab, launch, terminal grants
 *         AppShell                   navigation, active-lab indicator, focus on navigation
 *           <page for the route>
 * ```
 *
 * Providers sit above the routes so that navigating never drops a running
 * lab's state or re-fetches the catalog.
 */
import { lazy, Suspense } from 'react';
import { AppShell } from './components/AppShell';
import { AuthGate } from './components/AuthGate';
import { EmptyState, LoadingState } from './components/ui';
import { ActiveSessionProvider } from './lib/ActiveSessionContext';
import { AuthProvider } from './lib/AuthContext';
import { CatalogProvider } from './lib/CatalogContext';
import { hrefFor, usePageTitle, useRoute, type Route } from './lib/router';
import { CatalogPage } from './pages/CatalogPage';
import { DashboardPage } from './pages/DashboardPage';
import { HelpPage } from './pages/HelpPage';
import { LabDetailPage } from './pages/LabDetailPage';
import { ProgressPage } from './pages/ProgressPage';
import { TrackPage } from './pages/TrackPage';
import { TracksPage } from './pages/TracksPage';

/*
 * The workspace carries the terminal emulator, which is most of the bundle.
 * Loaded on demand, so the dashboard and catalog do not download xterm.js.
 */
const WorkspacePage = lazy(() => import('./pages/WorkspacePage').then((module) => ({ default: module.WorkspacePage })));

function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <div className="page page--narrow">
      <EmptyState
        title="Page not found"
        action={
          <a className="btn btn--primary" href={hrefFor({ name: 'dashboard' })}>
            Go to your dashboard
          </a>
        }
      >
        <p>That address does not match any page in JumpToTech Labs.</p>
      </EmptyState>
    </div>
  );
}

function Page({ route, navigation }: { route: Route; navigation: number }) {
  switch (route.name) {
    case 'dashboard':
      return <DashboardPage />;
    case 'labs': {
      const { name: _name, ...filters } = route;
      // Remount on each navigation so a link to `#/labs` really clears filters.
      return <CatalogPage key={navigation} initialFilters={filters} />;
    }
    case 'lab':
      return <LabDetailPage key={route.labId} labId={route.labId} />;
    case 'workspace':
      return (
        <Suspense fallback={<LoadingState label="Loading the lab workspace…" />}>
          <WorkspacePage key={route.labId} labId={route.labId} />
        </Suspense>
      );
    case 'tracks':
      return <TracksPage />;
    case 'track':
      return <TrackPage key={route.trackId} trackId={route.trackId} />;
    case 'progress':
      return <ProgressPage />;
    case 'help':
      return <HelpPage />;
    case 'notFound':
      return <NotFoundPage />;
  }
}

export function StudentApp() {
  const { route, hash, navigation } = useRoute();
  return (
    <CatalogProvider>
      <ActiveSessionProvider>
        <AppShell route={route} hash={hash} variant={route.name === 'workspace' ? 'workspace' : 'page'}>
          <Page route={route} navigation={navigation} />
        </AppShell>
      </ActiveSessionProvider>
    </CatalogProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <StudentApp />
      </AuthGate>
    </AuthProvider>
  );
}
