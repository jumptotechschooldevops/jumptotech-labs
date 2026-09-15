/**
 * Hash routing for the student app.
 *
 * Still no router dependency: the app has eleven views, every one of them is a
 * pure function of the hash, and the hash survives a reload and a sign-in round
 * trip (`auth.ts` sends `returnTo` with it). What changed from the three-view
 * MVP is only that the routes are named in one place.
 *
 * ```text
 *   #/                         dashboard
 *   #/labs?track=&q=&level=    lab catalog (filters live in the hash)
 *   #/labs/LINUX-001           lab detail — read, then Launch
 *   #/labs/LINUX-001/workspace the running lab: instructions, terminal, verify
 *   #/tracks                   every track
 *   #/tracks/linux             one track, in order
 *   #/paths                    every learning path
 *   #/paths/devops-engineer    one learning path: its stages, in order
 *   #/paths/devops-engineer/stages/linux   one stage: skills, labs, next step
 *   #/progress                 saved progress and attempt history
 *   #/help                     how labs work
 * ```
 *
 * Nothing in a route is a credential. Lab and track ids are public catalog
 * identifiers; a session id never appears in a URL, because the workspace finds
 * the student's session by asking the API whose it is.
 */
import { useEffect, useState } from 'react';

export interface CatalogFilters {
  track?: string;
  q?: string;
  level?: string;
  status?: string;
}

export type Route =
  | { name: 'dashboard' }
  | ({ name: 'labs' } & CatalogFilters)
  | { name: 'lab'; labId: string }
  | { name: 'workspace'; labId: string }
  | { name: 'tracks' }
  | { name: 'track'; trackId: string }
  | { name: 'paths' }
  | { name: 'path'; pathId: string }
  | { name: 'stage'; pathId: string; stageId: string }
  | { name: 'progress' }
  | { name: 'help' }
  | { name: 'notFound' };

const LAB_ID = '([A-Za-z0-9-]{1,16})';
const TRACK_ID = '([a-z0-9][a-z0-9-]{0,31})';
/** Learning path and stage ids — the same shape the API validates. */
const PATH_SLUG = '([a-z0-9][a-z0-9-]{1,47})';
const FILTER_KEYS = ['track', 'q', 'level', 'status'] as const;

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?', 2);
  const path = pathPart.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '') return { name: 'dashboard' };
  if (path === '/labs') {
    const params = new URLSearchParams(queryPart);
    const filters: CatalogFilters = {};
    for (const key of FILTER_KEYS) {
      const value = params.get(key)?.trim().slice(0, 64);
      if (value) filters[key] = value;
    }
    return { name: 'labs', ...filters };
  }
  if (path === '/tracks') return { name: 'tracks' };
  if (path === '/paths') return { name: 'paths' };
  if (path === '/progress') return { name: 'progress' };
  if (path === '/help') return { name: 'help' };

  const workspace = new RegExp(`^/labs/${LAB_ID}/workspace$`).exec(path);
  if (workspace) return { name: 'workspace', labId: workspace[1]!.toUpperCase() };
  const lab = new RegExp(`^/labs/${LAB_ID}$`).exec(path);
  if (lab) return { name: 'lab', labId: lab[1]!.toUpperCase() };
  const track = new RegExp(`^/tracks/${TRACK_ID}$`).exec(path);
  if (track) return { name: 'track', trackId: track[1]! };
  const stage = new RegExp(`^/paths/${PATH_SLUG}/stages/${PATH_SLUG}$`).exec(path);
  if (stage) return { name: 'stage', pathId: stage[1]!, stageId: stage[2]! };
  const learningPath = new RegExp(`^/paths/${PATH_SLUG}$`).exec(path);
  if (learningPath) return { name: 'path', pathId: learningPath[1]! };

  return { name: 'notFound' };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'dashboard':
      return '#/';
    case 'labs': {
      const params = new URLSearchParams();
      for (const key of FILTER_KEYS) {
        const value = route[key];
        if (value) params.set(key, value);
      }
      const query = params.toString();
      return query ? `#/labs?${query}` : '#/labs';
    }
    case 'lab':
      return `#/labs/${encodeURIComponent(route.labId)}`;
    case 'workspace':
      return `#/labs/${encodeURIComponent(route.labId)}/workspace`;
    case 'tracks':
      return '#/tracks';
    case 'track':
      return `#/tracks/${encodeURIComponent(route.trackId)}`;
    case 'paths':
      return '#/paths';
    case 'path':
      return `#/paths/${encodeURIComponent(route.pathId)}`;
    case 'stage':
      return `#/paths/${encodeURIComponent(route.pathId)}/stages/${encodeURIComponent(route.stageId)}`;
    case 'progress':
      return '#/progress';
    case 'help':
      return '#/help';
    case 'notFound':
      return '#/';
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}

/**
 * Rewrite the hash without adding a history entry or re-routing.
 *
 * For catalog filters: typing a search should not make Back step through every
 * keystroke, and the page that is already showing those filters must not be
 * remounted by its own URL update. `replaceState` fires no `hashchange`.
 */
export function replaceRoute(route: Route): void {
  const next = hrefFor(route);
  if (window.location.hash === next) return;
  window.history.replaceState(window.history.state, '', next);
}

/**
 * The current route, following the hash.
 *
 * `navigation` counts hash changes. It moves even when the new hash equals the
 * last one this hook saw — which happens after `replaceRoute` rewrote the URL
 * silently and the student then clicks a link back to the plain page.
 */
export function useRoute(): { route: Route; hash: string; navigation: number } {
  const [state, setState] = useState(() => ({ hash: window.location.hash, navigation: 0 }));

  useEffect(() => {
    const onChange = () =>
      setState((current) => ({ hash: window.location.hash, navigation: current.navigation + 1 }));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return { route: parseRoute(state.hash), hash: state.hash, navigation: state.navigation };
}

/** Set the document title for the page being shown. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · JumpToTech Labs` : 'JumpToTech Labs';
  }, [title]);
}
