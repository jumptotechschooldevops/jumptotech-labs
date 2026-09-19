/**
 * Every Ansible lab that grades managed-node state and runs an idempotency
 * check proves the playbook made that state.
 *
 * Checks run in order. An `ansible_idempotent` check placed after the state
 * checks, or one with no reset, let files written by hand (`ansible -m copy`,
 * or a shell on the node) satisfy every content check while a playbook that
 * changed nothing "converged" — the second lab-quality audit found this in
 * ANSIBLE-006, -007, -008 and -010. The rule: the idempotency check clears
 * the graded paths, requires the first run to change something, and comes
 * before anything that reads the nodes.
 */
import { describe, expect, it } from 'vitest';
import { realCatalog } from './real-catalog.js';

describe('Ansible labs grade state the playbook made', () => {
  it('runs a clearing idempotency check before any check that reads the managed nodes', async () => {
    const registry = await realCatalog();
    const labs = registry.list().filter((lab) => lab.track === 'ansible');
    expect(labs.length).toBeGreaterThan(5);
    const checked: string[] = [];
    for (const summary of labs) {
      const lab = registry.get(summary.id);
      const types = lab.requirements.map((r) => r.type);
      const idempotent = types.indexOf('ansible_idempotent');
      const firstState = types.findIndex((t) => t.startsWith('managed_'));
      if (idempotent === -1 || firstState === -1) continue;
      checked.push(lab.id);
      const rule = lab.requirements[idempotent] as { require_initial_change?: boolean; reset_paths?: string[] };
      expect(rule.require_initial_change, `${lab.id}: the idempotency check must require a first-run change`).toBe(true);
      expect(rule.reset_paths?.length ?? 0, `${lab.id}: the idempotency check must clear something`).toBeGreaterThan(0);
      expect(idempotent, `${lab.id}: the idempotency check must run before the state checks`).toBeLessThan(firstState);
    }
    expect(checked.sort()).toEqual(['ANSIBLE-003', 'ANSIBLE-006', 'ANSIBLE-007', 'ANSIBLE-008', 'ANSIBLE-009', 'ANSIBLE-010']);
  });
});
