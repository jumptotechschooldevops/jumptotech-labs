/**
 * The frame around every signed-in page.
 *
 * Answers the three questions a student should never have to hunt for:
 *
 *   - **Where am I?** — the current section is marked (`aria-current="page"`),
 *     and every page sets the document title.
 *   - **Is a lab running?** — an indicator, from the API's own list of this
 *     student's sessions, that links straight back into it.
 *   - **How do I get back?** — six plain links, the same on every page.
 *
 * The navigation is deliberately short. Every item is a page with real content;
 * there is nothing here for appearance.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useActiveSession } from '../lib/ActiveSessionContext';
import { sessionStatusText } from '../lib/format';
import { FLAGSHIP_PATH_ID } from '../lib/learningPath';
import { hrefFor, type Route } from '../lib/router';
import { UserMenu } from './UserMenu';

const NAV: Array<{ label: string; route: Route; matches: Route['name'][] }> = [
  { label: 'Dashboard', route: { name: 'dashboard' }, matches: ['dashboard'] },
  { label: 'Learning Path', route: { name: 'path', pathId: FLAGSHIP_PATH_ID }, matches: ['paths', 'path', 'stage'] },
  { label: 'Labs', route: { name: 'labs' }, matches: ['labs', 'lab'] },
  { label: 'Tracks', route: { name: 'tracks' }, matches: ['tracks', 'track'] },
  { label: 'Progress', route: { name: 'progress' }, matches: ['progress'] },
  { label: 'Help', route: { name: 'help' }, matches: ['help'] },
];

function ActiveLabIndicator({ route }: { route: Route }) {
  const { entries, launching } = useActiveSession();

  if (launching) {
    const inWorkspace = route.name === 'workspace' && route.labId === launching.labId;
    return (
      <a
        className="active-lab active-lab--pending"
        href={hrefFor({ name: 'workspace', labId: launching.labId })}
        aria-current={inWorkspace ? 'page' : undefined}
      >
        <span className="active-lab__dot" aria-hidden="true" />
        <span className="active-lab__text">Starting {launching.labId}…</span>
      </a>
    );
  }

  const entry = entries[0];
  if (!entry) return null;

  const { session } = entry;
  const inWorkspace = route.name === 'workspace' && route.labId === session.labId;
  const status = sessionStatusText(session.status);
  return (
    <a
      className={`active-lab active-lab--${session.status.toLowerCase()}`}
      href={hrefFor({ name: 'workspace', labId: session.labId })}
      aria-current={inWorkspace ? 'page' : undefined}
      title={`${entry.labTitle} — ${status.label}`}
    >
      <span className="active-lab__dot" aria-hidden="true" />
      <span className="active-lab__text">
        <span className="active-lab__label">Active lab</span>{' '}
        <span className="active-lab__id">{session.labId}</span>
        <span className="visually-hidden">, {status.label}</span>
      </span>
    </a>
  );
}

export function AppShell({
  route,
  hash,
  variant = 'page',
  children,
}: {
  route: Route;
  /** The raw hash, so focus moves on every navigation, including filter-less ones. */
  hash: string;
  variant?: 'page' | 'workspace';
  children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement | null>(null);
  const firstRender = useRef(true);

  /*
   * Move focus to the new page on navigation.
   *
   * A hash change swaps the whole page, but a screen reader's focus would stay
   * on the link that was activated — now describing a page that is gone.
   * Skipped on first render so a fresh load starts at the top as usual.
   */
  const pathKey = hash.split('?')[0];
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    document.documentElement.scrollTop = 0;
  }, [pathKey]);

  return (
    <div className={`app app--${variant}`}>
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        mainRef.current?.focus();
      }}>
        Skip to content
      </a>
      <header className="appbar">
        <a className="appbar__brand" href={hrefFor({ name: 'dashboard' })}>
          <span className="appbar__logo" aria-hidden="true">◆</span>
          <span>
            JumpToTech <span className="appbar__brand-light">Labs</span>
          </span>
        </a>

        <nav className="appbar__nav" aria-label="Main">
          <ul>
            {NAV.map((item) => (
              <li key={item.label}>
                <a
                  href={hrefFor(item.route)}
                  className="appbar__link"
                  aria-current={item.matches.includes(route.name) ? 'page' : undefined}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="appbar__right">
          <ActiveLabIndicator route={route} />
          <UserMenu />
        </div>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className={`app__main app__main--${variant}`}>
        {children}
      </main>
    </div>
  );
}
