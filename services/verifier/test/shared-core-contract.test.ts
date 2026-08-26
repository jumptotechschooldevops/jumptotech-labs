/**
 * The shared-core contract (Phase 2).
 *
 * Six curriculum tracks are merged into `main` one at a time, and each of them
 * touches the same four files: the requirement vocabulary, the family map, the
 * verifier's handler tables, and the provider capability table. A merge that
 * resolves a conflict by taking one side wholesale drops whatever the other
 * side had — and nothing about that failure is loud. A requirement type simply
 * stops existing, and the labs that used it fail to load with a message about
 * an unknown type rather than about a bad merge.
 *
 * This file is the loud part. It asserts a *baseline*, never an exact set:
 * every type below must still exist and still be routed to the same reader,
 * while a track that brings new types passes without editing anything here.
 * That is the union-compatible shape the remaining merges need — additive
 * changes are silent, subtractive ones fail.
 */
import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_FAMILIES,
  REQUIREMENT_FAMILY_LIST,
  REQUIREMENT_FAMILY_READERS,
  REQUIREMENT_TYPES,
  familyReader,
  isAnsibleFamily,
  isCicdFamily,
  isDockerFamily,
  isKubernetesFamily,
  isSandboxFamily,
  requirementFamily,
  requirementsNeedDocker,
  requirementsNeedKubernetes,
  requirementsNeedSandbox,
  type RequirementFamily,
  type RequirementType,
} from '@jumptotech/lab-orchestrator';
import { PROVIDER_REQUIREMENT_FAMILIES } from '@jumptotech/lab-orchestrator';
import { hasHandler, registeredRequirementTypes, verifyRequirement } from '../src/registry.js';
import { fail, pass, skip } from '../src/contract.js';

/**
 * Requirement types that existed on `main` when the curriculum merges began.
 *
 * A merge that loses one of these fails here. Adding to this list is only
 * correct once the type is on `main` and expected to stay.
 */
