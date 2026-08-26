/**
 * CS-004 — what the verifier accepts for the descriptor-exhaustion lab.
 *
 * Two things make this lab gradeable without a grader inside the sandbox.
 *
 * The investigation half is graded on four findings the student can only get
 * by reading the running process: the soft limit exists nowhere on disk (the
 * seed that set it is deleted before the terminal opens), and which *kind* of
 * descriptor dominates has to be counted, because the service leaks a mix.
 *
 * The programming half is graded on behaviour. `script_runs` execs a program
 * with exactly three descriptors already open, so a program that lowers its own
 * limit to N and opens until the kernel refuses always manages N - 3 — for any
 * technique, files or sockets alike. That makes `OPENED` both deterministic and
 * the thing the lab is actually teaching: the ceiling counts 0, 1 and 2 too.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_004 = path.join(LABS_DIR, 'cs', 'cs-004-file-descriptors', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000004';

const PROGRAM = '/home/student/py/fdlimit.py';
const FINDINGS = '/home/student/ops/fds.txt';

const CORRECT_SOURCE = [
  '#!/usr/bin/env python3',
  'import errno, os, resource, sys',
  'limit = int(sys.argv[1])',
  '_soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)',
  'resource.setrlimit(resource.RLIMIT_NOFILE, (limit, hard))',
  'opened, failure = [], None',
  'try:',
  '    while True:',
  '        opened.append(os.open("/dev/null", os.O_RDONLY))',
  'except OSError as exc:',
  '    failure = exc',
  'for fd in opened:',
  '    os.close(fd)',
  'print(f"LIMIT={limit}")',
  'print(f"OPENED={len(opened)}")',
  'print(f"ERRNO={failure.errno}")',
  'print(f"ERRNAME={errno.errorcode[failure.errno]}")',
  'sys.exit(0 if failure.errno == errno.EMFILE else 1)',
  '',
].join('\n');

const CORRECT_FINDINGS = [
  'STDERR_FD=2',
  'LEAK_KIND=socket',
  'COLLECTOR_SOFT_LIMIT=256',
  'REAL_FIX=close',
  '',
].join('\n');

/** A correct program's output: the ceiling counts the three it started with. */
function output(limit: number, opened = limit - 3, errno = 24, name = 'EMFILE'): string {
  return `LIMIT=${limit}\nOPENED=${opened}\nERRNO=${errno}\nERRNAME=${name}\n`;
}

const CORRECT_OUTPUT: Record<string, string> = { '64': output(64), '128': output(128) };

function collectorEvidence(): FakeWorld['files'] {
  return {
    '/usr/local/bin/scan-collector': { content: '#!/usr/bin/env python3\n# polls the depot scanners\n', owner: 'root', mode: '755' },
    '/var/log/kestrel/scan-collector.log.1': {
      content: '2026-08-21T02:14:41 scan-collector: OSError: [Errno 24] Too many open files\n',
      owner: 'root',
      mode: '644',
    },
  };
}

function initialWorld(): FakeWorld {
  return { files: collectorEvidence() };
}

interface Solution {
  source?: string;
  findings?: string;
  output?: Record<string, string>;
  exitCode?: number;
  mode?: string;
}

function worldWith(s: Solution): FakeWorld {
  const world = initialWorld();
  if (s.source !== undefined) world.files![PROGRAM] = { content: s.source, mode: s.mode ?? '755' };
  if (s.findings !== undefined) world.files![FINDINGS] = { content: s.findings };
  world.scripts = {};
  for (const [arg, stdout] of Object.entries(s.output ?? CORRECT_OUTPUT)) {
    world.scripts[`${PROGRAM} ${arg}`] = { exitCode: s.exitCode ?? 0, stdout };
  }
  return world;
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_004);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-004 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify(initialWorld());
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
    expect(failed(result.checks)).toHaveLength(definition.requirements.length);
  });
});

describe('CS-004 when the work has been done', () => {
  it('passes', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS }));

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('passes a program that exhausts sockets instead of files', async () => {
    // A descriptor is a descriptor — which is the lab's point. This shares no
    // technique with the reference and must grade identically.
    const sockets = [
      '#!/usr/bin/env python3',
      'import errno as E, resource as R, socket, sys',
      'want = int(sys.argv[1])',
      'R.setrlimit(R.RLIMIT_NOFILE, (want, R.getrlimit(R.RLIMIT_NOFILE)[1]))',
      'held, problem = [], None',
      'while problem is None:',
      '    try:',
      '        held.append(socket.socket(socket.AF_INET, socket.SOCK_STREAM))',
      '    except OSError as oops:',
      '        problem = oops',
      'for sock in held:',
      '    sock.close()',
      'print("LIMIT=%d" % want)',
      'print("OPENED=%d" % len(held))',
      'print("ERRNO=%d" % problem.errno)',
      'print("ERRNAME=%s" % E.errorcode[problem.errno])',
      'raise SystemExit(0 if problem.errno == E.EMFILE else 1)',
      '',
    ].join('\n');

    const result = await verify(worldWith({ source: sockets, findings: CORRECT_FINDINGS }));
    expect(result.passed).toBe(true);
  });
});

