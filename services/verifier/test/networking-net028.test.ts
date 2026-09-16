/**
 * NET-028 — verification for the VPC design review.
 *
 * NET-028 grades a *document*, not a running system, and that is the whole
 * risk in it: a lab whose evidence is text the student typed can be passed by
 * typing everything. Three properties have to hold, and the sections below are
 * those three:
 *
 *   1. **The seeded templates fail.** Every positive check is a `label = value`
 *      pairing, and no seeded file contains one — the allowed-value vocabulary
 *      is printed, the pairing never is. So a student who reads the files and
 *      submits them unchanged passes nothing they have not answered.
 *   2. **A correct design passes.** The exact four `/20`s, the four routes, and
 *      one allowed value per question.
 *   3. **A wrong design fails, including the two wrong designs that matter** —
 *      overlapping subnets, and a private route table whose default route goes
 *      to the Internet Gateway. The second is the mistake that silently turns
 *      the private tier public, which is what this lab exists to prevent.
 *
 * The hedge cases are section 4. `contains` is a substring, so listing every
 * allowed value on one line would satisfy every positive check; the lab's
 * `file_content_absent` and `file_contains`/`absent` checks are what stop it,
 * and each test here is an attempt to pass the lab that way.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const LAB_DIR = path.join(LABS_DIR, 'networking', 'net-028-vpc-architecture');
const NET_028 = path.join(LAB_DIR, 'lab.yaml');

const NAMESPACE = 'jtt-lab-000000000001';
const VPC = '/home/student/vpc';

function failures(checks: Array<{ status: string; label: string; detail?: string }>) {
  return checks.filter((c) => c.status !== 'pass');
}

// --- the world, before and after -------------------------------------------

/**
 * The templates exactly as the lab seeds them, read from the lab's own setup
 * directory rather than restated here.
 *
 * Restating them would let the files and the tests drift apart in the one way
 * that matters: a template whose labels no longer match the ones the checks
 * grade would still pass a hand-written fixture.
 */
function seeded(name: string): string {
  return readFileSync(path.join(LAB_DIR, 'setup', name), 'utf8');
}

/** Fill in one `label = ` line of a seeded template, as a student would. */
function answer(template: string, values: Record<string, string>): string {
  let filled = template;
  for (const [label, value] of Object.entries(values)) {
    const line = new RegExp(`^(\\s*)${label} = *$`, 'm');
    expect(filled, `template has no '${label} = ' line to answer on`).toMatch(line);
    filled = filled.replace(line, `$1${label} = ${value}`);
  }
  return filled;
}

/**
 * The correct allocation.
 *
 * `10.30.0.0/16` holds sixteen `/20`s. A `/20` leaves twelve host bits, so it
 * covers 4096 addresses — sixteen whole values of the third octet — and four
 * consecutive blocks from the VPC's first address therefore start at .0, .16,
 * .32 and .48 (RFC 4632 §3.1).
 */
const CORRECT_DESIGN = {
  az_a_public: '10.30.0.0/20',
  az_a_private: '10.30.16.0/20',
  az_b_public: '10.30.32.0/20',
  az_b_private: '10.30.48.0/20',
};

const CORRECT_ROUTES = {
  public_local: '10.30.0.0/16 -> local',
  public_default: '0.0.0.0/0 -> Internet Gateway',
  private_local: '10.30.0.0/16 -> local',
  private_default: '0.0.0.0/0 -> NAT Gateway',
};

const CORRECT_ANSWERS = {
  q1_public_subnet_is: 'a route to an Internet Gateway',
  q2_nat_gateway_lives_in: 'public subnet',
  q2_because: "it forwards through that subnet's route to the Internet Gateway",
  q3_unreachable_because: 'it has no public IP for a client to address it by',
  q4_single_nat_gateway: 'losing one availability zone breaks outbound traffic in both',
};

