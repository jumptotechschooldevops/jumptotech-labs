/**
 * `terraform_state_absent` — the primitive a destroy lab is graded on.
 *
 * The single property every test here defends: **the check answers a question
 * about Terraform's own state document, not about a file's existence and not
 * about anything a student can write by hand.** Deleting state, faking state,
 * hiding state or half-destroying must all be distinguishable from a completed
 * destroy, because a lab that cannot tell them apart is teaching `rm`.
 *
 * The state shapes below are the real ones. They were taken from a genuine
 * apply-then-destroy cycle in the Terraform sandbox image (CLI 1.9.8): a
 * completed destroy leaves `resources: []` and `outputs: {}` with the serial
 * incremented, and it leaves the file behind.
 */
import { describe, expect, it } from 'vitest';
import { verifyRequirement } from '../src/registry.js';
import { SandboxReader } from '../src/sandbox-reader.js';
import { FakeSandbox } from './sandbox-fake.js';

const DIR = 'terraform';
const STATE = 'terraform/terraform.tfstate';

/** State as the CLI writes it after a completed `terraform destroy`. */
const DESTROYED = JSON.stringify({
  version: 4,
  terraform_version: '1.9.8',
  serial: 7,
  lineage: 'b9f8fa15-d8a7-2ecb-8a4b-ba5ba5b76722',
  outputs: {},
  resources: [],
  check_results: null,
});

function state(resources: unknown[], outputs: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 4,
    terraform_version: '1.9.8',
    serial: 3,
    lineage: 'b9f8fa15-d8a7-2ecb-8a4b-ba5ba5b76722',
    outputs,
    resources,
  });
}

const managed = (type: string, name: string, instances = 1): unknown => ({
  mode: 'managed',
  type,
  name,
  provider: 'provider["registry.terraform.io/hashicorp/local"]',
  instances: Array.from({ length: instances }, (_, index) => ({ schema_version: 0, index_key: index })),
});

const dataSource = (type: string, name: string): unknown => ({
  mode: 'data',
  type,
  name,
  provider: 'provider["registry.terraform.io/hashicorp/local"]',
  instances: [{ schema_version: 0 }],
});

async function check(files: Record<string, unknown>, requirement: Record<string, unknown>) {
  const sandbox = new FakeSandbox({ files: files as never });
  return verifyRequirement(
    { type: 'terraform_state_absent', dir: DIR, ...requirement } as never,
    new SandboxReader(sandbox),
  );
}

const withState = (content: string) => ({
  terraform: { type: 'directory', mode: '755' },
  [STATE]: { type: 'file', mode: '644', content },
});

// ------------------------------------------------------------ the happy path

describe('terraform_state_absent — a completed destroy', () => {
  it('passes on real post-destroy state: the file exists and manages nothing', async () => {
    const result = await check(withState(DESTROYED), {});
    expect(result.status).toBe('pass');
  });

  it('passes when the state manages nothing but still carries outputs', async () => {
    // Not the shape the CLI leaves, but a lab may target a state written by an
    // earlier step. Outputs describe values, not infrastructure.
    const result = await check(withState(state([], { note: { value: 'kept', type: 'string' } })), {});
    expect(result.status).toBe('pass');
  });

  it('passes when only data sources remain — a data source manages nothing', async () => {
    const result = await check(withState(state([dataSource('local_file', 'read_a')])), {});
    expect(result.status).toBe('pass');
  });

  it('passes when a resource is declared but holds no instance', async () => {
    const result = await check(withState(state([managed('local_file', 'gone', 0)])), {});
    expect(result.status).toBe('pass');
  });
});

// ------------------------------------------------------- something remains

