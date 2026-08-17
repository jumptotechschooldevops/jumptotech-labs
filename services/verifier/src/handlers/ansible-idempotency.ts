/**
 * The idempotency check.
 *
 * Configuration management is not "a script that ran". It is a description of a
 * desired state that converges: applying it to a system that already matches
 * must do nothing at all. That property is what separates Ansible from a shell
 * script, and it is the one property a student can most easily believe they
 * have while not having it.
 *
 * ```text
 *   (optional) clear the paths the playbook owns
 *        └─► run 1   expect changed > 0   the automation did the work
 *              └─► run 2   expect changed = 0   nothing left to do
 * ```
 *
 * **It reads numbers, not text.** Ansible computes ok / changed / failures /
 * unreachable per host; a platform-owned callback plugin writes those out as
 * JSON and this handler reads the data structure. Nothing here pattern-matches
 * a PLAY RECAP line, so a play whose output format changes does not silently
 * change the verdict.
 *
 * **It is safe to repeat.** The optional baseline only ever clears paths drawn
 * from `ALLOWED_MANAGED_ROOTS` — directories the labs themselves write into —
 * and the playbook it runs is the student's own, in the student's own sandbox.
 * A Check that is pressed twice does the same thing twice.
 */
import type { AnsiblePlaybookRun } from '@jumptotech/lab-orchestrator';
import type { AnsibleVerifierHandler, HandlerOutcome } from '../contract.js';
import { fail, pass } from '../contract.js';
import { firstMeaningfulLine } from '../ansible-reader.js';

export const ansibleIdempotent: AnsibleVerifierHandler<'ansible_idempotent'> = {
  type: 'ansible_idempotent',
  label: (r) => `${r.playbook} is idempotent — a second run changes nothing`,
  async run(requirement, reader) {
    const exists = await reader.workspacePath(requirement.playbook);
    if (!exists.exists) return fail(`'${requirement.playbook}' does not exist in the lab project`);

    if (requirement.require_initial_change) {
      for (const node of reader.managedNodes()) {
        for (const target of requirement.reset_paths) {
          await reader.removeManagedPath(node, target);
        }
      }
    }

    const first = await reader.runPlaybook(requirement.playbook);
    const firstProblem = describeRunFailure(first, 'first');
    if (firstProblem) return fail(firstProblem);

    const firstTotals = totals(first);
    if (requirement.require_initial_change && firstTotals.changed === 0) {
      return fail(
        'the first run reported 0 changed tasks — the playbook does not actually create the required state',
      );
    }

    const second = await reader.runPlaybook(requirement.playbook);
    const secondProblem = describeRunFailure(second, 'second');
    if (secondProblem) return fail(secondProblem);

    const secondTotals = totals(second);
    if (secondTotals.changed > 0) {
      const noisy = changedHosts(second);
      return fail(
        `the second run still reported ${secondTotals.changed} changed task(s)${
          noisy.length > 0 ? ` on ${noisy.join(', ')}` : ''
        } — the playbook is not converging on a desired state`,
      );
    }

    return pass(
      `first run changed ${firstTotals.changed}, second run changed 0 across ${secondTotals.hosts} host(s)`,
    );
  },
};

interface RunTotals {
  ok: number;
  changed: number;
  failures: number;
  unreachable: number;
  hosts: number;
}

function totals(run: AnsiblePlaybookRun): RunTotals {
  const summary: RunTotals = { ok: 0, changed: 0, failures: 0, unreachable: 0, hosts: 0 };
  for (const host of Object.values(run.stats ?? {})) {
    summary.ok += host.ok;
    summary.changed += host.changed;
    summary.failures += host.failures;
    summary.unreachable += host.unreachable;
    summary.hosts += 1;
  }
  return summary;
}

function changedHosts(run: AnsiblePlaybookRun): string[] {
  return Object.entries(run.stats ?? {})
    .filter(([, stats]) => stats.changed > 0)
    .map(([host]) => host);
}

/**
 * Why a run does not count, or `null` when it does.
 *
 * A run that never produced stats did not get far enough to say anything about
 * idempotency — a syntax error, an unreachable host, or a play that matched no
 * hosts. Each is reported as itself rather than as "not idempotent", because
 * telling a student their playbook is not converging when it never ran would
 * send them looking in the wrong place.
 */
function describeRunFailure(run: AnsiblePlaybookRun, which: 'first' | 'second'): string | null {
  if (run.timedOut) return `the ${which} run timed out`;

  if (run.stats === null) {
    const detail = firstMeaningfulLine(run.stderr) || firstMeaningfulLine(run.stdout);
    return `the ${which} run did not complete${detail ? `: ${detail.slice(0, 240)}` : ''}`;
  }

  const summary = totals(run);
  if (summary.hosts === 0) return `the ${which} run matched no hosts`;
  if (summary.unreachable > 0) {
    const hosts = Object.entries(run.stats)
      .filter(([, stats]) => stats.unreachable > 0)
      .map(([host]) => host);
    return `the ${which} run could not reach ${hosts.join(', ')}`;
  }
  if (summary.failures > 0) {
    const hosts = Object.entries(run.stats)
      .filter(([, stats]) => stats.failures > 0)
      .map(([host]) => host);
    return `the ${which} run failed on ${hosts.join(', ')}`;
  }
  if (run.exitCode !== 0) {
    return `the ${which} run exited with code ${run.exitCode}`;
  }
  return null;
}

export const ansibleIdempotencyHandlers = { ansibleIdempotent } as const;

export type { HandlerOutcome };
