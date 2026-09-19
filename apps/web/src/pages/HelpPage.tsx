/**
 * How labs work, and what to do when something goes wrong.
 *
 * Informational only. Every statement describes current platform behaviour
 * (see docs/student-experience.md for the source of each), and nothing here
 * promises a time, a capacity or a certification.
 */
import { hrefFor, usePageTitle } from '../lib/router';
import { PageHeader } from '../components/ui';

const PROBLEMS: Array<{ title: string; body: string }> = [
  {
    title: 'All lab environments are in use',
    body: 'The platform runs a limited number of environments at once. One frees up whenever another student ends a lab or goes idle. Wait a few minutes and launch again.',
  },
  {
    title: 'You already have a lab running',
    body: 'In this beta each student can run one lab at a time. Use Active lab in the top bar (or Continue lab on your dashboard) to return to it. End it from its workspace before launching a different lab.',
  },
  {
    title: 'The terminal disconnected',
    body: 'Press Reconnect in the terminal bar. If your environment is still running, you get a new shell in the same environment — your files are still there. If it ended, the workspace says so.',
  },
  {
    title: 'Verification could not run',
    body: 'This means the platform could not read your environment, so nothing was checked and nothing was recorded. It is not a mistake in your work. Try Verify again in a moment.',
  },
  {
    title: 'The reset did not finish',
    body: 'The environment cannot be used as it is. Press Reset again, or End lab to release it and launch a fresh one.',
  },
  {
    title: 'Your sign-in expired',
    body: 'Sign in again. A running lab keeps running while you do, until it goes idle or reaches its time limit.',
  },
];

export function HelpPage() {
  usePageTitle('Help');

  return (
    <div className="page page--narrow">
      <PageHeader
        eyebrow="Help"
        title="How JumpToTech Labs works"
        description="Every lab gives you a real, temporary environment and checks your work against its actual state."
      />

      <section className="prose" aria-labelledby="help-flow">
        <h2 id="help-flow">A lab, step by step</h2>
        <dl className="definition-list">
          <div>
            <dt>Launch</dt>
            <dd>
              Creates a private environment just for you — a Linux container, a Kubernetes namespace, or whatever the
              lab needs. It can take a little while. Nothing is installed on your computer.
            </dd>
          </div>
          <div>
            <dt>Terminal</dt>
            <dd>
              A real shell in that environment, in your browser. Everything you type runs there. Click the terminal to
              type into it.
            </dd>
          </div>
          <div>
            <dt>Verify</dt>
            <dd>
              Checks the real state of your environment against the lab’s requirements and shows which ones pass. It
              does not look at which commands you typed, so any correct approach passes. You can verify as often as you
              like; a lab is completed the first time every check passes.
            </dd>
          </div>
          <div>
            <dt>Hints</dt>
            <dd>
              Stuck? The instructions beside the terminal have hints that open one at a time, from a gentle nudge to
              concrete guidance. Hints you have opened stay open if you reload the page. Opening a hint never affects
              whether a lab counts as completed.
            </dd>
          </div>
          <div>
            <dt>Reset</dt>
            <dd>
              Puts the environment back to the lab’s starting state. Anything you changed inside it is lost. Your
              saved progress is kept, and the time limit is not extended.
            </dd>
          </div>
          <div>
            <dt>End lab</dt>
            <dd>
              Deletes the environment. Do this when you are finished so the environment is free for someone else. Your
              progress is saved. After a completed lab, the summary suggests the next lab on your learning path.
            </dd>
          </div>
        </dl>
      </section>

      <section className="prose" aria-labelledby="help-time">
        <h2 id="help-time">Time limits and inactivity</h2>
        <p>
          Each environment has a time limit, shown as a countdown in the workspace. If you stop using a lab for a
          while, a warning appears — press <strong>Stay active</strong> to keep it. Otherwise it is removed
          automatically. Staying active does not extend the overall time limit.
        </p>
        <p>
          Leaving the page does not stop a lab. Come back from the dashboard or the <strong>Active lab</strong> link in
          the top bar.
        </p>
      </section>

      <section className="prose" aria-labelledby="help-progress">
        <h2 id="help-progress">Your progress</h2>
        <p>
          Progress is saved to your account, separately from the environment. A lab is marked{' '}
          <strong>In progress</strong> once you have tried to launch it (even if the platform was too busy to start it) and <strong>Completed</strong> only when Verify passes every
          check. Ending, resetting or losing an environment never removes a completion.
        </p>
      </section>

      <section className="prose" aria-labelledby="help-problems">
        <h2 id="help-problems">When something goes wrong</h2>
        <div className="faq">
          {PROBLEMS.map((problem) => (
            <div key={problem.title} className="faq__item">
              <h3>{problem.title}</h3>
              <p>{problem.body}</p>
            </div>
          ))}
        </div>
        <p>
          Error messages include a short <strong>reference</strong> such as <code>LAB_CAPACITY_REACHED</code>. If you
          ask your instructor for help, include it — it tells them exactly what happened.
        </p>
      </section>

      <p>
        <a className="btn btn--primary" href={hrefFor({ name: 'labs' })}>
          Browse labs
        </a>
      </p>
    </div>
  );
}