describe('terraform_state_absent — infrastructure still exists', () => {
  it('fails on one remaining managed resource, and says so without quoting state', async () => {
    const result = await check(withState(state([managed('local_file', 'report')])), {});
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('still contains 1 managed resource instance');
    expect(result.detail).toContain('local_file.report');
  });

  it('fails on a partially destroyed state and counts every instance', async () => {
    const result = await check(
      withState(state([managed('local_file', 'a'), managed('local_file', 'b', 3)])),
      {},
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('4 managed resource instances');
  });

  it('counts a deposed instance — a failed replacement is still a real object', async () => {
    const deposed = {
      mode: 'managed',
      type: 'local_file',
      name: 'report',
      instances: [{ schema_version: 0, status: 'deposed', deposed: 'abc12345' }],
    };
    const result = await check(withState(state([deposed])), {});
    expect(result.status).toBe('fail');
  });

  it('ignores data sources when deciding, but still fails for the managed one', async () => {
    const result = await check(
      withState(state([dataSource('local_file', 'read_a'), managed('local_file', 'report')])),
      {},
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('local_file.report');
    expect(result.detail).not.toContain('read_a');
  });

  it('bounds how many addresses a failure lists', async () => {
    const many = Array.from({ length: 9 }, (_, i) => managed('local_file', `r${i}`));
    const result = await check(withState(state(many)), {});
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('and 4 more');
  });
});

// ------------------------------------------------------------ one address

describe('terraform_state_absent — a single address', () => {
  it('passes when that address is gone but others remain', async () => {
    const result = await check(withState(state([managed('local_file', 'kept')])), {
      address: 'local_file.removed',
    });
    expect(result.status).toBe('pass');
  });

  it('fails while that address is still in state', async () => {
    const result = await check(withState(state([managed('local_file', 'report')])), {
      address: 'local_file.report',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('local_file.report');
  });

  it('does not confuse a data source with the managed address of the same name', async () => {
    const result = await check(withState(state([dataSource('local_file', 'report')])), {
      address: 'local_file.report',
    });
    expect(result.status).toBe('pass');
  });
});

// ------------------------------------------------- the shortcuts it refuses

describe('terraform_state_absent — refuses the shortcuts', () => {
  it('FAILS when the state file was deleted, because a destroy leaves one behind', async () => {
    const result = await check({ terraform: { type: 'directory', mode: '755' } }, {});
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('a completed destroy leaves its state file behind');
  });

  it('fails on an empty state file rather than reading it as "nothing managed"', async () => {
    const result = await check(withState(''), {});
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('empty or malformed');
  });

  it('fails safely on malformed state, without echoing what it could not parse', async () => {
    const junk = '{"version":4,"resources":[ this is not json';
    const result = await check(withState(junk), {});
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('empty or malformed');
    expect(result.detail).not.toContain('not json');
  });

  it('fails when the state path is a directory rather than a file', async () => {
    const result = await check(
      { terraform: { type: 'directory', mode: '755' }, [STATE]: { type: 'directory', mode: '755' } },
      {},
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not a regular file');
  });

  it('is not satisfied by a student-written evidence file claiming success', async () => {
    const result = await check(
      {
        terraform: { type: 'directory', mode: '755' },
        'terraform/DESTROYED.txt': { type: 'file', content: 'all resources destroyed' },
        [STATE]: { type: 'file', content: state([managed('local_file', 'report')]) },
      },
      {},
    );
    expect(result.status).toBe('fail');
  });

  it('grades the state file the lab names, so renaming state to hide it cannot pass', async () => {
    // The student moved state aside; the lab still looks where it said it would.
    const result = await check(
      {
        terraform: { type: 'directory', mode: '755' },
        'terraform/terraform.tfstate.hidden': { type: 'file', content: state([managed('local_file', 'r')]) },
      },
      {},
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('a completed destroy leaves its state file behind');
  });

  it('reads the alternate state file when the lab names one', async () => {
    const sandbox = new FakeSandbox({
      files: {
        terraform: { type: 'directory', mode: '755' },
        'terraform/prod.tfstate': { type: 'file', content: DESTROYED },
        // The default path still holds live resources; naming prod.tfstate must
        // not silently grade this one instead.
        [STATE]: { type: 'file', content: state([managed('local_file', 'live')]) },
      } as never,
    });
    const result = await verifyRequirement(
      { type: 'terraform_state_absent', dir: DIR, state_file: 'prod.tfstate' } as never,
      new SandboxReader(sandbox),
    );
    expect(result.status).toBe('pass');
    expect(sandbox.reads).toContain('terraform/prod.tfstate');
  });
});

// ------------------------------------------------------------------ secrets

describe('terraform_state_absent — never leaks state contents', () => {
  const SECRET = 'NOT-A-REAL-SECRET-placeholder';

  it('does not echo attribute values from remaining resources', async () => {
    const withSecret = {
      mode: 'managed',
      type: 'local_file',
      name: 'credentials',
      instances: [{ schema_version: 0, attributes: { content: SECRET, filename: 'creds.txt' } }],
    };
    const result = await check(withState(state([withSecret])), {});
    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain(SECRET);
    // The address is fair game; the value is not.
    expect(result.detail).toContain('local_file.credentials');
  });

  it('does not echo sensitive output values', async () => {
    const outputs = { db_password: { value: SECRET, type: 'string', sensitive: true } };
    const result = await check(withState(state([managed('local_file', 'r')], outputs)), {});
    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain(SECRET);
  });

  it('does not echo state contents when the document is unparseable', async () => {
    const result = await check(withState(`{"oops": "${SECRET}"`), {});
    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain(SECRET);
  });
});

// -------------------------------------------------------------- reader scope

describe('terraform_state_absent — cannot reach outside its own sandbox', () => {
  it('reads only paths under the working directory the lab named', async () => {
    const sandbox = new FakeSandbox({ files: withState(DESTROYED) as never });
    await verifyRequirement(
      { type: 'terraform_state_absent', dir: DIR } as never,
      new SandboxReader(sandbox),
    );
    for (const read of sandbox.reads) expect(read.startsWith('terraform/')).toBe(true);
  });

  it('a second session’s reader sees only its own world, so one cannot pass for another', async () => {
    // Session A destroyed; session B did not. Same requirement, two readers.
    const a = new SandboxReader(new FakeSandbox({ files: withState(DESTROYED) as never }));
    const b = new SandboxReader(
      new FakeSandbox({ files: withState(state([managed('local_file', 'report')])) as never }),
    );
    const requirement = { type: 'terraform_state_absent', dir: DIR } as never;
    expect((await verifyRequirement(requirement, a)).status).toBe('pass');
    expect((await verifyRequirement(requirement, b)).status).toBe('fail');
  });
});