function world(files: Record<string, string> = {}): FakeWorld {
  return {
    files: {
      [VPC]: { type: 'directory', mode: '755' },
      [`${VPC}/requirements.txt`]: { type: 'file', content: seeded('requirements.txt') },
      [`${VPC}/design.txt`]: { type: 'file', content: seeded('design.txt') },
      [`${VPC}/routes.txt`]: { type: 'file', content: seeded('routes.txt') },
      [`${VPC}/answers.txt`]: { type: 'file', content: seeded('answers.txt') },
      ...Object.fromEntries(
        Object.entries(files).map(([name, content]) => [name, { type: 'file', content }]),
      ),
    },
  };
}

/** The design done correctly, in full. */
function solvedFiles(): Record<string, string> {
  return {
    [`${VPC}/design.txt`]: answer(seeded('design.txt'), CORRECT_DESIGN),
    [`${VPC}/routes.txt`]: answer(seeded('routes.txt'), CORRECT_ROUTES),
    [`${VPC}/answers.txt`]: answer(seeded('answers.txt'), CORRECT_ANSWERS),
  };
}

function solved(): FakeSandbox {
  return new FakeSandbox(world(solvedFiles()));
}

/** A correct submission with one file replaced. */
function solvedExcept(name: string, content: string): FakeSandbox {
  return new FakeSandbox(world({ ...solvedFiles(), [`${VPC}/${name}`]: content }));
}

async function verifySolvedExcept(name: string, values: Record<string, string>) {
  const lab = await loadLabDefinition(NET_028);
  const template = seeded(name);
  const merged = { ...templateDefaults(name), ...values };
  const sandbox = solvedExcept(name, answer(template, merged));
  return verifyLab({ lab, sandbox, namespace: NAMESPACE });
}

function templateDefaults(name: string): Record<string, string> {
  if (name === 'design.txt') return CORRECT_DESIGN;
  if (name === 'routes.txt') return CORRECT_ROUTES;
  return CORRECT_ANSWERS;
}

// --------------------------------------------------------- 1. negative case

