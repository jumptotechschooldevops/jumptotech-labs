/**
 * What the leak alert compares: sandbox containers this broker holds, counted
 * per session.
 *
 * `jtt:sandbox_leak:count` used to be containers minus every occupying session,
 * which only balances when each session holds exactly one container. It does
 * not: an Ansible session holds three (a control node and two managed nodes),
 * a Linux lab with a peer holds two, and a Kubernetes session holds none. Five
 * students in one Ansible class read 15 − 5 = 10, and `SandboxLeakSuspected`
 * (more than 5 for 15 minutes) fired on a healthy class; five Kubernetes
 * sessions hid five leaked containers. Counting distinct sessions here, and
 * comparing with container-backed sessions only, balances for every track.
 */
import { CONTAINER_SESSION_LABEL, RUNTIME_OWNER_LABEL, type ContainerInfo } from '@jumptotech/lab-orchestrator';

/** This runtime owner's containers, exactly as `/v1/runtime` `list` scopes them. */
export function ownedContainers(all: readonly ContainerInfo[], runtimeOwner: string): ContainerInfo[] {
  return all.filter((container) => container.labels?.[RUNTIME_OWNER_LABEL] === runtimeOwner);
}

/**
 * Distinct sessions among these containers. A container with no session label
 * belongs to no session any api could hold, so it counts on its own: it is
 * exactly what the leak alert exists to notice.
 */
export function distinctContainerSessions(containers: readonly ContainerInfo[]): number {
  const sessions = new Set<string>();
  let unlabelled = 0;
  for (const container of containers) {
    const session = container.labels?.[CONTAINER_SESSION_LABEL];
    if (session) sessions.add(session);
    else unlabelled += 1;
  }
  return sessions.size + unlabelled;
}
