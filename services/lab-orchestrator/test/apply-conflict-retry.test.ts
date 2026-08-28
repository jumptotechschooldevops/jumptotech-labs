/**
 * Applying a guardrail object survives a concurrent controller write.
 *
 * The defect
 * ----------
 * `KubernetesClient.applyObjects` reads an object for its `resourceVersion`
 * and then `replace`s it. That is optimistic concurrency, and it fails with
 * `409 Conflict` whenever something else writes to the object in between.
 *
 * For the platform's guardrails that window is not hypothetical. `reset()`
 * purges the session namespace and *then* re-applies quota, limits, RBAC and
 * network policy — so it rewrites the `ResourceQuota` at exactly the moment
 * the quota controller is recomputing `status.used` for every pod that is
 * terminating. Against a real kind cluster, resetting K8S-013 (three replicas)
 * produced:
 *
 *     reconcile-guardrails — failed
 *     Could not apply ResourceQuota/jumptotech-session-quota into lab-…:
 *     Operation cannot be fulfilled on resourcequotas
 *     "jumptotech-session-quota": the object has been modified;
 *     please apply your changes to the latest version and try again
 *
 * A student clicking **Reset Lab** got a failed reset, on a lab that had done
 * nothing wrong.
 *
 * What is asserted here is that the retry is *narrow*: it re-reads (so it never
 * replays a stale `resourceVersion`), it only ever triggers on 409, and it
 * still gives up rather than looping forever.
 */
import { describe, expect, it } from 'vitest';
import { applyWithConflictRetry } from '../src/k8s/client.js';

/** An API error shaped the way `statusCodeOf` reads one. */
function apiError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

const CONFLICT = () =>
  apiError(
    409,
    'Operation cannot be fulfilled on resourcequotas "jumptotech-session-quota": ' +
      'the object has been modified; please apply your changes to the latest version and try again',
  );

/** No wall-clock cost for the backoff. */
const noSleep = async () => {};

describe('applying an object through an optimistic-concurrency conflict', () => {
  it('re-reads and succeeds when a controller wins the first race', async () => {
    const readVersions = ['100', '101'];
    const replaced: (string | undefined)[] = [];
    let reads = 0;

    await applyWithConflictRetry({
      read: async () => ({ metadata: { resourceVersion: readVersions[reads++] } }),
      replace: async (resourceVersion) => {
        replaced.push(resourceVersion);
        // The quota controller moved the object on from 100 while we held it.
        if (resourceVersion === '100') throw CONFLICT();
      },
      create: async () => expect.unreachable('the object existed'),
      sleep: noSleep,
    });

    expect(reads, 'a retry must re-read, not replay the stale version').toBe(2);
    expect(replaced).toEqual(['100', '101']);
  });

  it('survives a controller that wins several races in a row', async () => {
    let reads = 0;
    let replaces = 0;

    await applyWithConflictRetry({
      read: async () => ({ metadata: { resourceVersion: `v${++reads}` } }),
      replace: async () => {
        replaces += 1;
        if (replaces < 4) throw CONFLICT();
      },
      create: async () => expect.unreachable('the object existed'),
      sleep: noSleep,
    });

    expect(replaces).toBe(4);
    expect(reads).toBe(4);
  });

  it('creates the object when it does not exist', async () => {
    let created = 0;
    await applyWithConflictRetry({
      read: async () => {
        throw apiError(404, 'not found');
      },
      replace: async () => expect.unreachable('nothing to replace'),
      create: async () => {
        created += 1;
      },
      sleep: noSleep,
    });
    expect(created).toBe(1);
  });

  it('re-reads when the object is created underneath us between read and create', async () => {
    let reads = 0;
    let replaced = false;

    await applyWithConflictRetry({
      read: async () => {
        reads += 1;
        if (reads === 1) throw apiError(404, 'not found');
        return { metadata: { resourceVersion: '7' } };
      },
      replace: async () => {
        replaced = true;
      },
      create: async () => {
        throw apiError(409, 'already exists');
      },
      sleep: noSleep,
    });

    expect(reads).toBe(2);
    expect(replaced).toBe(true);
  });

  it('does not retry anything that is not a conflict', async () => {
    let replaces = 0;
    await expect(
      applyWithConflictRetry({
        read: async () => ({ metadata: { resourceVersion: '1' } }),
        replace: async () => {
          replaces += 1;
          throw apiError(403, 'forbidden');
        },
        create: async () => expect.unreachable('the object existed'),
        sleep: noSleep,
      }),
    ).rejects.toThrow(/forbidden/);

    expect(replaces, 'a 403 is not a race and must fail immediately').toBe(1);
  });

  it('gives up rather than looping against a permanently contended object', async () => {
    let replaces = 0;
    await expect(
      applyWithConflictRetry({
        read: async () => ({ metadata: { resourceVersion: '1' } }),
        replace: async () => {
          replaces += 1;
          throw CONFLICT();
        },
        create: async () => expect.unreachable('the object existed'),
        attempts: 5,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/has been modified/);

    expect(replaces).toBe(5);
  });

  it('backs off between attempts instead of hot-looping', async () => {
    const waits: number[] = [];
    let replaces = 0;

    await applyWithConflictRetry({
      read: async () => ({ metadata: { resourceVersion: '1' } }),
      replace: async () => {
        replaces += 1;
        if (replaces < 3) throw CONFLICT();
      },
      create: async () => expect.unreachable('the object existed'),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([10, 20]);
  });
});