describe('CS-004 rejects the misreadings it exists to correct', () => {
  it('rejects calling a socket leak a file leak', async () => {
    const wrong = CORRECT_FINDINGS.replace('LEAK_KIND=socket', 'LEAK_KIND=file');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: wrong }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      "The findings identify what dominates the collector's descriptor table",
    ]);
  });

  it("rejects the shell's own limit in place of the process's", async () => {
    // `ulimit -n` answers a different question than /proc/<pid>/limits.
    const wrong = CORRECT_FINDINGS.replace('COLLECTOR_SOFT_LIMIT=256', 'COLLECTOR_SOFT_LIMIT=1048576');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: wrong }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The findings record the soft limit the collector is running under',
    ]);
  });

  it('rejects "just raise the limit" as the fix', async () => {
    const wrong = CORRECT_FINDINGS.replace('REAL_FIX=close', 'REAL_FIX=raise');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: wrong }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The findings say what actually stops the crashes recurring',
    ]);
  });

  it('rejects the wrong standard descriptor number', async () => {
    const wrong = CORRECT_FINDINGS.replace('STDERR_FD=2', 'STDERR_FD=1');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: wrong }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The findings name the descriptor standard error always uses',
    ]);
  });

  it('rejects a program that forgets the three descriptors it started with', async () => {
    // Reporting OPENED == LIMIT is the single most likely wrong answer, and it
    // is exactly the misunderstanding the lab is built to correct.
    const result = await verify(
      worldWith({
        source: CORRECT_SOURCE,
        findings: CORRECT_FINDINGS,
        output: { '64': output(64, 64), '128': output(128, 128) },
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The program reaches the descriptor ceiling and reports it correctly',
      'The program measures a second ceiling rather than repeating the first',
    ]);
  });

  it('rejects a program that reports a different error', async () => {
    const result = await verify(
      worldWith({
        source: CORRECT_SOURCE,
        findings: CORRECT_FINDINGS,
        output: { '64': output(64, 61, 13, 'EACCES'), '128': output(128, 125, 13, 'EACCES') },
        exitCode: 1,
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(2);
  });

  it('rejects the wrong exit status even when the output is right', async () => {
    // The contract is exit 0 when the failure really was the descriptor
    // ceiling. A program that always exits non-zero has not honoured it.
    const result = await verify(
      worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS, exitCode: 1 }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The program reaches the descriptor ceiling and reports it correctly',
      'The program measures a second ceiling rather than repeating the first',
    ]);
  });

  it('rejects a program that crashes instead of catching the failure', async () => {
    const result = await verify(
      worldWith({
        source: CORRECT_SOURCE,
        findings: CORRECT_FINDINGS,
        output: { '64': '', '128': '' },
        exitCode: 1,
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(2);
  });
});

describe('CS-004 requires both halves', () => {
  it('rejects a missing findings file', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(5);
  });

  it('rejects a missing program', async () => {
    const result = await verify(worldWith({ findings: CORRECT_FINDINGS, output: {} }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(5);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS, mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The reproduction program exists and can be run as a program');
  });
});

describe('CS-004 rejects the bypasses', () => {
  it('rejects a transcript that prints both limits at once', async () => {
    const transcript = ['#!/bin/sh', 'echo "LIMIT=64"', 'echo "OPENED=61"', 'echo "LIMIT=128"', 'echo "OPENED=125"', ''].join('\n');
    const everything = output(64) + output(128);

    const result = await verify(
      worldWith({ source: transcript, findings: CORRECT_FINDINGS, output: { '64': everything, '128': everything } }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The program counts what it opened rather than containing the count',
      'The program is not a transcript of expected output',
    ]);
  });
});

describe('CS-004 never hands the answers back', () => {
  it('keeps every expected value out of the failure details', async () => {
    const result = await verify(
      worldWith({
        source: '#!/bin/sh\nexit 3\n',
        findings: 'WRONG=1\n',
        output: { '64': 'nope\n', '128': 'nope\n' },
        exitCode: 3,
      }),
    );

    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /OPENED=61|OPENED=125|ERRNO=24|EMFILE|LEAK_KIND=socket|COLLECTOR_SOFT_LIMIT=256|REAL_FIX=close/,
      );
    }
  });

  it('keeps every expected value out of the student-visible text', async () => {
    const definition = await lab();
    const visible = [
      definition.story ?? '',
      definition.task.summary,
      definition.task.description,
      ...definition.objectives,
      ...definition.hints.map((h) => h.text),
      ...definition.requirements.map((r) => r.label ?? ''),
    ].join('\n');

    // The soft limit, the dominant kind, the descriptor counts and the errno
    // name are all things the student must obtain from the running system.
    for (const secret of ['OPENED=61', 'OPENED=125', 'EMFILE', 'LEAK_KIND=socket', '256', 'REAL_FIX=close']) {
      expect(visible, `student-visible text leaks ${secret}`).not.toContain(secret);
    }
  });

  it('grades only the student’s own artifacts, never the fixture', async () => {
    const sandbox = new FakeSandbox(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS }));
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM, FINDINGS]));
    expect(sandbox.scriptRuns).toEqual([`${PROGRAM} 64`, `${PROGRAM} 128`]);
  });
});
