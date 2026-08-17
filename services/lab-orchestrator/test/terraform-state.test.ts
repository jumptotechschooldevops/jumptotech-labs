/**
 * Terraform state parsing.
 *
 * The fixtures here are real `terraform.tfstate` documents produced by
 * Terraform 1.9.8 against the pinned providers, trimmed only of attributes the
 * platform never reads. Parsing invented JSON would prove nothing about
 * whether a student's actual state can be graded.
 */
import { describe, expect, it } from 'vitest';
import {
  attributeMatches,
  countInstancesOfType,
  describeValue,
  findResource,
  listStateAddresses,
  parseTerraformState,
  readAttributePath,
  resourceAddress,
  resourcesOfType,
  stateContainsAddress,
  TerraformStateParseError,
} from '../src/index.js';

/** Captured from an actual `terraform apply` in the pinned sandbox image. */
const REAL_STATE = JSON.stringify({
  version: 4,
  terraform_version: '1.9.8',
  serial: 1,
  lineage: '19163dad-ba9a-4a0a-230c-66fc12b51cd1',
  outputs: {
    settings_path: { value: 'settings.json', type: 'string' },
    audit_policy_path: { value: 'audit-prod.json', type: 'string' },
    api_token: { value: 'never-read', type: 'string', sensitive: true },
  },
  resources: [
    {
      mode: 'managed',
      type: 'local_file',
      name: 'settings',
      provider: 'provider["registry.terraform.io/hashicorp/local"]',
      instances: [
        {
          schema_version: 0,
          attributes: {
            content: '{"environment":"prod","service":"ledger-api"}',
            filename: 'settings.json',
            file_permission: '0777',
            id: 'a20b8c8de25b1db4a87a6cc3201b52971175bc6b',
          },
        },
      ],
    },
    {
      module: 'module.audit',
      mode: 'managed',
      type: 'local_file',
      name: 'audit_policy',
      provider: 'provider["registry.terraform.io/hashicorp/local"]',
      instances: [
        {
          attributes: {
            content: '{"environment":"prod","retention_days":30}',
            filename: 'audit-prod.json',
          },
        },
      ],
    },
    {
      mode: 'data',
      type: 'local_file',
      name: 'platform',
      provider: 'provider["registry.terraform.io/hashicorp/local"]',
      instances: [{ attributes: { content: '{"tier":"core"}', filename: 'platform.json' } }],
    },
    {
      mode: 'managed',
      type: 'random_integer',
      name: 'service_port',
      provider: 'provider["registry.terraform.io/hashicorp/random"]',
      instances: [{ attributes: { id: '8443', max: 9000, min: 8000, result: 8443, seed: null } }],
    },
    {
      mode: 'managed',
      type: 'local_file',
      name: 'shard',
      provider: 'provider["registry.terraform.io/hashicorp/local"]',
      instances: [
        { index_key: 0, attributes: { filename: 'shard-0.txt', content: 'a' } },
        { index_key: 1, attributes: { filename: 'shard-1.txt', content: 'b' } },
      ],
    },
    {
      mode: 'managed',
      type: 'null_resource',
      name: 'smoke_test',
      provider: 'provider["registry.terraform.io/hashicorp/null"]',
      instances: [{ attributes: { id: '123', triggers: { environment_id: 'calm-lion' } } }],
    },
  ],
});

const state = parseTerraformState(REAL_STATE);

describe('terraform state — parsing a real state document', () => {
  it('reads the version and the Terraform that wrote it', () => {
    expect(state.version).toBe(4);
    expect(state.terraformVersion).toBe('1.9.8');
    expect(state.serial).toBe(1);
  });

  it('reads outputs, carrying the sensitive marking rather than dropping it', () => {
    expect(state.outputs.settings_path).toEqual({ value: 'settings.json', sensitive: false });
    expect(state.outputs.api_token?.sensitive).toBe(true);
  });

  it('separates managed resources from data sources', () => {
    expect(findResource(state, { type: 'local_file', name: 'settings' })?.mode).toBe('managed');
    expect(findResource(state, { type: 'local_file', name: 'platform' })).toBeNull();
    expect(findResource(state, { type: 'local_file', name: 'platform', mode: 'data' })).not.toBeNull();
  });

  it('treats a workspace with no state as empty rather than as an error', () => {
    expect(parseTerraformState('')).toMatchObject({ outputs: {}, resources: [] });
  });

  it('rejects a state format it cannot read, instead of guessing', () => {
    expect(() => parseTerraformState('{"version": 3}')).toThrow(TerraformStateParseError);
    expect(() => parseTerraformState('not json')).toThrow(/not valid JSON/);
  });
});

