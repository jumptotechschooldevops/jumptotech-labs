/**
 * The last line against a blank screen.
 *
 * Pre-merge validation fed the workspace a verification payload it did not
 * expect, and the render exception unmounted the whole app — navigation,
 * active-lab link and all — leaving the student an empty page. The specific
 * payload is now rejected where it arrives; this boundary makes sure the next
 * unforeseen one costs a page, not the application.
 *
 * It wraps the routed page only, inside the app shell, so the navigation stays
 * usable. The caller keys it by route, so moving to another page clears it.
 * It stores and sends nothing; React already reports the error to the console.
 */
import { Component, type ReactNode } from 'react';
import { hrefFor } from '../lib/router';

export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page page--narrow">
        <div className="notice notice--danger" role="alert">
          <h1 className="notice__title">This page could not be shown</h1>
          <p className="notice__message">
            Something on this page failed to display. A running lab keeps running, and your saved progress is not
            affected.
          </p>
          <div className="notice__actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload the page
            </button>
            <a className="btn btn--secondary" href={hrefFor({ name: 'dashboard' })}>
              Go to your dashboard
            </a>
          </div>
        </div>
      </div>
    );
  }
}
