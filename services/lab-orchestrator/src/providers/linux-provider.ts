/**
 * The Linux provider — the first non-Kubernetes sandbox.
 *
 * ```text
 *   Student session
 *        ↓
 *   LinuxLabProvider
 *        ↓
 *   temporary container from jumptotech/lab-linux
 *        ↓
 *   unprivileged user `student`, no network, no host mounts
 *        ↓
 *   bash, and a real process supervisor
 *        ↓
 *   verifier reads the real filesystem — and the real process table — back
 * ```
 *
 * Everything mechanical lives in `ContainerLabProvider`; this file exists to
 * pin the image, the provider id, and the two things that make a Linux sandbox
 * different from a Terraform one.
 *
 * ## Why this sandbox is not `--cap-drop ALL` and nothing else
 *
 * A Terraform sandbox only has to hold a working directory, so it keeps the
 * strictest possible profile. The Linux track teaches *system administration*:
 * LINUX-003 is about `useradd` and group membership, LINUX-005 is about a
 * supervised service, LINUX-002 is about changing ownership of a file the
 * student does not own. None of that is teachable from an account with no
 * privilege at all, and simulating it — a fake `systemctl`, a stubbed
 * `useradd` — would teach students to type commands that do nothing.
 *
 * So the sandbox drops every capability and then adds back a narrow, explicit
 * set (`LINUX_SANDBOX_CAPABILITIES`), and allows privilege escalation so that
 * `sudo` genuinely works inside it. What that changes and what it does not:
 *
 * | Boundary | Still holds? |
 * |---|---|
 * | host filesystem | yes — no bind mounts, ever |
 * | Docker socket | yes — never passed in, and the image has no client |
 * | network | yes — `--network none` |
 * | CPU / memory / pids | yes — unchanged |
 * | other students | yes — one container per session, name derived server-side |
 * | host kernel objects | yes — `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `MKNOD`, `SYS_MODULE` are not grantable at all |
 * | root *inside this container* | **no — that is the point** |
 *
 * The isolation boundary for a Linux lab is the container, not the account
 * inside it. A student is alone in there, and everything they can reach they
 * were given deliberately. This is stated in the README next to the honest
 * caveat that a container is not a virtual machine.
 *
 * The image is built on the host by `npm run sandbox:build`, deliberately not
 * by this process — building an image needs the Docker socket, and the same
 * rule that keeps `kind` cluster creation out of the API applies here.
 */
import { VERIFIER_COMMANDS } from '../requirements.js';
import type { ContainerRuntimePort } from './container/runtime.js';
import { ContainerLabProvider } from './container/sandbox-provider.js';

export const DEFAULT_LINUX_SANDBOX_IMAGE = 'jumptotech/lab-linux:latest';

/**
 * The hostname inside a Linux sandbox.
 *
 * Student-visible in the prompt, and gradeable: LINUX-009 asks for a script
 * that reports `HOST=` followed by this machine's hostname, so this value is
 * lab content as much as it is configuration.
 */
export const LINUX_SANDBOX_HOSTNAME = 'jumptotech-lab';

/**
 * The capabilities a Linux sandbox is granted back after `--cap-drop ALL`.
 *
 * Each one is here because a specific lab needs it, and the list is checked
 * against `GRANTABLE_CAPABILITIES` in the runtime before any of it reaches
 * Docker — so this cannot grow into something host-reaching by editing one
 * line here.
 *
 *   CHOWN, FOWNER, FSETID  ownership and mode changes on files the student
 *                          does not own (LINUX-002, LINUX-003)
 *   DAC_OVERRIDE           root reading and writing under /etc and /srv
 *   SETUID, SETGID         `sudo`, and services that drop to their own account
 *   SETPCAP                what `sudo` itself needs to hand over
 *   KILL                   signalling a supervised service (LINUX-004/005)
 */
export const LINUX_SANDBOX_CAPABILITIES = [
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'SETGID',
  'SETUID',
  'SETPCAP',
  'KILL',
  // Not needed to *do* anything — but without it every `sudo` prints
  // "unable to send audit message", on every command, in a track whose whole
  // point is reading what the system tells you.
  'AUDIT_WRITE',
] as const;

export interface LinuxProviderOptions {
  runtime: ContainerRuntimePort;
  image?: string;
  home?: string;
  now?: () => number;
}

export class LinuxLabProvider extends ContainerLabProvider {
  constructor(options: LinuxProviderOptions) {
    super({
      id: 'linux',
      name: 'docker-linux',
      runtime: options.runtime,
      image: options.image ?? DEFAULT_LINUX_SANDBOX_IMAGE,
      capabilities: [...LINUX_SANDBOX_CAPABILITIES],
      hostname: LINUX_SANDBOX_HOSTNAME,
      // The foreground process is `runsvdir`, a real supervisor, and it has to
      // be root to run services that drop to their own accounts. The student is
      // still `student`: every shell, read and health check attaches with
      // `--user student`, and the isolation boundary is the container itself.
      containerUser: 'root',
      // A real supervisor, so LINUX-005 can teach services that genuinely
      // start, stop and come back — rather than a stubbed `systemctl` that
      // would teach students to type commands with no effect.
      foregroundCommand: ['/usr/bin/runsvdir', '-P', '/etc/service'],
      // `sudo` is setuid; with no-new-privileges it silently does nothing,
      // which is the worst of both worlds — a student typing a correct command
      // and seeing no effect. Off here, and only here.
      noNewPrivileges: false,
      // The `linux` requirement family reads a process table, listening
      // sockets and account databases. These are the read-only binaries the
      // verifier may use to do it; the closed list lives in `requirements.ts`
      // so the lab schema and the provider cannot drift apart.
      inspectionCommands: VERIFIER_COMMANDS,
      ...(options.home ? { home: options.home } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
}