describe('terraform state — resource addressing', () => {
  it('renders addresses the way terraform state list does', () => {
    expect(listStateAddresses(state)).toEqual([
      'data.local_file.platform',
      'local_file.settings',
      'local_file.shard[0]',
      'local_file.shard[1]',
      'module.audit.local_file.audit_policy',
      'null_resource.smoke_test',
      'random_integer.service_port',
    ]);
  });

  it('quotes a for_each key and leaves a count index bare', () => {
    expect(resourceAddress({ module: '', mode: 'managed', type: 'local_file', name: 'x' }, 2)).toBe(
      'local_file.x[2]',
    );
    expect(
      resourceAddress({ module: '', mode: 'managed', type: 'local_file', name: 'x' }, 'eu'),
    ).toBe('local_file.x["eu"]');
  });

  it('matches a bare address against any instance of a counted resource', () => {
    expect(stateContainsAddress(state, 'local_file.shard')).toBe(true);
    expect(stateContainsAddress(state, 'local_file.shard[1]')).toBe(true);
    // An explicit index that does not exist must not be satisfied by a sibling.
    expect(stateContainsAddress(state, 'local_file.shard[7]')).toBe(false);
  });

  it('matches inside a module', () => {
    expect(stateContainsAddress(state, 'module.audit.local_file.audit_policy')).toBe(true);
    expect(stateContainsAddress(state, 'local_file.audit_policy')).toBe(false);
  });

  it('does not confuse a data source with a managed resource of the same name', () => {
    expect(stateContainsAddress(state, 'data.local_file.platform')).toBe(true);
    expect(stateContainsAddress(state, 'local_file.platform')).toBe(false);
  });

  it('finds a resource inside a module by either module spelling', () => {
    expect(findResource(state, { type: 'local_file', name: 'audit_policy', module: 'audit' })).not.toBeNull();
    expect(
      findResource(state, { type: 'local_file', name: 'audit_policy', module: 'module.audit' }),
    ).not.toBeNull();
    // Without a module, the lookup is scoped to the root — it must not reach in.
    expect(findResource(state, { type: 'local_file', name: 'audit_policy' })).toBeNull();
  });

  it('counts instances across modules', () => {
    // settings + audit_policy + shard[0] + shard[1] = 4 managed local_file
    // instances; the data source is not one of them.
    expect(countInstancesOfType(state, 'local_file')).toBe(4);
    expect(resourcesOfType(state, 'local_file')).toHaveLength(3);
    expect(countInstancesOfType(state, 'aws_instance')).toBe(0);
  });
});

describe('terraform state — attribute paths', () => {
  const settings = findResource(state, { type: 'local_file', name: 'settings' })!;
  const attributes = settings.instances[0]!.attributes;

  it('reads a top-level attribute', () => {
    expect(readAttributePath(attributes, 'filename')).toEqual({ found: true, value: 'settings.json' });
  });

  it('reads a nested map attribute', () => {
    const nullResource = findResource(state, { type: 'null_resource', name: 'smoke_test' })!;
    expect(
      readAttributePath(nullResource.instances[0]!.attributes, 'triggers.environment_id'),
    ).toEqual({ found: true, value: 'calm-lion' });
  });

  it('distinguishes an absent attribute from a null one', () => {
    expect(readAttributePath(attributes, 'nope').found).toBe(false);
    const port = findResource(state, { type: 'random_integer', name: 'service_port' })!;
    expect(readAttributePath(port.instances[0]!.attributes, 'seed')).toEqual({
      found: true,
      value: null,
    });
  });

  it('indexes into a list', () => {
    expect(readAttributePath({ tags: ['a', 'b'] }, 'tags.1')).toEqual({ found: true, value: 'b' });
    expect(readAttributePath({ tags: ['a'] }, 'tags.5').found).toBe(false);
  });
});

describe('terraform state — value comparison', () => {
  it('compares a number in state against a number from YAML', () => {
    expect(attributeMatches(8443, 8443)).toBe(true);
    // YAML routinely produces the string form; the provider stores a number.
    expect(attributeMatches(8443, '8443')).toBe(true);
    expect(attributeMatches(8444, 8443)).toBe(false);
  });

  it('compares booleans written either way', () => {
    expect(attributeMatches(true, true)).toBe(true);
    expect(attributeMatches(true, 'true')).toBe(true);
    expect(attributeMatches(false, true)).toBe(false);
  });

  it('never claims a match for an absent or structured value', () => {
    expect(attributeMatches(null, 'null')).toBe(false);
    expect(attributeMatches(undefined, '')).toBe(false);
    expect(attributeMatches({ a: 1 }, '[object Object]')).toBe(false);
  });

  it('renders an observed value for a message without dumping the world', () => {
    expect(describeValue(undefined)).toBe('absent');
    expect(describeValue(null)).toBe('null');
    expect(describeValue({ a: 1 })).toBe('{"a":1}');
    expect(describeValue('x'.repeat(400)).endsWith('…')).toBe(true);
  });
});
