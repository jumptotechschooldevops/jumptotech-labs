/**
 * PLATFORM-SEC — an expected value must not leave the server.
 *
 * The handler-level fence lives in the verifier suite: a failing check no
 * longer repeats what it found. This file covers the other two halves of the
 * same guarantee, which are properties of the *platform* rather than of any
 * handler:
 *
 *   · the catalog API projects a requirement to its label, never its fields,
 *     so the value a lab is graded against never reaches the browser at all;
 *   · nothing on the setup path copies a requirement into the sandbox, so the
 *     answer is not sitting in a file the student can read.
 *
 * Both are true today by construction rather than by care, which is exactly
 * the kind of property that decays silently. These tests are here so that a
 * future projection change — adding `...requirement` to a payload, say — fails
 * loudly instead of quietly publishing every answer in the curriculum.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
  loadSetupFiles,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';
const LABS_DIR = path.join(repoRoot, 'labs');

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(LABS_DIR);
  await registry.load();
});

function buildApp() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR,
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);
  const provider = new KindLabProvider({
    k8s: new FakeKubernetes(),
    clusterName: 'jumptotech-labs',
    sleep: async () => undefined,
    waitForRequirements: async () => ({ ok: true, checks: [] }),
  });
  provider.execute = async () => ({ exitCode: 0, stdout: '{}', stderr: '', timedOut: false });
  const k8s = new FakeKubernetes();
  const sessions = new SessionManager({
    registry,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });
  return createApp({ registry, sessions, k8s, config });
}

/** Every value any shipped lab is graded against. */
function expectedValues(): Array<{ labId: string; value: string }> {
  const values: Array<{ labId: string; value: string }> = [];
  for (const summary of registry.list()) {
    for (const requirement of registry.get(summary.id).requirements) {
      for (const field of ['value', 'contains', 'equals'] as const) {
        const candidate = (requirement as Record<string, unknown>)[field];
        if (typeof candidate === 'string' && candidate.length >= 4) {
          values.push({ labId: summary.id, value: candidate });
        }
      }
    }
  }
  return values;
}

describe('PLATFORM-SEC — expected values stay on the server', () => {
  it('has expectations to protect, so this suite is not vacuously true', () => {
    expect(expectedValues().length).toBeGreaterThan(10);
  });

  it('never restates a graded output value in a check label', async () => {
    // A label *is* published — it is the student-facing checklist. So for the
    // requirement type whose values are the sensitive class, the label must not
    // repeat the value it grades, or the answer ships with the lab page.
    //
    // Scoped to `terraform_output_equals` on purpose. Other tracks legitimately
    // restate values their own brief already gave the student: DOCKER-007's
    // label reads "LEDGER_REGION is set to eu-west-1" for a task that tells
    // them to set exactly that. Instructing is not disclosing.
    for (const summary of registry.list()) {
      for (const requirement of registry.get(summary.id).requirements) {
        if (requirement.type !== 'terraform_output_equals') continue;
        const value = (requirement as Record<string, unknown>).value;
        const label = (requirement as Record<string, unknown>).label;
        if (typeof value !== 'string' || typeof label !== 'string') continue;
        expect(
          label.includes(value),
          `${summary.id} puts the expected output value in a published check label`,
        ).toBe(false);
      }
    }
  });

  it('projects requirements to their label or type, and nothing else', async () => {
    const response = await request(buildApp()).get('/api/labs/TF-001');
    expect(response.status).toBe(200);
    const requirements = response.body.data.requirements as unknown[];
    // Strings, not objects: an object could carry `value` in a later refactor,
    // which is the regression this whole file exists to catch.
    expect(requirements.length).toBeGreaterThan(0);
    for (const entry of requirements) expect(typeof entry).toBe('string');
  });

  it('ships no requirement objects in the catalog listing', async () => {
    const response = await request(buildApp()).get('/api/labs');
    expect(response.status).toBe(200);
    for (const lab of response.body.data.labs as Array<Record<string, unknown>>) {
      // The listing carries no requirements at all — not even labels.
      expect(lab.requirements).toBeUndefined();
    }
  });

  it('never seeds a graded output value into the student sandbox', async () => {
    // Setup files are the only lab-authored content that reaches a sandbox.
    // Scoped to `terraform_output_equals` — the requirement type whose values
    // are the sensitive class PLATFORM-SEC is about — so that an unrelated lab
    // legitimately seeding a path it later asserts does not trip this.
    for (const summary of registry.list({ track: 'terraform' })) {
      const definition = registry.get(summary.id);
      const files = await loadSetupFiles(definition);
      const seeded = files.map((file) => file.content).join('\n');
      for (const requirement of definition.requirements) {
        if (requirement.type !== 'terraform_output_equals') continue;
        const value = (requirement as Record<string, unknown>).value;
        if (typeof value !== 'string' || value.length < 4) continue;
        expect(
          seeded.includes(value),
          `${summary.id} seeds the expected value of an output check into the sandbox`,
        ).toBe(false);
      }
    }
  });
});
