/**
 * Provider availability probes are single-flight.
 *
 * The registry memoises a probe's answer for `availabilityTtlMs` (30 s), but
 * before this every caller that arrived while the memo was stale ran its own
 * probe. The callers are the catalog (`GET /api/labs` and `GET /api/labs/:id`
 * each probe every provider in the vocabulary), `/health`, and every Start. The
 * burst case is a class opening the catalog at the same moment: each request
 * paid for a full set of probes. A container provider's probe is two `docker`
 * processes (`ping`, then `image inspect`), and the Kubernetes one is an API
 * round trip plus the network attestation read.
 *
 * Invariant: while one probe of a provider is in flight, the other callers
 * join it, so one refresh of the memo costs one probe. The TTL is unchanged,
 * and `invalidate()` still makes the next caller probe again.
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, type LabProvider, type ProviderAvailability } from '../src/index.js';

/** A provider whose probe stays pending until the test settles it. */
function pendingProbeProvider(id: 'linux' | 'terraform' | 'kubernetes') {
  const waiting: Array<{ resolve: (a: ProviderAvailability) => void; reject: (e: Error) => void }> = [];
  let probes = 0;
  const provider = {
    id,
    name: `fake-${id}`,
    sandboxKind: id === 'kubernetes' ? 'namespace' : 'container',
    availability: () => {
      probes += 1;
      return new Promise<ProviderAvailability>((resolve, reject) => waiting.push({ resolve, reject }));
    },
  } as unknown as LabProvider;
  return {
    provider,
    get probes() {
      return probes;
    },
    settle(availability: ProviderAvailability = { available: true }) {
      for (const probe of waiting.splice(0)) probe.resolve(availability);
    },
    fail(error: Error) {
      for (const probe of waiting.splice(0)) probe.reject(error);
    },
  };
}

describe('provider availability probes are single-flight', () => {
  it('twenty concurrent callers of one stale provider share one probe', async () => {
    const linux = pendingProbeProvider('linux');
    const reg = new ProviderRegistry({ availabilityTtlMs: 30_000 }).register({ provider: linux.provider });

    const answers = Array.from({ length: 20 }, () => reg.status('linux'));
    expect(linux.probes).toBe(1);

    linux.settle({ available: true });
    const statuses = await Promise.all(answers);
    expect(statuses.every((s) => s.available)).toBe(true);
    expect(linux.probes).toBe(1);
  });

  it('a burst of catalog reads probes each provider once', async () => {
    const linux = pendingProbeProvider('linux');
    const terraform = pendingProbeProvider('terraform');
    const kubernetes = pendingProbeProvider('kubernetes');
    const reg = new ProviderRegistry({ availabilityTtlMs: 30_000 })
      .register({ provider: linux.provider })
      .register({ provider: terraform.provider })
      .register({ provider: kubernetes.provider });

    // What `GET /api/labs` does per request, for twenty students at once.
    const reads = Array.from({ length: 20 }, () => reg.statuses());
    for (const fake of [linux, terraform, kubernetes]) fake.settle();
    await Promise.all(reads);

    expect([linux.probes, terraform.probes, kubernetes.probes]).toEqual([1, 1, 1]);
  });

  it('does not stretch the memo: with no TTL, a caller after the probe settles probes again', async () => {
    const linux = pendingProbeProvider('linux');
    const reg = new ProviderRegistry({ availabilityTtlMs: 0 }).register({ provider: linux.provider });

    const first = reg.status('linux');
    linux.settle();
    await first;

    const second = reg.status('linux');
    expect(linux.probes).toBe(2);
    linux.settle();
    await second;
  });

  it('invalidate() while a probe is in flight makes the next caller probe fresh', async () => {
    const linux = pendingProbeProvider('linux');
    const reg = new ProviderRegistry({ availabilityTtlMs: 30_000 }).register({ provider: linux.provider });

    const stale = reg.status('linux');
    // Start's "memoised answer was no, ask again now" path.
    reg.invalidate('linux');
    const fresh = reg.status('linux');
    expect(linux.probes).toBe(2);

    linux.settle({ available: true });
    await Promise.all([stale, fresh]);
  });

  it('a probe that throws is reported to every joined caller as unavailable, and is not memoised as in flight', async () => {
    const linux = pendingProbeProvider('linux');
    const reg = new ProviderRegistry({ availabilityTtlMs: 0 }).register({ provider: linux.provider });

    const answers = [reg.status('linux'), reg.status('linux'), reg.status('linux')];
    linux.fail(new Error('runtime socket refused'));
    const statuses = await Promise.all(answers);
    expect(statuses.map((s) => s.available)).toEqual([false, false, false]);
    expect(statuses[0]?.reason).toBe('runtime socket refused');
    expect(linux.probes).toBe(1);

    const next = reg.status('linux');
    expect(linux.probes).toBe(2);
    linux.settle();
    await next;
  });
});