const BASELINE: ReadonlyArray<readonly [string, RequirementFamily]> = [
  ['pod_exists', 'kubernetes'],
  ['pod_image', 'kubernetes'],
  ['pod_running', 'kubernetes'],
  ['pod_phase', 'kubernetes'],
  ['pod_ready', 'kubernetes'],
  ['pod_label', 'kubernetes'],
  ['pod_resources', 'kubernetes'],
  ['deployment_exists', 'kubernetes'],
  ['deployment_image', 'kubernetes'],
  ['deployment_replicas', 'kubernetes'],
  ['deployment_available', 'kubernetes'],
  ['deployment_rollout_complete', 'kubernetes'],
  ['deployment_selector', 'kubernetes'],
  ['deployment_resources', 'kubernetes'],
  ['deployment_probe', 'kubernetes'],
  ['deployment_uses_configmap', 'kubernetes'],
  ['deployment_uses_secret', 'kubernetes'],
  ['service_exists', 'kubernetes'],
  ['service_type', 'kubernetes'],
  ['service_port', 'kubernetes'],
  ['service_selector', 'kubernetes'],
  ['service_headless', 'kubernetes'],
  ['service_endpoints', 'kubernetes'],
  ['configmap_exists', 'kubernetes'],
  ['configmap_key', 'kubernetes'],
  ['secret_exists', 'kubernetes'],
  ['secret_key', 'kubernetes'],
  ['secret_type', 'kubernetes'],
  ['job_exists', 'kubernetes'],
  ['job_completed', 'kubernetes'],
  ['job_image', 'kubernetes'],
  ['cronjob_exists', 'kubernetes'],
  ['cronjob_schedule', 'kubernetes'],
  ['cronjob_suspended', 'kubernetes'],
  ['role_exists', 'kubernetes'],
  ['role_rule', 'kubernetes'],
  ['rolebinding_exists', 'kubernetes'],
  ['rolebinding_subject', 'kubernetes'],
  ['rolebinding_role_ref', 'kubernetes'],
  ['serviceaccount_exists', 'kubernetes'],
  ['auth_allowed', 'kubernetes'],
  ['auth_forbidden', 'kubernetes'],
  ['pvc_exists', 'kubernetes'],
  ['pvc_bound', 'kubernetes'],
  ['pvc_storage_class', 'kubernetes'],
  ['pvc_access_modes', 'kubernetes'],
  ['pvc_storage_request', 'kubernetes'],
  ['pvc_volume_mode', 'kubernetes'],
  ['workload_mounts_pvc', 'kubernetes'],
  ['storageclass_exists', 'kubernetes'],
  ['ingress_exists', 'kubernetes'],
  ['ingress_class', 'kubernetes'],
  ['ingress_rule', 'kubernetes'],
  ['ingress_tls', 'kubernetes'],
  ['ingress_default_backend', 'kubernetes'],
  ['networkpolicy_exists', 'kubernetes'],
  ['networkpolicy_pod_selector', 'kubernetes'],
  ['networkpolicy_policy_types', 'kubernetes'],
  ['networkpolicy_ingress_rule', 'kubernetes'],
  ['networkpolicy_egress_rule', 'kubernetes'],
  ['networkpolicy_allows_dns', 'kubernetes'],
  ['statefulset_exists', 'kubernetes'],
  ['statefulset_replicas', 'kubernetes'],
  ['statefulset_ready', 'kubernetes'],
  ['statefulset_image', 'kubernetes'],
  ['statefulset_service_name', 'kubernetes'],
  ['statefulset_volume_claim_template', 'kubernetes'],
  ['daemonset_exists', 'kubernetes'],
  ['daemonset_image', 'kubernetes'],
  ['daemonset_selector', 'kubernetes'],
  ['daemonset_scheduled', 'kubernetes'],
  ['daemonset_ready', 'kubernetes'],
  ['pod_node_selector', 'kubernetes'],
  ['pod_tolerations', 'kubernetes'],
  ['pod_node_name', 'kubernetes'],
  ['deployment_node_selector', 'kubernetes'],
  ['deployment_tolerations', 'kubernetes'],
  ['pod_affinity_required', 'kubernetes'],
  ['pod_anti_affinity_required', 'kubernetes'],
  ['pod_scheduled_on_node', 'kubernetes'],
  ['hpa_exists', 'kubernetes'],
  ['hpa_target', 'kubernetes'],
  ['hpa_replicas', 'kubernetes'],
  ['hpa_metric_cpu', 'kubernetes'],
  ['hpa_metric_resource', 'kubernetes'],
  ['service_http', 'kubernetes'],
  ['service_tcp', 'kubernetes'],
  ['workload_annotation', 'kubernetes'],
  ['deployment_strategy', 'kubernetes'],
  ['workload_container', 'kubernetes'],
  ['workload_volume_mount', 'kubernetes'],
  ['file_exists', 'filesystem'],
  ['directory_exists', 'filesystem'],
  ['file_content', 'filesystem'],
  ['file_mode', 'filesystem'],
  ['file_owner', 'filesystem'],
  ['file_group', 'filesystem'],
  ['terraform_initialized', 'terraform'],
  ['terraform_resource_exists', 'terraform'],
  ['terraform_output_equals', 'terraform'],
  ['resource_absent', 'kubernetes'],
  ['path_absent', 'filesystem'],
  ['file_content_absent', 'filesystem'],
  ['script_executable', 'filesystem'],
  ['process_running', 'linux'],
  ['process_environ', 'linux'],
  ['process_not_running', 'linux'],
  ['port_listening', 'linux'],
  ['port_not_listening', 'linux'],
  ['user_exists', 'linux'],
  ['group_exists', 'linux'],
  ['user_in_group', 'linux'],
  ['script_runs', 'linux'],
  ['command_exit_code', 'linux'],
  ['command_output', 'linux'],
  ['docker_container_exists', 'docker'],
  ['docker_container_running', 'docker'],
  ['docker_container_state', 'docker'],
  ['docker_container_image', 'docker'],
  ['docker_container_exit_code', 'docker'],
  ['docker_container_env', 'docker'],
  ['docker_container_port', 'docker'],
  ['docker_container_network', 'docker'],
  ['docker_container_mount', 'docker'],
  ['docker_container_resource_limit', 'docker'],
  ['docker_image_exists', 'docker'],
  ['docker_image_config', 'docker'],
  ['docker_volume_exists', 'docker'],
  ['docker_network_exists', 'docker'],
  ['workspace_file_exists', 'docker'],
  ['dockerfile_valid', 'docker'],
  ['docker_resource_absent', 'docker'],
];