describe('NET-028 before the work', () => {
  it('fails every positive check on the seeded templates, and hands over no answer', async () => {
    const lab = await loadLabDefinition(NET_028);
    const result = await verifyLab({
      lab,
      sandbox: new FakeSandbox(world()),
      namespace: NAMESPACE,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');

    // A blank template has nothing wrong written on it yet, so the checks that
    // only forbid a value pass. Everything the student was asked to write fails.
    const forbidding = lab.requirements.filter(
      (r) => r.type === 'file_content_absent' || r.type === 'file_contains',
    );
    expect(forbidding.length).toBeGreaterThan(0);
    expect(failures(result.checks)).toHaveLength(lab.requirements.length - forbidding.length);

    // Labels and details are rendered on every Check Solution, so a check that
    // repeats the pairing it grades is a free answer.
    const reported = JSON.stringify(result.checks);
    for (const requirement of lab.requirements) {
      // A forbidding check's `contains` is a *wrong* value, which is feedback
      // rather than an answer; only the positive pairings must stay unsaid.
      if (requirement.type !== 'file_content') continue;
      const answer = (requirement as { contains?: string }).contains;
      if (answer === undefined) continue;
      expect(reported, `a check leaked '${answer}'`).not.toContain(answer);
    }
  });

  it('never seeds a graded pairing into a file the student is handed', () => {
    const readable = ['requirements.txt', 'design.txt', 'routes.txt', 'answers.txt']
      .map(seeded)
      .join('\n');

    for (const [label, value] of [
      ...Object.entries(CORRECT_DESIGN),
      ...Object.entries(CORRECT_ROUTES),
      ...Object.entries(CORRECT_ANSWERS),
    ]) {
      expect(readable.includes(`${label} = ${value}`), `'${label}' is answered in a seeded file`).toBe(
        false,
      );
    }
  });

  it('fails on an empty sandbox rather than erroring', async () => {
    const lab = await loadLabDefinition(NET_028);
    const result = await verifyLab({ lab, sandbox: new FakeSandbox({}), namespace: NAMESPACE });

    expect(result.passed).toBe(false);
    expect(failures(result.checks).length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------- 2. positive case

describe('NET-028 after the work', () => {
  it('passes on the correct design', async () => {
    const lab = await loadLabDefinition(NET_028);
    const result = await verifyLab({ lab, sandbox: solved(), namespace: NAMESPACE });

    expect(failures(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('reads only the four files in the student\'s working directory', async () => {
    const lab = await loadLabDefinition(NET_028);
    const sandbox = solved();
    await verifyLab({ lab, sandbox, namespace: NAMESPACE });

    for (const read of sandbox.reads) {
      expect(read.startsWith(`${VPC}/`) || read === VPC, read).toBe(true);
    }
    // Nothing is executed: this lab runs no command and no student script.
    expect(sandbox.inspections).toEqual([]);
    expect(sandbox.scriptRuns).toEqual([]);
  });

  it('accepts an answer that carries the student\'s own reasoning after it', async () => {
    const result = await verifySolvedExcept('answers.txt', {
      q4_single_nat_gateway:
        'losing one availability zone breaks outbound traffic in both — the gateway is zonal',
    });
    expect(failures(result.checks)).toEqual([]);
  });
});

// ----------------------------------------------------- 3. a wrong design

describe('NET-028 rejects a wrong design', () => {
  it('fails when the private route table sends its default route to the Internet Gateway', async () => {
    const result = await verifySolvedExcept('routes.txt', {
      private_default: '0.0.0.0/0 -> Internet Gateway',
    });

    expect(result.passed).toBe(false);
    // Two ways: the private default route is not the one asked for, and the
    // route that would make the private tier public is explicitly forbidden.
    expect(failures(result.checks).length).toBeGreaterThanOrEqual(2);
  });

  it('fails when the public route table has no route off the VPC', async () => {
    const result = await verifySolvedExcept('routes.txt', {
      public_default: '0.0.0.0/0 -> NAT Gateway',
    });
    expect(result.passed).toBe(false);
  });

  it('fails when the local route names something other than the VPC CIDR', async () => {
    const result = await verifySolvedExcept('routes.txt', {
      private_local: '10.30.0.0/20 -> local',
    });
    expect(result.passed).toBe(false);
  });

  it('fails when two subnets overlap', async () => {
    const result = await verifySolvedExcept('design.txt', {
      az_a_private: '10.30.0.0/20',
    });

    expect(result.passed).toBe(false);
    // The positive check for that line fails, and so does the no-overlap check.
    expect(failures(result.checks).length).toBeGreaterThanOrEqual(2);
  });

  it('fails when the second availability zone restarts the allocation', async () => {
    const result = await verifySolvedExcept('design.txt', {
      az_b_public: '10.30.16.0/20',
      az_b_private: '10.30.32.0/20',
    });
    expect(result.passed).toBe(false);
  });

  it('fails when the right CIDRs are written on the wrong lines', async () => {
    const result = await verifySolvedExcept('design.txt', {
      az_a_public: '10.30.48.0/20',
      az_b_private: '10.30.0.0/20',
    });
    expect(result.passed).toBe(false);
  });

  it('fails when the subnets are the wrong size', async () => {
    const result = await verifySolvedExcept('design.txt', {
      az_a_public: '10.30.0.0/24',
      az_a_private: '10.30.16.0/24',
      az_b_public: '10.30.32.0/24',
      az_b_private: '10.30.48.0/24',
    });
    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(4);
  });

  it.each([
    ['q1_public_subnet_is', 'the word public in its Name tag'],
    ['q2_nat_gateway_lives_in', 'private subnet'],
    ['q3_unreachable_because', 'its subnet has no route to the Internet Gateway'],
    ['q4_single_nat_gateway', 'the private subnets would become reachable from the internet'],
  ])('fails when %s is answered wrongly', async (label, wrong) => {
    const result = await verifySolvedExcept('answers.txt', { [label]: wrong });
    expect(result.passed).toBe(false);
  });
});

// ------------------------------------------------------------- 4. hedging

describe('NET-028 cannot be passed by listing every allowed value', () => {
  it('rejects a route-table line that names both gateways', async () => {
    const result = await verifySolvedExcept('routes.txt', {
      private_default:
        '0.0.0.0/0 -> NAT Gateway, or private_default = 0.0.0.0/0 -> Internet Gateway',
    });

    expect(result.passed).toBe(false);
  });

  it('rejects a design line that names two blocks', async () => {
    const result = await verifySolvedExcept('design.txt', {
      az_a_private: '10.30.16.0/20, or az_a_private = 10.30.0.0/20',
    });

    expect(result.passed).toBe(false);
  });

  /*
   * The boundary of a substring check, stated rather than assumed.
   *
   * A forbidding check names `label = wrong value`, so it catches a hedge
   * written the way the file's own format invites — the label repeated with a
   * second value after it. It does not catch a hedge written as free prose on
   * one line ("A or B"), because the only check that would is a bare
   * `file_content_absent` on the wrong value alone, and every wrong value is
   * printed in the allowed-value list the student is handed. Such a check
   * would fail on the seeded file, before the student had done anything.
   *
   * This is the same boundary NET-003's layer triage has, for the same reason,
   * and the trade is deliberate: failing a correct student to catch a hedge is
   * the worse error. What closes it is a requirement type that counts matches
   * or grades one line at a time, which this branch does not have.
   */
  it('does not catch a hedge written as free prose, and the lab says so', async () => {
    const result = await verifySolvedExcept('answers.txt', {
      q1_public_subnet_is: 'a route to an Internet Gateway or the word public in its Name tag',
    });

    expect(result.passed).toBe(true);
  });

  it.each([
    ['q1_public_subnet_is', 'a route to an Internet Gateway', 'the word public in its Name tag'],
    ['q2_nat_gateway_lives_in', 'public subnet', 'private subnet'],
    [
      'q3_unreachable_because',
      'it has no public IP for a client to address it by',
      'its subnet has no route to the Internet Gateway',
    ],
    [
      'q4_single_nat_gateway',
      'losing one availability zone breaks outbound traffic in both',
      'the private subnets would become reachable from the internet',
    ],
  ])('rejects %s answered with both the right value and a wrong one', async (label, right, wrong) => {
    const result = await verifySolvedExcept('answers.txt', {
      [label]: `${right} / ${label} = ${wrong}`,
    });

    expect(result.passed).toBe(false);
  });

  it('rejects a whole answer sheet that lists every allowed value on every line', async () => {
    const lab = await loadLabDefinition(NET_028);
    // The crudest bypass there is: paste the allowed-value block onto the
    // answer line. Every positive `contains` is satisfied; every forbidding
    // check is not.
    const hedged = answer(seeded('answers.txt'), {
      q1_public_subnet_is:
        'a route to an Internet Gateway / q1_public_subnet_is = the word public in its Name tag',
      q2_nat_gateway_lives_in:
        'public subnet / q2_nat_gateway_lives_in = private subnet',
      q2_because: CORRECT_ANSWERS.q2_because,
      q3_unreachable_because:
        'it has no public IP for a client to address it by / q3_unreachable_because = its subnet has no route to the Internet Gateway',
      q4_single_nat_gateway:
        'losing one availability zone breaks outbound traffic in both / q4_single_nat_gateway = the private subnets would become reachable from the internet',
    });
    const result = await verifyLab({
      lab,
      sandbox: solvedExcept('answers.txt', hedged),
      namespace: NAMESPACE,
    });

    expect(result.passed).toBe(false);
    expect(failures(result.checks)).toHaveLength(4);
  });
});
