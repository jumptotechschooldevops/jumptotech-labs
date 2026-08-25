/**
 * The `neighbour_state` primitive.
 *
 * Tested on its own, against synthetic labs, before any curriculum depends on
 * it. The properties that matter are not "does it find the row" but the ones a
 * graded platform is judged on:
 *
 *   · it reads the kernel's table and nothing else, so a file a student wrote
 *     cannot satisfy it;
 *   · it treats NUD state as a *set*, because a correct answer ages from
 *     REACHABLE to STALE on its own and a lab that demanded one would fail a
 *     student for pausing;
 *   · an unresolved neighbour (INCOMPLETE/FAILED) and no entry at all are
 *     different outcomes, and both are gradeable;
 *   · a sandbox that cannot answer fails safely rather than passing.
 *
 * The fake models the shape of `ip -json neigh show`. That a real kernel
 * produces this shape was confirmed against a real container, and the sample
 * rows below are copied from that run rather than invented.
 */
import { describe, expect, it } from 'vitest';
import { parseLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox } from './sandbox-fake.js';

const NEIGH = 'ip -json neigh show';

/** Real output shape, captured from a --network none container on a lab bridge. */
const RESOLVED_AND_FAILED = JSON.stringify([
  { dst: '10.90.0.77', dev: 'eth0', state: ['FAILED'] },
  { dst: '10.90.0.1', dev: 'eth0', lladdr: 'b6:1c:12:75:5f:cf', state: ['REACHABLE'] },
]);

function labWith(requirement: string, id = 'NET-901'): LoadedLabDefinition {
  const yaml = `
id: ${id}
slug: net-901-probe
title: Neighbour probe
track: networking
topic: layering
difficulty: beginner
duration_minutes: 10
environment:
  provider: linux
  network: link
task:
  summary: s
  description: d
requirements:
${requirement}
references:
  - title: RFC 826
    url: https://www.rfc-editor.org/info/rfc826
skills:
  - net.l2.arp
`;
  return {
    ...parseLabDefinition(yaml),
    directory: '/labs/net-901',
    sourcePath: '/labs/net-901/lab.yaml',
  };
}

const RESOLVED_GATEWAY = `  - type: neighbour_state
    address: 10.90.0.1
    device: eth0
    state: [REACHABLE, STALE, DELAY, PROBE]
    lladdr: present
    label: The gateway was resolved
`;

function sandbox(neighbourJson: string): FakeSandbox {
  return new FakeSandbox({ commands: { [NEIGH]: { stdout: neighbourJson } } });
}

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

const NS = 'jtt-lab-000000000001';

// ------------------------------------------------------------- 1. it passes

describe('neighbour_state grades the kernel neighbour table', () => {
  it('passes when the neighbour is resolved in an accepted state', async () => {
    const result = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: sandbox(RESOLVED_AND_FAILED),
      namespace: NS,
    });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('reads the table once, through a fixed argv it owns', async () => {
    const box = sandbox(RESOLVED_AND_FAILED);
    await verifyLab({ lab: labWith(RESOLVED_GATEWAY + RESOLVED_GATEWAY.replace('10.90.0.1', '10.90.0.77').replace('lladdr: present', 'lladdr: absent').replace('state: [REACHABLE, STALE, DELAY, PROBE]', 'state: [FAILED, INCOMPLETE]')), sandbox: box, namespace: NS });

    // Two requirements, one read: the argv is the verifier's, and it is fixed.
    expect(box.inspections).toEqual([NEIGH]);
  });
});

// --------------------------------------------------- 2–4. it fails correctly

describe('neighbour_state fails on the wrong state', () => {
  it('fails when the expected neighbour was never resolved', async () => {
    const result = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: sandbox(JSON.stringify([])),
      namespace: NS,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toBe('The neighbour table has no entry for 10.90.0.1 on eth0');
  });

  it('fails on the wrong address, even when another neighbour is resolved', async () => {
    const result = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY.replace('10.90.0.1', '10.90.0.2')),
      sandbox: sandbox(RESOLVED_AND_FAILED),
      namespace: NS,
    });

    expect(failures(result.checks)).toHaveLength(1);
    expect(result.passed).toBe(false);
  });

  it('fails on the wrong interface, even when the address matches', async () => {
    const result = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY.replace('device: eth0', 'device: eth1')),
      sandbox: sandbox(RESOLVED_AND_FAILED),
      namespace: NS,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('no entry for 10.90.0.1 on eth1');
  });

  it('fails a resolved neighbour when the lab required an unresolved one', async () => {
    const wantsFailed = `  - type: neighbour_state
    address: 10.90.0.1
    state: [FAILED, INCOMPLETE]
    lladdr: absent
    label: The address never answered
`;
    const result = await verifyLab({
      lab: labWith(wantsFailed),
      sandbox: sandbox(RESOLVED_AND_FAILED),
      namespace: NS,
    });
    const failed = failures(result.checks);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('REACHABLE, hardware address resolved');
  });
});

// -------------------------------------- 5. INCOMPLETE / FAILED are gradeable

