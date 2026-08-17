/**
 * Terraform verification, across the whole TF-001…TF-010 vocabulary.
 *
 * These are the checks behind the Terraform track, exercised through the real
 * verification path: a lab definition, the requirement registry, and a
 * `SandboxPort` standing in for one session's container. The state documents
 * are the shapes `terraform apply` really writes (state format v4), so what the
 * handlers parse is what Terraform produces.
 *
 * Two properties are asserted throughout, because they are the point of
 * state-based verification:
 *
 *   - a failure explains what was *observed*, never what to type;
 *   - nothing verification does can modify the workspace it is grading — the
 *     only Terraform subcommands that ever reach the sandbox are `validate` and
 *     `fmt -check`, and the port offers no way to write anything at all.
 *
 * The real thing — a `docker exec` into a real container running real Terraform
 * — is exercised in `apps/api/test/sandbox-integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  parseLabDefinition,
  type ExecResult,
  type LabDefinition,
  type SandboxListOptions,
  type SandboxPathRead,
  type SandboxToolRequest,
} from '@jumptotech/lab-orchestrator';
import { verifyLab, type CheckResult, type SandboxPort } from '../src/index.js';

/** The lab's working directory, matching the shipped Terraform labs. */
const DIR = 'terraform';

/**
 * An in-memory sandbox: files, directories, and a Terraform CLI that answers
 * `validate` and `fmt` from what the test told it to say.
 */
class FakeSandbox implements SandboxPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  /** Every tool invocation, so a test can assert what was *not* run. */
  readonly toolCalls: SandboxToolRequest[] = [];

  /** When set, `terraform validate` reports this as an error diagnostic. */
  validateError: string | null = null;
  /** When non-empty, `terraform fmt -check` reports these files. */
  unformattedFiles: string[] = [];
  /** When set, the CLI is not reachable at all. */
  toolUnavailable = false;

  file(relative: string, contents: string): this {
    this.files.set(`${DIR}/${relative}`, contents);
    for (const parent of parents(`${DIR}/${relative}`)) this.directories.add(parent);
    return this;
  }

  directory(relative: string): this {
    this.directories.add(`${DIR}/${relative}`);
    for (const parent of parents(`${DIR}/${relative}`)) this.directories.add(parent);
    return this;
  }

  /** Mark the directory initialised, the way `terraform init` would. */
  initialised(): this {
    this.directory('.terraform');
    return this.file('.terraform.lock.hcl', '# lock');
  }

  state(document: unknown): this {
    return this.file('terraform.tfstate', JSON.stringify(document));
  }

  async read(relativePath: string): Promise<SandboxPathRead | null> {
    const content = this.files.get(relativePath);
    if (content !== undefined) {
      return {
        type: 'file',
        mode: '644',
        owner: 'student',
        group: 'student',
        sizeBytes: content.length,
        content,
      };
    }
    if (this.directories.has(relativePath)) {
      return { type: 'directory', mode: '755', owner: 'student', group: 'student', sizeBytes: 4096 };
    }
    return null;
  }

  async list(relativeDir: string, options: SandboxListOptions = {}): Promise<string[]> {
    const prefix = `${relativeDir.replace(/\/+$/, '')}/`;
    return [...this.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      // The provider's own `find` skips dot-directories; the fake must too, or
      // the test would prove the handler works on a listing it never gets.
      .filter((p) => !p.split('/').some((segment) => segment.startsWith('.')))
      .filter((p) => (options.suffix ? p.endsWith(options.suffix) : true))
      .sort();
  }

  async runTool(request: SandboxToolRequest): Promise<ExecResult> {
    this.toolCalls.push(request);
    if (this.toolUnavailable) {
      return { exitCode: 1, stdout: '', stderr: 'container is not running', timedOut: false };
    }
    if (request.args[0] === 'validate') {
      const diagnostics = this.validateError
        ? [{ severity: 'error', summary: this.validateError, range: { filename: 'main.tf' } }]
        : [];
      return {
        exitCode: this.validateError ? 1 : 0,
        stdout: JSON.stringify({ valid: !this.validateError, diagnostics }),
        stderr: '',
        timedOut: false,
      };
    }
    if (request.args[0] === 'fmt') {
      return {
        exitCode: this.unformattedFiles.length > 0 ? 3 : 0,
        stdout: this.unformattedFiles.join('\n'),
        stderr: '',
        timedOut: false,
      };
    }
    throw new Error(`unexpected tool invocation: ${request.args.join(' ')}`);
  }
}

