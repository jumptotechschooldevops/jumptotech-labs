# The verifier's requirement vocabulary — and what "unused" means for it

**Phase 10 audit, 2026-08-28.** The catalogue ships **114 labs** using **155**
requirement types. The verifier registers **192**. This document is the answer
to the obvious next question — *are the other 37 dead code?* — and the answer is
no, for a structural reason worth writing down once rather than rediscovering
each time someone counts.

## The registry is total over the schema, by type

Each family's handler table is a mapped type over that family's requirement
union:

```ts
const KUBERNETES_HANDLERS: { [K in KubernetesRequirementType]: VerifierHandler<K> } = { … };
```

So a handler is not an optional extra that happens to be registered. It is the
implementation of a requirement type the **lab schema already accepts**. Three
separate things enforce that correspondence:

| Guard | Where | What it refuses |
|---|---|---|
| the mapped type | `services/verifier/src/registry.ts` | a schema type with no handler — a compile error |
| the totality test | `shared-core-contract.test.ts` — `REQUIREMENT_TYPES.filter((t) => !hasHandler(t))` | the same thing, at runtime |
| the orphan test | `shared-core-contract.test.ts` — `registeredRequirementTypes()` not in `REQUIREMENT_TYPES` | a handler with no schema type |

**Deleting a handler alone does not compile.** Deleting the handler *and* its
schema type is a breaking change to the lab authoring contract: a lab that used
it stops loading, with an "unknown requirement type" error that says nothing
about the removal. That is the same failure mode `shared-core-contract.test.ts`
was written to catch after a curriculum merge dropped one side of the vocabulary.

## Classification of the 37

No type in the catalogue is **LIKELY DEAD**. Every one is schema-declared,
handler-backed and unit-tested; nothing here has been orphaned.

### RESERVED / FUTURE — 36 types

A coherent Kubernetes vocabulary that reaches past the 55 labs currently
shipped. These are not stragglers: they arrive in complete families, which is
what a vocabulary built for a curriculum looks like rather than one built for a
lab.

| Family | Types | Covers |
|---|---|---|
| Ingress | `ingress_exists`, `ingress_rule`, `ingress_class`, `ingress_tls`, `ingress_default_backend` | the Ingress topic — no shipped lab teaches it yet |
| NetworkPolicy | `networkpolicy_exists`, `networkpolicy_pod_selector`, `networkpolicy_policy_types`, `networkpolicy_ingress_rule`, `networkpolicy_egress_rule`, `networkpolicy_allows_dns` | authoring policy. The platform's *own* NetworkPolicy is proven by the isolation suites, which is a different thing from a lab that asks a student to write one |
| Autoscaling | `hpa_exists`, `hpa_replicas`, `hpa_target`, `hpa_metric_cpu`, `hpa_metric_resource` | HPA — needs metrics-server, which the kind cluster does not install |
| Scheduling | `pod_node_selector`, `pod_node_name`, `pod_scheduled_on_node`, `pod_tolerations`, `pod_affinity_required`, `pod_anti_affinity_required`, `deployment_node_selector`, `deployment_tolerations` | placement — needs a multi-node cluster; the local kind cluster is single-node |
| Pod detail | `pod_label`, `pod_phase`, `pod_resources` | finer assertions than the shipped labs need |
| Storage | `pvc_storage_class`, `pvc_volume_mode`, `storageclass_exists` | the storage topic past what PVC labs assert today |
| Misc | `service_http`, `service_tcp`, `serviceaccount_exists`, `secret_type`, `job_image` | siblings of types that *are* used, completing their families |
| Ansible | `ansible_host_exists` | completes the inventory family beside `ansible_group_exists`, which labs do use |

Three of these families are blocked on **infrastructure, not on content**:
autoscaling needs metrics-server, scheduling needs more than one node. A lab
author reaching for them today would write a lab that cannot pass locally, so
their being unused is a property of the cluster, not evidence about the code.

### PLATFORM INTERNAL — 1 type

`process_environ` — the only handler here with a dedicated API-level test
(`apps/api/test/process-environ-api.test.ts`) alongside its unit test. It is
the handler that reports a **verdict and never a value**: a student learns that
a variable is missing, forbidden or wrong, and never what it was set to. That
disclosure boundary is asserted at the API tier precisely because it is a
security property rather than a convenience, so the handler is exercised on
every run regardless of whether a lab names it.

## The rule for removing one

Removal is a curriculum decision, not a cleanup. It is safe only when all of:

1. no shipped lab uses the type (this document's count, re-measured);
2. no planned lab in the track's `CURRICULUM.md` needs it;
3. the type is removed from `requirements.ts` **and** the handler **and** the
   `shared-core-contract.test.ts` baseline, in one change;
4. the removal is described in the commit, because a lab authored against an
   older vocabulary will fail to load and the error will not say why.

Nothing in the 37 met (1) and (2) at the time of this audit, so nothing was
removed.

## Re-measuring

```bash
node -e '
const fs=require("fs"),path=require("path");
const used=new Set();
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name);
  if(e.isDirectory())walk(p);
  else if(e.name==="lab.yaml")for(const m of fs.readFileSync(p,"utf8")
    .matchAll(/^\s*-?\s*type:\s*([a-z][a-z0-9_]*)\s*$/gm))used.add(m[1]);
}})("labs");
const {registeredRequirementTypes}=await import("./services/verifier/src/index.js");
console.log(registeredRequirementTypes().filter(t=>!used.has(t)).sort().join("\n"));
'
```
