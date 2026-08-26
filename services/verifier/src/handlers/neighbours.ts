/**
 * The neighbour-table check.
 *
 * This is the first verifier handler that grades *network* state, and it exists
 * because nothing else can. A file read cannot answer "did this host resolve
 * that neighbour"; a command allow-list cannot be widened to `ip` without
 * handing every lab author `ip neigh add`; and a student-written transcript is
 * not evidence of anything.
 *
 * What makes the check honest is that the state it reads cannot be manufactured
 * from inside the sandbox. Populating a neighbour entry means actually sending
 * traffic and having the kernel record what came back. Writing one by hand —
 * `ip neigh add` — needs `CAP_NET_ADMIN`, and no sandbox this platform creates
 * grants it, so the answer in the table is the kernel's, not the student's.
 *
 * The check is deliberately narrow about what it reports. A failure names the
 * address that was asked about and what was found for it, and nothing else: the
 * rest of a student's neighbour table is not the lab's business and is never
 * echoed back.
 */
import type { SandboxVerifierHandler } from '../contract.js';
import { fail, pass } from '../contract.js';
import type { NeighbourEntry } from '../sandbox-reader.js';

/** `10.90.0.1 on eth0` / `a neighbour on eth0`, for messages. */
function describeTarget(address: string | undefined, device: string | undefined): string {
  if (address && device) return `${address} on ${device}`;
  if (address) return address;
  return `a neighbour on ${device}`;
}

/** How the kernel currently describes one entry. */
function describeEntry(entry: NeighbourEntry): string {
  const state = entry.state.length > 0 ? entry.state.join('/') : 'no state';
  return entry.lladdr ? `${state}, hardware address resolved` : `${state}, no hardware address`;
}

export const neighbourState: SandboxVerifierHandler<'neighbour_state'> = {
  type: 'neighbour_state',
  label: (r) =>
    r.absent
      ? `The neighbour table holds no entry for ${describeTarget(r.address, r.device)}`
      : `The neighbour table holds an entry for ${describeTarget(r.address, r.device)}`,

  async run(requirement, reader) {
    const target = describeTarget(requirement.address, requirement.device);
    const entries = await reader.neighbours();
    const matches = entries.filter(
      (entry) =>
        (requirement.address === undefined || entry.dst === requirement.address) &&
        (requirement.device === undefined || entry.dev === requirement.device),
    );

    // "No entry at all" is a real, teachable outcome: a destination with no
    // route never reaches the point of asking who the neighbour is.
    if (requirement.absent) {
      return matches.length === 0
        ? pass()
        : fail(`The neighbour table still holds an entry for ${target} (${describeEntry(matches[0]!)})`);
    }

    if (matches.length === 0) {
      return fail(`The neighbour table has no entry for ${target}`);
    }

    // Several rows can match when no interface was named. The check passes if
    // any one of them satisfies every condition — anything else would make an
    // unrelated interface's entry able to fail a correct answer.
    const satisfied = matches.find((entry) => {
      if (requirement.state && !entry.state.some((s) => requirement.state!.includes(s as never))) {
        return false;
      }
      if (requirement.lladdr === 'present' && !entry.lladdr) return false;
      if (requirement.lladdr === 'absent' && entry.lladdr) return false;
      return true;
    });

    if (satisfied) return pass();

    // Report only what was asked about. The rest of a student's neighbour
    // table is not the lab's business and is never echoed back.
    const observed = matches.map(describeEntry).join('; ');
    if (requirement.state && requirement.lladdr) {
      return fail(
        `${target} is ${observed}, expected one of ${requirement.state.join('/')} with a hardware address ${requirement.lladdr}`,
      );
    }
    if (requirement.state) {
      return fail(`${target} is ${observed}, expected one of ${requirement.state.join('/')}`);
    }
    return fail(
      `${target} is ${observed}, expected its hardware address to be ${requirement.lladdr}`,
    );
  },
};