describe('requirement vocabulary baseline', () => {
  it('still supports every requirement type main had at the start of Phase 2', () => {
    const present = new Set<string>(REQUIREMENT_TYPES);
    const lost = BASELINE.map(([type]) => type).filter((type) => !present.has(type));
    expect(lost).toEqual([]);
  });

  it('still routes each baseline type to the same reader family', () => {
    const moved = BASELINE.filter(
      ([type, family]) => requirementFamily(type as RequirementType) !== family,
    ).map(([type, family]) => `${type}: expected ${family}, got ${requirementFamily(type as RequirementType)}`);
    expect(moved).toEqual([]);
  });

  it('classifies every requirement type it declares', () => {
    const unclassified = REQUIREMENT_TYPES.filter((type) => !REQUIREMENT_FAMILIES[type]);
    expect(unclassified).toEqual([]);
  });
});

describe('verifier handler coverage', () => {
  it('has a handler for every requirement type', () => {
    const missing = REQUIREMENT_TYPES.filter((type) => !hasHandler(type));
    expect(missing).toEqual([]);
  });

  it('registers no handler for a type the schema does not declare', () => {
    const declared = new Set<string>(REQUIREMENT_TYPES);
    const orphans = registeredRequirementTypes().filter((type) => !declared.has(type));
    expect(orphans).toEqual([]);
  });

  it('registers each requirement type exactly once', () => {
    const registered = registeredRequirementTypes();
    const duplicates = registered.filter((type, index) => registered.indexOf(type) !== index);
    expect(duplicates).toEqual([]);
  });
});

describe('family routing is exhaustive and disjoint', () => {
  const families = [...new Set(Object.values(REQUIREMENT_FAMILIES))] as RequirementFamily[];

  it('routes every family in use to exactly one reader group', () => {
    const misrouted = families.filter((family) => {
      const groups = [
        isKubernetesFamily(family),
        isSandboxFamily(family),
        isDockerFamily(family),
        isAnsibleFamily(family),
        isCicdFamily(family),
      ].filter(Boolean);
      return groups.length !== 1;
    });
    expect(misrouted).toEqual([]);
  });

  it('routes every declared family to one of the five known readers', () => {
    const known = new Set(['kubernetes', 'sandbox', 'docker', 'ansible', 'cicd']);
    const stray = REQUIREMENT_FAMILY_LIST.filter((family) => !known.has(familyReader(family)));
    expect(stray).toEqual([]);
  });

  it('leaves no family in use undeclared by the reader table', () => {
    const declared = new Set<string>(REQUIREMENT_FAMILY_LIST);
    expect(families.filter((family) => !declared.has(family))).toEqual([]);
  });

  it('keeps the reader table and the routing predicates in agreement', () => {
    for (const family of REQUIREMENT_FAMILY_LIST) {
      expect(isKubernetesFamily(family)).toBe(REQUIREMENT_FAMILY_READERS[family] === 'kubernetes');
      expect(isSandboxFamily(family)).toBe(REQUIREMENT_FAMILY_READERS[family] === 'sandbox');
      expect(isDockerFamily(family)).toBe(REQUIREMENT_FAMILY_READERS[family] === 'docker');
      expect(isAnsibleFamily(family)).toBe(REQUIREMENT_FAMILY_READERS[family] === 'ansible');
      expect(isCicdFamily(family)).toBe(REQUIREMENT_FAMILY_READERS[family] === 'cicd');
    }
  });
});