describe('an unresolved neighbour is a first-class outcome', () => {
  const unresolved = `  - type: neighbour_state
    address: 10.90.0.77
    device: eth0
    state: [INCOMPLETE, FAILED]
    lladdr: absent
    label: The address on this link never answered
`;

  it('passes on FAILED with no hardware address', async () => {
    const result = await verifyLab({
      lab: labWith(unresolved),
      sandbox: sandbox(RESOLVED_AND_FAILED),
      namespace: NS,
    });

    expect(failures(result.checks)).toEqual([]);
  });

  it('passes on INCOMPLETE too — the kernel is still asking', async () => {
    const stillAsking = JSON.stringify([
      { dst: '10.90.0.77', dev: 'eth0', state: ['INCOMPLETE'] },
    ]);
    const result = await verifyLab({
      lab: labWith(unresolved),
      sandbox: sandbox(stillAsking),
      namespace: NS,
    });

    expect(failures(result.checks)).toEqual([]);
  });

  it('accepts STALE for a resolved neighbour, because ageing is not a fault', async () => {
    const aged = JSON.stringify([
      { dst: '10.90.0.1', dev: 'eth0', lladdr: 'b6:1c:12:75:5f:cf', state: ['STALE'] },
    ]);
    const result = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: sandbox(aged),
      namespace: NS,
    });

    expect(failures(result.checks)).toEqual([]);
  });

  it('distinguishes "no entry at all" from "an entry that failed"', async () => {
    const mustBeAbsent = `  - type: neighbour_state
    address: 10.99.99.99
    absent: true
    label: A destination with no route never reaches the neighbour stage
`;
    // No route means the kernel refuses before ARP: no row is ever created.
    const passing = await verifyLab({
      lab: labWith(mustBeAbsent),
      sandbox: sandbox(RESOLVED_AND_FAILED),
      namespace: NS,
    });
    expect(failures(passing.checks)).toEqual([]);

    // A FAILED row is still a row, and must not satisfy `absent`.
    const withRow = JSON.stringify([{ dst: '10.99.99.99', dev: 'eth0', state: ['FAILED'] }]);
    const failing = await verifyLab({
      lab: labWith(mustBeAbsent),
      sandbox: sandbox(withRow),
      namespace: NS,
    });
    expect(failures(failing.checks)).toHaveLength(1);
    expect(failures(failing.checks)[0]?.detail).toContain('still holds an entry');
  });
});

// ------------------------------------------------- 6–8. it cannot be faked

describe('neighbour_state cannot be satisfied by evidence a student authored', () => {
  it('ignores a file containing the expected neighbour information', async () => {
    const box = new FakeSandbox({
      commands: { [NEIGH]: { stdout: '[]' } },
      files: {
        '/home/student/answer.txt': {
          type: 'file',
          content: '10.90.0.1 dev eth0 lladdr b6:1c:12:75:5f:cf REACHABLE\n',
        },
        '/home/student/.bash_history': {
          type: 'file',
          content: 'ip neigh show\nping 10.90.0.1\narp -a\n',
        },
      },
    });

    const result = await verifyLab({ lab: labWith(RESOLVED_GATEWAY), sandbox: box, namespace: NS });

    expect(result.passed).toBe(false);
    // The graded read never touched the student's files.
    expect(box.reads).toEqual([]);
  });

  it('ignores text that reproduces the command output exactly', async () => {
    const box = new FakeSandbox({
      commands: { [NEIGH]: { stdout: '[]' } },
      files: {
        '/home/student/neigh.json': { type: 'file', content: RESOLVED_AND_FAILED },
      },
    });

    const result = await verifyLab({ lab: labWith(RESOLVED_GATEWAY), sandbox: box, namespace: NS });

    expect(result.passed).toBe(false);
  });

  it('cannot be satisfied by another session — each reader is its own sandbox', async () => {
    const solved = sandbox(RESOLVED_AND_FAILED);
    const untouched = sandbox('[]');

    const b = await verifyLab({ lab: labWith(RESOLVED_GATEWAY), sandbox: solved, namespace: NS });
    const a = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: untouched,
      namespace: 'jtt-lab-000000000002',
    });

    expect(b.passed).toBe(true);
    expect(a.passed).toBe(false);
  });
});

// ---------------------------------------------- 9–10. malformed and offline

describe('neighbour_state fails safely', () => {
  it.each([
    ['not JSON at all', 'ip: command produced nothing useful'],
    ['a JSON object rather than an array', '{"dst":"10.90.0.1"}'],
    ['an array of nonsense', '[1,2,3]'],
    ['rows with no destination', '[{"dev":"eth0","state":["REACHABLE"]}]'],
    ['an empty document', ''],
  ])('fails rather than throwing on %s', async (_name, stdout) => {
    const result = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: sandbox(stdout),
      namespace: NS,
    });

    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(1);
  });

  it('raises a broken environment, rather than passing, when the read fails', async () => {
    const box = new FakeSandbox({
      commands: { [NEIGH]: { exitCode: 1, stderr: 'Operation not permitted' } },
    });

    // The platform's existing convention: a sandbox that cannot answer is an
    // environment fault, reported as such, and deliberately not dressed up as
    // a student who failed the lab. What matters here is that it never passes.
    await expect(
      verifyLab({ lab: labWith(RESOLVED_GATEWAY), sandbox: box, namespace: NS }),
    ).rejects.toThrow(/Operation not permitted/);
  });

  it('does not pass when the sandbox cannot be inspected at all', async () => {
    // A reader with no `inspect` is what a provider that offers no inspection
    // commands hands over. It must fail the check, never satisfy it.
    const noInspect = {
      async read() {
        return null;
      },
    };

    const result = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: noInspect,
      namespace: NS,
    });

    expect(result.passed).toBe(false);
  });
});

// ------------------------------------------------------------- 11. staleness

describe('a previous pass cannot survive the state going away', () => {
  it('fails again once the neighbour table is empty, as it is after a reset', async () => {
    const before = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: sandbox(RESOLVED_AND_FAILED),
      namespace: NS,
    });
    expect(before.passed).toBe(true);

    // A reset replaces the container: new network namespace, empty table.
    const after = await verifyLab({
      lab: labWith(RESOLVED_GATEWAY),
      sandbox: sandbox('[]'),
      namespace: NS,
    });

    expect(after.passed).toBe(false);
    expect(after.summary).toBe('LAB NOT COMPLETE');
  });
});
