/**
 * The CI/CD provider — a project, a toolchain, and nothing else.
 *
 * A CI/CD lab hands the student a small application and asks them to write the
 * pipeline that builds it: a GitHub Actions workflow, a Jenkinsfile, a shell
 * pipeline script. The pipeline definitions are graded by *reading* them, and
 * the two things a pipeline ultimately has to do — build the project, run its
 * tests — are done for real in the session's own sandbox.
 *
 * ```text
 *   Student session
 *        ↓
 *   CicdLabProvider
 *        ↓
 *   container from jumptotech/lab-cicd     (Node.js toolchain, no daemon)
 *        ↓
 *   --network none  +  --cap-drop ALL  +  no capabilities added
 *        ↓
 *   student writes .github/workflows/ci.yml, Jenkinsfile, ci/pipeline.sh
 *        ↓
 *   verifier parses what they wrote, and runs `node build.mjs` / `node --test`
 * ```
 *
 * ## What this deliberately does not do
 *
 * **No Docker.** CICD-005 is called "Building a Container Image in CI", and it
 * is graded on the workflow file declaring a build step and on the Dockerfile
 * the student wrote — not by running `docker build`. The lesson is what a
 * container build step looks like in a pipeline, and that lesson is complete
 * without a daemon. So this provider mounts no Docker socket, needs no
 * `docker:dind` sandbox, and asks for no privilege. If a future lab genuinely
 * needs to build an image, that is a new security review and a different
 * provider, not a quiet addition here.
 *
 * **No Jenkins server, and no GitHub.** A Jenkinsfile is parsed; a workflow is
 * parsed. Nothing in this track reaches the network, which is why the sandbox
 * runs with `--network none` like a Terraform one.
 *
 * **No capabilities.** `--cap-drop ALL` with nothing added back: the container
 * holds an empty capability bounding set. Editing files and running `node` as
 * an unprivileged user needs none, so none is asked for.
 */
import { VERIFIER_COMMANDS } from '../requirements.js';
import { WORKSPACE_TASKS } from '../cicd/tasks.js';
import type { ContainerRuntimePort } from './container/runtime.js';
import { ContainerLabProvider } from './container/sandbox-provider.js';

export const DEFAULT_CICD_SANDBOX_IMAGE = 'jumptotech/lab-cicd:latest';

/**
 * The binaries the verifier may run inside a CI/CD sandbox.
 *
 * `node` is here because the CI/CD requirement family runs the project's own
 * build and tests, and every task in `WORKSPACE_TASKS` invokes it. It is not a
 * general grant: the argv reaches the daemon from that closed table, written
 * in platform code, and a lab definition names a task *id* rather than a
 * command — so a lab cannot ask this sandbox to run something else.
 */
export const CICD_INSPECTION_COMMANDS: readonly string[] = [
  ...VERIFIER_COMMANDS,
  // Derived from the task table rather than written twice, so a task that
  // needed a different binary could not silently fail to be allow-listed.
  ...new Set(Object.values(WORKSPACE_TASKS).map((task) => task.argv[0] as string)),
];

export interface CicdProviderOptions {
  runtime: ContainerRuntimePort;
  image?: string;
  home?: string;
  now?: () => number;
  runtimeOwner?: string;
}

export class CicdLabProvider extends ContainerLabProvider {
  constructor(options: CicdProviderOptions) {
    super({
      id: 'cicd',
      name: 'docker-cicd',
      runtime: options.runtime,
      image: options.image ?? DEFAULT_CICD_SANDBOX_IMAGE,
      // Nothing here administers the sandbox: a student edits files in their
      // own project and runs `node`. An empty capability set is correct, and
      // the runtime's provider-scoped gate means this provider could not
      // obtain NET_RAW or SYS_CHROOT even if a lab asked for them.
      capabilities: [],
      // Provisioning fails loudly if the toolchain is missing, rather than
      // handing a student a CI lab whose build could never have run.
      requiredBinaries: ['node'],
      inspectionCommands: CICD_INSPECTION_COMMANDS,
      ...(options.home ? { home: options.home } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.runtimeOwner ? { runtimeOwner: options.runtimeOwner } : {}),
    });
  }
}