/** A sandbox with no configuration listing and no CLI — e.g. a Linux sandbox. */
class ReadOnlySandbox implements SandboxPort {
  constructor(private readonly inner: FakeSandbox) {}
  read(relativePath: string): Promise<SandboxPathRead | null> {
    return this.inner.read(relativePath);
  }
}

function parents(filePath: string): string[] {
  const segments = filePath.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

/** Build a minimal Terraform lab around one or more requirements. */
function lab(requirements: string): LabDefinition {
  return parseLabDefinition(`
id: TF-900
slug: tf-900-fixture
title: Verifier Fixture
track: terraform
topic: fundamentals
difficulty: beginner
duration_minutes: 15
environment:
  provider: terraform
task:
  summary: Fixture.
  description: Fixture lab used by the Terraform verifier tests.
requirements:
${requirements}
references:
  - title: Terraform resources
    url: https://developer.hashicorp.com/terraform/language/resources/syntax
skills:
  - terraform.configuration.write
`);
}

async function check(sandbox: SandboxPort, requirements: string): Promise<CheckResult[]> {
  const result = await verifyLab({
    // A Terraform lab never reaches for the Kubernetes port; passing a value
    // that would throw if touched is the assertion that it does not.
    k8s: undefined,
    sandbox,
    lab: lab(requirements),
    namespace: 'lab-00000000test',
  });
  return result.checks;
}

async function one(sandbox: SandboxPort, requirement: string): Promise<CheckResult> {
  return (await check(sandbox, requirement))[0]!;
}

// The shape `terraform apply` writes: a root resource, a module resource, a
// generated integer, and four outputs — one of them sensitive.
const APPLIED_STATE = {
  version: 4,
  terraform_version: '1.9.8',
  serial: 1,
  outputs: {
    release_file: { value: 'release-notes.txt', type: 'string' },
    release_channel: { value: 'stable', type: 'string' },
    deployment_id: { value: 'calm-lion', type: 'string' },
    api_token: { value: 'do-not-read', type: 'string', sensitive: true },
  },
  resources: [
    {
      mode: 'managed',
      type: 'local_file',
      name: 'welcome',
      provider: 'provider["registry.terraform.io/hashicorp/local"]',
      instances: [
        {
          attributes: {
            content: 'JumpToTech Bank platform',
            filename: 'welcome.txt',
            id: 'a20b8c8de25b1db4a87a6cc3201b52971175bc6b',
          },
        },
      ],
    },
    {
      module: 'module.ledger',
      mode: 'managed',
      type: 'local_file',
      name: 'app_manifest',
      provider: 'provider["registry.terraform.io/hashicorp/local"]',
      instances: [{ attributes: { content: '{"app":"ledger"}', filename: 'ledger-prod.json' } }],
    },
    {
      mode: 'managed',
      type: 'random_integer',
      name: 'service_port',
      provider: 'provider["registry.terraform.io/hashicorp/random"]',
      instances: [{ attributes: { id: '8443', max: 9000, min: 8000, result: 8443 } }],
    },
  ],
};

// --------------------------------------------------- a correct solution passes

describe('terraform verifier — a correct solution passes', () => {
  it('passes every check for a completed workspace', async () => {
    const sandbox = new FakeSandbox()
      .initialised()
      .file('main.tf', 'resource "local_file" "welcome" {\n  filename = "welcome.txt"\n}\n')
      .file('welcome.txt', 'JumpToTech Bank platform')
      .state(APPLIED_STATE);

    const checks = await check(
      sandbox,
      `
  - type: terraform_initialized
    dir: terraform
    label: The working directory is initialised
  - type: terraform_valid
    dir: terraform
    label: The configuration is valid
  - type: terraform_formatted
    dir: terraform
    label: The configuration is canonically formatted
  - type: file_exists
    path: terraform/main.tf
    label: main.tf exists
  - type: terraform_state_contains
    dir: terraform
    address: local_file.welcome
    label: Terraform manages the welcome file
  - type: terraform_resource_attribute
    dir: terraform
    resource_type: local_file
    name: welcome
    attribute: content
    equals: JumpToTech Bank platform
    label: The file content is correct
  - type: file_exists
    path: terraform/welcome.txt
    label: welcome.txt was created
`,
    );

    expect(
      checks.every((c) => c.status === 'pass'),
      JSON.stringify(checks, null, 1),
    ).toBe(true);
  });
});

// ------------------------------------------------- an incorrect solution fails

describe('terraform verifier — an incorrect solution fails', () => {
  it('fails an uninitialised directory and names what is missing', async () => {
    const sandbox = new FakeSandbox().directory('.');

    const result = await one(
      sandbox,
      '  - type: terraform_initialized\n    dir: terraform\n    label: Initialised\n',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('.terraform');
  });

  it('fails when init ran but the lock file is absent', async () => {
    const sandbox = new FakeSandbox().directory('.terraform');

    const result = await one(
      sandbox,
      '  - type: terraform_initialized\n    dir: terraform\n    label: Initialised\n',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('.terraform.lock.hcl');
  });

  it('fails an invalid configuration and reports the diagnostic', async () => {
    const sandbox = new FakeSandbox();
    sandbox.validateError = 'Reference to undeclared input variable';

    const result = await one(
      sandbox,
      '  - type: terraform_valid\n    dir: terraform\n    label: Valid\n',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Reference to undeclared input variable');
  });

  it('fails an unformatted configuration and names the files', async () => {
    const sandbox = new FakeSandbox();
    sandbox.unformattedFiles = ['main.tf', 'modules/audit/main.tf'];

    const result = await one(
      sandbox,
      '  - type: terraform_formatted\n    dir: terraform\n    label: Formatted\n',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('main.tf');
    expect(result.detail).toContain('2 files');
  });

  it('says "nothing applied yet" rather than "wrong" when there is no state', async () => {
    const result = await one(
      new FakeSandbox(),
      '  - type: terraform_state_contains\n    dir: terraform\n    address: local_file.welcome\n    label: Managed\n',
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('nothing has been applied');
  });

  it('reports a corrupt state file as unreadable rather than as a removal', async () => {
    const sandbox = new FakeSandbox().file('terraform.tfstate', '{ this is not json');

    const contains = await one(
      sandbox,
      '  - type: terraform_state_contains\n    dir: terraform\n    address: local_file.welcome\n    label: Managed\n',
    );
    expect(contains.status).toBe('fail');
    expect(contains.detail).toContain('No readable Terraform state');

    // A state file nobody can parse is not evidence that something was removed.
    const absent = await one(
      sandbox,
      '  - type: terraform_state_absent\n    dir: terraform\n    address: local_file.welcome\n    label: Removed\n',
    );
    expect(absent.status).toBe('fail');
    expect(absent.detail).toContain('not valid JSON');
  });

  it('never reveals the solution — only the observed state', async () => {
    const sandbox = new FakeSandbox().state(APPLIED_STATE);

    const checks = await check(
      sandbox,
      `
  - type: terraform_state_contains
    dir: terraform
    address: local_file.missing
    label: A resource that is not there
  - type: terraform_output_exists
    dir: terraform
    name: not_declared
    label: An output that is not there
`,
    );

    for (const result of checks) {
      expect(result.status).toBe('fail');
      // Failure text describes the workspace, never an instruction to write.
      expect(result.detail).not.toMatch(/\bresource "\w+"/);
      expect(result.detail).not.toMatch(/\byou should\b|\badd\b|\bwrite\b/i);
    }
    // It does say what *is* there, which is the useful half.
    expect(checks[0]!.detail).toContain('local_file.welcome');
    expect(checks[1]!.detail).toContain('release_file');
  });
});

// ------------------------------------------------------------ state checks

describe('terraform verifier — state verification', () => {
  const applied = () => new FakeSandbox().state(APPLIED_STATE);

  it('finds a resource by address, in the root and in a module', async () => {
    const checks = await check(
      applied(),
      `
  - type: terraform_state_contains
    dir: terraform
    address: local_file.welcome
    label: Root resource is managed
  - type: terraform_state_contains
    dir: terraform
    address: module.ledger.local_file.app_manifest
    label: Module resource is managed
  - type: terraform_state_contains
    dir: terraform
    address: random_integer.service_port
    label: Port is managed
`,
    );
    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('checks that something was removed from state', async () => {
    const checks = await check(
      applied(),
      `
  - type: terraform_state_absent
    dir: terraform
    address: local_file.legacy_config
    label: The legacy file is gone
  - type: terraform_state_absent
    dir: terraform
    address: local_file.welcome
    label: The welcome file is gone
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    expect(checks[1]!.detail).toContain('still in the Terraform state');
  });

  it('counts instances of a resource type', async () => {
    const checks = await check(
      applied(),
      `
  - type: terraform_resource_count
    dir: terraform
    resource_type: local_file
    count: 2
    label: Two file resources are managed
  - type: terraform_resource_count
    dir: terraform
    resource_type: local_file
    count: 5
    label: Five file resources are managed
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    expect(checks[1]!.detail).toContain('State holds 2');
  });

  it('reads a numeric attribute, comparing across YAML and provider typing', async () => {
    const checks = await check(
      applied(),
      `
  - type: terraform_resource_attribute
    dir: terraform
    resource_type: random_integer
    name: service_port
    attribute: result
    equals: 8443
    label: The adopted port is 8443
  - type: terraform_resource_attribute
    dir: terraform
    resource_type: random_integer
    name: service_port
    attribute: result
    equals: 9999
    label: The port is 9999
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
  });

  it('supports a substring match for generated content', async () => {
    const result = await one(
      applied(),
      `
  - type: terraform_resource_attribute
    dir: terraform
    resource_type: local_file
    name: app_manifest
    module: ledger
    attribute: content
    contains: '"app":"ledger"'
    label: The manifest names the app
`,
    );
    expect(result.status).toBe('pass');
  });

  it('does not find a module resource when the root is searched', async () => {
    const result = await one(
      applied(),
      `
  - type: terraform_resource_exists
    dir: terraform
    resource_type: local_file
    name: app_manifest
    label: Manifest is managed in the root
`,
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('the root module');
  });
});

// ----------------------------------------------------------- output checks

describe('terraform verifier — output verification', () => {
  const applied = () => new FakeSandbox().state(APPLIED_STATE);

  it('checks that an output exists', async () => {
    const checks = await check(
      applied(),
      `
  - type: terraform_output_exists
    dir: terraform
    name: deployment_id
    label: The deployment id is published
  - type: terraform_output_exists
    dir: terraform
    name: nope
    label: A missing output
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    expect(checks[1]!.detail).toContain('release_file');
  });

  it('checks an output value without revealing the expected one', async () => {
    const checks = await check(
      applied(),
      `
  - type: terraform_output_equals
    dir: terraform
    name: release_file
    value: release-notes.txt
    label: The release file is published
  - type: terraform_output_equals
    dir: terraform
    name: release_channel
    value: beta
    label: The channel is beta
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    expect(checks[1]!.detail).toBe("Output 'release_channel' is 'stable'");
    expect(checks[1]!.detail).not.toContain('beta');
  });

  it('refuses to read a sensitive output rather than comparing a secret', async () => {
    const result = await one(
      applied(),
      `
  - type: terraform_output_equals
    dir: terraform
    name: api_token
    value: do-not-read
    label: The token matches
`,
    );

    // The value in state *would* match. The platform declines to look, because
    // a lab that compared a secret would be a lab that made the platform hold
    // one — the same rule `secret_key` follows on the Kubernetes track.
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('marked sensitive');
    expect(result.detail).not.toContain('do-not-read');
  });
});

// ----------------------------------------------------------- module checks

describe('terraform verifier — module verification', () => {
  const ROOT_MAIN = `
module "ledger" {
  source   = "./modules/application"
  app_name = "ledger"
}

module "accounts" {
  source      = "./modules/application"
  app_name    = "accounts"
  environment = "staging"
}
`;

  const withModules = () =>
    new FakeSandbox()
      .state(APPLIED_STATE)
      .file('main.tf', ROOT_MAIN)
      .directory('modules/application')
      .file('modules/application/main.tf', 'resource "local_file" "app_manifest" {}\n');

  it('requires the module to be both called and present on disk', async () => {
    const checks = await check(
      withModules(),
      `
  - type: terraform_module_exists
    dir: terraform
    name: ledger
    source: ./modules/application
    label: The ledger module is defined and used
  - type: directory_exists
    path: terraform/modules/application
    label: The module directory exists
`,
    );
    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass']);
  });

  it('fails when the module is called but its directory does not exist', async () => {
    const sandbox = new FakeSandbox().file(
      'main.tf',
      'module "ghost" {\n  source = "./modules/ghost"\n}\n',
    );

    const result = await one(
      sandbox,
      '  - type: terraform_module_exists\n    dir: terraform\n    name: ghost\n    label: The ghost module\n',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('does not exist');
  });

  it('fails when the directory exists but nothing calls it', async () => {
    const sandbox = withModules().file('main.tf', '# nothing here yet\n');

    const result = await one(
      sandbox,
      '  - type: terraform_module_exists\n    dir: terraform\n    name: ledger\n    label: The ledger module\n',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('calls no modules');
  });

  it('fails a module whose source is not the expected one', async () => {
    const result = await one(
      withModules(),
      `
  - type: terraform_module_exists
    dir: terraform
    name: ledger
    source: ./modules/other
    label: The ledger module
`,
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('./modules/application');
  });

  it('checks the inputs a module call passes', async () => {
    const checks = await check(
      withModules(),
      `
  - type: terraform_module_input
    dir: terraform
    module: accounts
    input: environment
    label: The accounts call overrides the environment
  - type: terraform_module_input
    dir: terraform
    module: ledger
    input: environment
    label: The ledger call overrides the environment
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    // The message lists what *was* passed, excluding `source`, which is not an
    // input variable.
    expect(checks[1]!.detail).toContain('app_name');
    expect(checks[1]!.detail).not.toContain('source');
  });

  it('finds resources created inside a module', async () => {
    const checks = await check(
      withModules(),
      `
  - type: terraform_resource_exists
    dir: terraform
    resource_type: local_file
    name: app_manifest
    module: ledger
    label: The ledger module created its manifest
  - type: terraform_resource_exists
    dir: terraform
    resource_type: local_file
    name: app_manifest
    module: accounts
    label: The accounts module created its manifest
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
  });
});

// ---------------------------------------------------- configuration checks

describe('terraform verifier — configuration checks', () => {
  it('checks variable declarations, including whether a default exists', async () => {
    const sandbox = new FakeSandbox().file(
      'variables.tf',
      `
variable "environment" {
  type    = string
  default = "dev"
}

variable "service_name" {
  type = string
}
`,
    );

    const checks = await check(
      sandbox,
      `
  - type: terraform_variable_declared
    dir: terraform
    name: environment
    has_type: true
    has_default: true
    label: environment has a type and a default
  - type: terraform_variable_declared
    dir: terraform
    name: service_name
    has_type: true
    has_default: false
    label: service_name has a type and no default
  - type: terraform_variable_declared
    dir: terraform
    name: environment
    has_default: false
    label: environment has no default
  - type: terraform_variable_declared
    dir: terraform
    name: missing
    label: A variable that is not declared
`,
    );

    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass', 'fail', 'fail']);
    expect(checks[2]!.detail).toContain('declares a default value');
    expect(checks[3]!.detail).toContain('environment, service_name');
  });

  it('checks locals across several blocks', async () => {
    const sandbox = new FakeSandbox()
      .file('locals.tf', 'locals {\n  a = 1\n  b = 2\n}\n')
      .file('more.tf', 'locals {\n  c = 3\n}\n');

    const checks = await check(
      sandbox,
      `
  - type: terraform_locals_declared
    dir: terraform
    names: [a, b, c]
    label: All three locals are defined
  - type: terraform_locals_declared
    dir: terraform
    names: [a, d]
    label: a and d are defined
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    expect(checks[1]!.detail).toContain("'d'");
  });

  it('checks a data source declaration', async () => {
    const sandbox = new FakeSandbox().file(
      'data.tf',
      'data "local_file" "platform" {\n  filename = "platform.json"\n}\n',
    );

    const checks = await check(
      sandbox,
      `
  - type: terraform_data_source_declared
    dir: terraform
    data_type: local_file
    name: platform
    label: The platform data source is declared
  - type: terraform_data_source_declared
    dir: terraform
    data_type: local_file
    name: other
    label: Another data source
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    expect(checks[1]!.detail).toContain('local_file.platform');
  });

  it('checks lifecycle rules of all three shapes', async () => {
    const sandbox = new FakeSandbox().file(
      'main.tf',
      `
resource "local_file" "audit_log" {
  filename = "audit.log"

  lifecycle {
    prevent_destroy = true
  }
}

resource "random_pet" "release" {
  lifecycle {
    create_before_destroy = true
  }
}

resource "null_resource" "config_watch" {
  triggers = {
    channel = var.release_channel
  }

  lifecycle {
    ignore_changes = [triggers]
  }
}

resource "local_file" "plain" {
  filename = "plain.txt"
}
`,
    );

    const checks = await check(
      sandbox,
      `
  - type: terraform_resource_lifecycle
    dir: terraform
    resource_type: local_file
    name: audit_log
    setting: prevent_destroy
    label: The audit log is protected
  - type: terraform_resource_lifecycle
    dir: terraform
    resource_type: random_pet
    name: release
    setting: create_before_destroy
    label: The release is replaced without a gap
  - type: terraform_resource_lifecycle
    dir: terraform
    resource_type: null_resource
    name: config_watch
    setting: ignore_changes
    attributes: [triggers]
    label: Trigger changes are ignored
  - type: terraform_resource_lifecycle
    dir: terraform
    resource_type: local_file
    name: plain
    setting: prevent_destroy
    label: The plain file is protected
  - type: terraform_resource_lifecycle
    dir: terraform
    resource_type: local_file
    name: audit_log
    setting: create_before_destroy
    label: The audit log is replaced without a gap
  - type: terraform_resource_lifecycle
    dir: terraform
    resource_type: null_resource
    name: config_watch
    setting: ignore_changes
    attributes: [filename]
    label: Filename changes are ignored
`,
    );

    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'fail', 'fail', 'fail']);
    expect(checks[3]!.detail).toContain('no lifecycle block');
    expect(checks[4]!.detail).toContain('does not set');
    expect(checks[5]!.detail).toContain('does not mention filename');
  });

  it('reports an expression it cannot evaluate rather than guessing at it', async () => {
    const sandbox = new FakeSandbox().file(
      'main.tf',
      'resource "local_file" "x" {\n  lifecycle {\n    prevent_destroy = var.protect\n  }\n}\n',
    );

    const result = await one(
      sandbox,
      `
  - type: terraform_resource_lifecycle
    dir: terraform
    resource_type: local_file
    name: x
    setting: prevent_destroy
    label: x is protected
`,
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not a literal true or false');
  });

  it('ignores .tf files inside the provider cache', async () => {
    const sandbox = new FakeSandbox()
      .file('main.tf', 'variable "real" { type = string }')
      .file('.terraform/modules/vendored/main.tf', 'variable "vendored" { type = string }');

    const checks = await check(
      sandbox,
      `
  - type: terraform_variable_declared
    dir: terraform
    name: real
    label: The real variable is declared
  - type: terraform_variable_declared
    dir: terraform
    name: vendored
    label: A variable from the provider cache
`,
    );
    expect(checks[0]!.status).toBe('pass');
    // Downloaded module sources are not the student's configuration.
    expect(checks[1]!.status).toBe('fail');
  });
});

// ----------------------------------------------------------- filesystem

describe('terraform verifier — filesystem checks', () => {
  it('checks that an artefact was removed', async () => {
    const sandbox = new FakeSandbox().file('accounts.json', '{}');

    const checks = await check(
      sandbox,
      `
  - type: file_absent
    path: terraform/legacy-config.txt
    label: The legacy file was removed
  - type: file_absent
    path: terraform/accounts.json
    label: The accounts file was removed
`,
    );
    expect(checks[0]!.status).toBe('pass');
    expect(checks[1]!.status).toBe('fail');
    expect(checks[1]!.detail).toContain('still exists');
  });
});

// ------------------------------------------------------------- read-only

describe('terraform verifier — verification cannot change the workspace', () => {
  it('never runs a Terraform subcommand that could modify state', async () => {
    const sandbox = new FakeSandbox()
      .initialised()
      .state(APPLIED_STATE)
      .file('main.tf', 'resource "local_file" "welcome" {}');
    const before = JSON.stringify([...sandbox.files.entries()].sort());

    await check(
      sandbox,
      `
  - type: terraform_initialized
    dir: terraform
    label: Initialised
  - type: terraform_valid
    dir: terraform
    label: Valid
  - type: terraform_formatted
    dir: terraform
    label: Formatted
  - type: terraform_state_contains
    dir: terraform
    address: local_file.welcome
    label: Managed
  - type: terraform_variable_declared
    dir: terraform
    name: anything
    label: A variable
  - type: file_exists
    path: terraform/main.tf
    label: main.tf exists
`,
    );

    expect(sandbox.toolCalls.every((call) => call.tool === 'terraform')).toBe(true);
    expect(new Set(sandbox.toolCalls.map((call) => call.args[0]))).toEqual(
      new Set(['validate', 'fmt']),
    );
    // Every invocation is a read: no apply, destroy, init, plan or state write.
    expect(JSON.stringify([...sandbox.files.entries()].sort())).toBe(before);
  });

  it('reads each file once, however many checks ask about it', async () => {
    const sandbox = new FakeSandbox().state(APPLIED_STATE);
    let reads = 0;
    const counting: SandboxPort = {
      read: (path) => {
        reads += 1;
        return sandbox.read(path);
      },
    };

    await check(
      counting,
      `
  - type: terraform_state_contains
    dir: terraform
    address: local_file.welcome
    label: Managed
  - type: terraform_output_exists
    dir: terraform
    name: release_file
    label: Published
  - type: terraform_resource_count
    dir: terraform
    resource_type: local_file
    count: 2
    label: Two files
`,
    );

    // One `terraform.tfstate` read, shared by all three checks: three questions
    // about one moment cannot produce a self-contradictory report.
    expect(reads).toBe(1);
  });
});

// ------------------------------------------------- providers without the port

describe('terraform verifier — a sandbox that cannot answer', () => {
  it('skips, rather than fails, when the provider cannot run Terraform', async () => {
    const sandbox = new ReadOnlySandbox(new FakeSandbox().state(APPLIED_STATE));

    const checks = await check(
      sandbox,
      `
  - type: terraform_valid
    dir: terraform
    label: Valid
  - type: terraform_variable_declared
    dir: terraform
    name: environment
    label: environment is declared
  - type: terraform_state_contains
    dir: terraform
    address: local_file.welcome
    label: Managed
`,
    );

    // A platform that cannot look has learned nothing about the student's work.
    expect(checks[0]!.status).toBe('skipped');
    expect(checks[0]!.detail).toContain('run Terraform commands');
    expect(checks[1]!.status).toBe('skipped');
    // The state read needs no capability beyond a file read, so it still runs.
    expect(checks[2]!.status).toBe('pass');
  });
});