describe('substrate routing stays fail-closed', () => {
  const kubernetesBatch = REQUIREMENT_TYPES.filter((type) =>
    isKubernetesFamily(requirementFamily(type)),
  ).map((type) => ({ type }));
  const dockerBatch = REQUIREMENT_TYPES.filter((type) =>
    isDockerFamily(requirementFamily(type)),
  ).map((type) => ({ type }));
  const sandboxBatch = REQUIREMENT_TYPES.filter((type) =>
    isSandboxFamily(requirementFamily(type)),
  ).map((type) => ({ type }));

  it('never asks for Docker on a Kubernetes-only batch', () => {
    expect(requirementsNeedDocker(kubernetesBatch)).toBe(false);
    expect(requirementsNeedKubernetes(kubernetesBatch)).toBe(true);
  });

  it('never asks for Kubernetes on a Docker-only batch', () => {
    expect(requirementsNeedKubernetes(dockerBatch)).toBe(false);
    expect(requirementsNeedDocker(dockerBatch)).toBe(true);
  });

  it('never asks for Docker or Kubernetes on a sandbox-only batch', () => {
    expect(requirementsNeedDocker(sandboxBatch)).toBe(false);
    expect(requirementsNeedKubernetes(sandboxBatch)).toBe(false);
    expect(requirementsNeedSandbox(sandboxBatch)).toBe(true);
  });

  it('treats an unknown requirement type as needing nothing rather than everything', () => {
    const unknown = [{ type: 'not_a_requirement_type' }];
    expect(requirementsNeedDocker(unknown)).toBe(false);
    expect(requirementsNeedKubernetes(unknown)).toBe(false);
    expect(requirementsNeedSandbox(unknown)).toBe(false);
  });
});

describe('provider capability table', () => {
  it('names only families the platform actually classifies', () => {
    const known = new Set<string>(Object.values(REQUIREMENT_FAMILIES));
    for (const [provider, families] of Object.entries(PROVIDER_REQUIREMENT_FAMILIES)) {
      const unknown = families.filter((family) => !known.has(family));
      expect(`${provider}: ${unknown.join(', ')}`).toBe(`${provider}: `);
    }
  });

  it('keeps Kubernetes labs off the sandbox and Docker readers', () => {
    expect(PROVIDER_REQUIREMENT_FAMILIES.kubernetes).toEqual(['kubernetes']);
  });

  it('keeps Docker labs off the sandbox filesystem reader', () => {
    expect(PROVIDER_REQUIREMENT_FAMILIES.docker).toEqual(['docker']);
  });
});

describe('handler outcome vocabulary', () => {
  it('leaves pass and fail unchanged', () => {
    expect(pass()).toEqual({ ok: true });
    expect(pass('seen')).toEqual({ ok: true, detail: 'seen' });
    expect(fail('nope')).toEqual({ ok: false, detail: 'nope' });
    expect(fail('nope').skipped).toBeUndefined();
  });

  it('offers a third state that is not a student failure', () => {
    const outcome = skip('this reader cannot answer that');
    expect(outcome.skipped).toBe(true);
    // `ok` stays false so a caller that only reads `ok` still refuses a pass.
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('this reader cannot answer that');
  });
});

describe('missing readers are reported as skipped, never as failures', () => {
  it('skips a Kubernetes check when no Kubernetes reader is supplied', async () => {
    const result = await verifyRequirement({ type: 'pod_exists', name: 'web' } as never, {});
    expect(result.status).toBe('skipped');
  });

  it('skips a Docker check when no Docker reader is supplied', async () => {
    const result = await verifyRequirement(
      { type: 'docker_container_exists', name: 'web' } as never,
      {},
    );
    expect(result.status).toBe('skipped');
  });

  it('skips a sandbox check when no sandbox reader is supplied', async () => {
    const result = await verifyRequirement(
      { type: 'file_exists', path: '/etc/hostname' } as never,
      {},
    );
    expect(result.status).toBe('skipped');
  });
});
