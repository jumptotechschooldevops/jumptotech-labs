/**
 * Declarative Docker setup — the counterpart of `session/manifests.ts`.
 *
 * A Kubernetes lab describes its starting condition with YAML manifests. A
 * Docker lab describes it with a structured `setup.docker` block:
 *
 * ```yaml
 * setup:
 *   docker:
 *     images: [ "alpine:3.20" ]
 *     networks: [ { name: ledger-net } ]
 *     volumes:  [ { name: ledger-data } ]
 *     files:
 *       - path: Dockerfile
 *         content: "FROM alpine:3.20\n"
 *     containers:
 *       - name: ledger-api
 *         image: alpine:3.20
 *         command: [ "sleep", "3600" ]
 *         state: running
 * ```
 *
 * **The security property this file exists to hold.** Nothing here is a shell
 * fragment. `command` and `entrypoint` are string *arrays*, passed to the
 * daemon as argv exactly as a Kubernetes Pod spec passes `command:` — they are
 * never concatenated, never quoted, and never interpreted by a shell. There is
 * no field in this schema that can carry `&&`, a pipe, or a subshell into an
 * execution context, because there is no execution context that would read one.
 *
 * Every object created from this block is created *inside the session's own
 * isolated daemon*, so a lab's initial state cannot reach any other session.
 */
import { z } from 'zod';

/** A Docker object name: what `docker run --name` and friends accept. */
const dockerName = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    'must be a Docker object name (letters, digits, and _ . -)',
  );

/** A container image reference, e.g. `alpine:3.20`. */
const imageReference = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, 'must be a container image reference');

/**
 * One element of a container's argv.
 *
 * Control characters are rejected so that a value cannot smuggle a newline into
 * a log line or a terminal escape into a student's screen. Shell metacharacters
 * are deliberately *not* rejected: they are harmless here precisely because no
 * shell ever sees this value.
 */
const argvElement = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f]+$/, 'must not contain control characters');

const envKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name');
const envValue = z.string().max(1024).regex(/^[^\u0000-\u001f]*$/, 'must not contain control characters');

/**
 * A workspace-relative file path.
 *
 * Rejects absolute paths, parent traversal, and backslashes. The provider
 * re-checks the resolved path against the workspace root before writing, so a
 * symlinked or unusual path cannot escape either.
 */
export const workspacePath = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'must be a relative path inside the lab workspace')
  .refine((p) => !p.startsWith('/'), { message: 'must be relative to the lab workspace' })
  .refine((p) => !p.includes('\\'), { message: 'must use forward slashes' })
  .refine((p) => !p.split('/').includes('..'), { message: 'must not traverse upwards' })
  .refine((p) => !p.endsWith('/'), { message: 'must name a file, not a directory' });

const setupNetwork = z
  .object({
    name: dockerName,
    driver: z.enum(['bridge']).default('bridge'),
    /** No external connectivity from this network. */
    internal: z.boolean().default(false),
  })
  .strict();

const setupVolume = z.object({ name: dockerName }).strict();

const setupFile = z
  .object({
    path: workspacePath,
    /** Written verbatim into the session workspace before the terminal opens. */
    content: z.string().max(16_384),
  })
  .strict();

const setupContainer = z
  .object({
    name: dockerName,
    image: imageReference,
    /** Argv for the container. A string array, never a command line. */
    command: z.array(argvElement).max(20).optional(),
    entrypoint: z.array(argvElement).max(20).optional(),
    env: z.record(envKey, envValue).optional(),
    workdir: z.string().min(1).max(255).optional(),
    network: dockerName.optional(),
    /**
     * The state the container should be left in.
     *
     * `exited` is what a troubleshooting lab wants: a container that ran and
     * stopped, leaving logs and an exit code for the student to investigate.
     */
    state: z.enum(['running', 'exited', 'created']).default('running'),
    ports: z
      .array(
        z
          .object({
            container: z.number().int().min(1).max(65535),
            host: z.number().int().min(1).max(65535).optional(),
            protocol: z.enum(['tcp', 'udp']).default('tcp'),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    volumes: z
      .array(
        z
          .object({
            volume: dockerName,
            destination: z.string().min(1).max(255).startsWith('/', 'must be an absolute path'),
            read_only: z.boolean().default(false),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    labels: z.record(z.string().min(1).max(128), z.string().max(256)).optional(),
    /** `--memory`, e.g. `64m`. Bounded by the sandbox's own limit regardless. */
    memory: z
      .string()
      .max(16)
      .regex(/^[0-9]+(\.[0-9]+)?[bkmg]?$/i, 'must be a Docker memory value such as 64m')
      .optional(),
    /** `--cpus`, e.g. `0.5`. */
    cpus: z
      .string()
      .max(8)
      .regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a CPU count such as 0.5')
      .optional(),
    restart: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).default('no'),
  })
  .strict();

/**
 * A Docker lab's declared initial state.
 *
 * Ordering is fixed by the provider — images, then networks and volumes, then
 * files, then containers — so a lab can rely on a network existing before the
 * container that joins it, without expressing dependencies itself.
 */
export const dockerSetupSchema = z
  .object({
    /** Images the sandbox must hold before the student starts. */
    images: z.array(imageReference).max(10).default([]),
    networks: z.array(setupNetwork).max(5).default([]),
    volumes: z.array(setupVolume).max(5).default([]),
    files: z.array(setupFile).max(10).default([]),
    containers: z.array(setupContainer).max(8).default([]),
  })
  .strict();

export type DockerSetupPlan = z.infer<typeof dockerSetupSchema>;
export type DockerSetupContainer = z.infer<typeof setupContainer>;
export type DockerSetupFile = z.infer<typeof setupFile>;

/** True when the plan asks for nothing at all. */
export function isEmptyDockerSetup(plan: DockerSetupPlan | undefined): boolean {
  if (!plan) return true;
  return (
    plan.images.length === 0 &&
    plan.networks.length === 0 &&
    plan.volumes.length === 0 &&
    plan.files.length === 0 &&
    plan.containers.length === 0
  );
}

/**
 * Every image a plan needs, including those only referenced by a container.
 *
 * Used to pre-seed a sandbox: a container whose image is missing would
 * otherwise trigger an implicit pull at the worst possible moment, during
 * provisioning, on a connection the platform does not control.
 */
export function requiredImages(plan: DockerSetupPlan): string[] {
  const all = [...plan.images, ...plan.containers.map((c) => c.image)];
  return [...new Set(all)];
}

/** Human-readable one-line summary of what a plan creates. Used in step detail. */
export function describeDockerSetup(plan: DockerSetupPlan): string {
  const parts: string[] = [];
  if (plan.images.length > 0) parts.push(`${plan.images.length} image(s)`);
  if (plan.networks.length > 0) parts.push(`${plan.networks.length} network(s)`);
  if (plan.volumes.length > 0) parts.push(`${plan.volumes.length} volume(s)`);
  if (plan.files.length > 0) parts.push(`${plan.files.length} file(s)`);
  if (plan.containers.length > 0) parts.push(`${plan.containers.length} container(s)`);
  return parts.length > 0 ? `created ${parts.join(', ')}` : 'nothing to create';
}
