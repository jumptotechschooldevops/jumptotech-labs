/**
 * N8 — the Docker sandbox image, and the gate that keeps it honest.
 *
 * The Networking track's container labs are written against diagnostics that
 * neither stock `docker:dind` nor any lab-usable image carries: `ip -d` and
 * `ip netns` (BusyBox's applet has neither), `tcpdump`, `dig`, `curl`, `nft`,
 * `nc`. N8 puts them in the sandbox image — the Docker *host* from a student's
 * point of view, which is where a container's veth peer, the bridge it is
 * attached to, and a DHCP exchange on that bridge all actually live.
 *
 * Two things have to hold, and they are what this file tests.
 *
 *   1. **The image is a real dependency, declared where an operator can see
 *      it.** It is built by `npm run sandbox:build` like the other four, and
 *      the build script's all-or-none guard covers it, so a developer testing a
 *      private tag cannot silently overwrite the shared one.
 *   2. **A host that has not built it says so in the catalog.** Before N8 the
 *      sandbox image was an upstream tag the host daemon would pull on demand,
 *      so its absence could not be a misconfiguration. It is a local image now,
 *      which means its absence *is* one — and the honest place to report that
 *      is the catalog, not a failed provision after the student has clicked.
 *
 * The image's contents are asserted at build time by the Dockerfile's own smoke
 * test (`command -v` per binary, plus `ip -d` and `ip -j`, which is what proves
 * iproute2 shadowed the BusyBox applet). That check belongs there rather than
 * here: it needs the built image, and a unit test that shelled out to Docker to
 * find out would be an integration test wearing a disguise. What this file
 * asserts about the contents is that the Dockerfile *declares* them, so a
 * package cannot be dropped without the test that names it going red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  DOCKER_SANDBOX_IMAGE_REMEDIATION,
  DockerLabProvider,
} from '../src/index.js';
import { FakeDockerEngines } from './docker-fakes.js';
import { REPO_ROOT } from './helpers.js';

const DOCKERFILE = path.join(REPO_ROOT, 'infrastructure', 'docker', 'sandbox-docker.Dockerfile');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sandbox-build.sh');

const dockerfile = (): string => readFileSync(DOCKERFILE, 'utf8');
const buildScript = (): string => readFileSync(BUILD_SCRIPT, 'utf8');

// ------------------------------------------------------- 1. the image itself

describe('the Docker sandbox image', () => {
  it('is the image the provider creates a sandbox from by default', () => {
    // Named here rather than inferred, because this is the string an operator
    // has to have built. A change to it is a change to the install steps.
    expect(DEFAULT_DOCKER_SANDBOX_IMAGE).toBe('jumptotech/lab-docker:latest');
  });

  it('is built from a pinned dind base rather than a floating tag', () => {
    const text = dockerfile();
    const base = /^ARG DIND_IMAGE=(\S+)$/m.exec(text)?.[1];

    expect(base, 'the base image must be an ARG so it can be pinned and bumped in one place').toBeDefined();
    // A major-version tag, not `latest`: the tool versions come from the Alpine
    // release this base carries, so a floating base is a floating tool set.
    expect(base).toMatch(/^docker:\d+(\.\d+)*-dind$/);
    expect(text).toContain('FROM ${DIND_IMAGE}');
  });

  it('installs every diagnostic the Networking curriculum names, and nothing broader', () => {
    const text = dockerfile();

    // Each of these is required by a lab in labs/networking/CURRICULUM.md, and
    // the Dockerfile's comments say which. Dropping one silently is the failure
    // this test exists to catch.
    for (const pkg of ['iproute2', 'tcpdump', 'bind-tools', 'curl', 'nftables', 'netcat-openbsd']) {
      expect(text, `${pkg} is named by a lab and must stay installed`).toContain(pkg);
    }

    // The counterweight: this is a diagnostics image, not a security toolkit.
    // A scanner or packet crafter arriving here would be a scope change that
    // should be argued for, not slipped in with an apk line.
    for (const banned of ['nmap', 'metasploit', 'hydra', 'scapy', 'ettercap', 'aircrack']) {
      expect(text.toLowerCase(), `${banned} is out of scope for a diagnostics image`).not.toContain(
        banned,
      );
    }
  });

  it('proves its own tool set at build time, so a base bump cannot fail a student', () => {
    const text = dockerfile();

    // `command -v` per binary, and the two `ip` invocations that distinguish
    // iproute2 from the BusyBox applet — which is the entire reason iproute2 is
    // installed, and the one thing a silent base change could undo.
    expect(text).toContain('command -v');
    expect(text).toContain('ip -d link show lo');
    expect(text).toContain('ip -j link show lo');
  });

  it('changes no user, capability or entrypoint of the base image', () => {
    const text = dockerfile();

    // The provider already runs this sandbox `--privileged`, which is an
    // approved and documented decision about Docker-in-Docker. Adding
    // diagnostics must not quietly extend it: no new entrypoint, no new
    // command, and no lingering non-root switch that would change how dockerd
    // starts.
    expect(text).not.toMatch(/^\s*ENTRYPOINT/m);
    expect(text).not.toMatch(/^\s*CMD/m);
    expect(text).not.toMatch(/^\s*USER\s+(?!root\b)/m);
    // No secret, token or credential is baked in, and nothing is fetched from
    // anywhere but the base image's own Alpine repositories.
    expect(text).not.toMatch(/ARG\s+\w*(TOKEN|SECRET|PASSWORD|KEY)\w*/i);
    expect(text).not.toMatch(/\bcurl\s+-[a-zA-Z]*\s*https?:\/\//);
    expect(text).not.toMatch(/\bwget\s+https?:\/\//);
  });
});

// ------------------------------------------------- 2. the build script guard

describe('the build script treats it like the other sandbox images', () => {
  it('builds it, under an overridable variable', () => {
    const text = buildScript();
    expect(text).toContain('DOCKER_SANDBOX_IMAGE:-jumptotech/lab-docker:latest');
    expect(text).toContain('sandbox-docker.Dockerfile');
  });

  it('includes it in the all-or-none override guard', () => {
    const text = buildScript();

    // The guard exists because setting one variable while leaving another unset
    // overwrites a shared `:latest` tag that every other worktree runs from.
    // A fifth image that was left out of the count would reintroduce exactly
    // that bug, which is what the guard's own comment warns about.
    expect(text).toContain('"${DOCKER_SANDBOX_IMAGE:-}"');
    expect(text).toMatch(/-ne 5 \]\]; then/);
    expect(text).toContain('DOCKER_SANDBOX_IMAGE=jumptotech/lab-docker:<suffix>');
  });
});

// ------------------------------------------------------ 3. the catalog gate

describe('a host that has not built the sandbox image says so', () => {
  function provider(options: { images?: string[]; enabled?: boolean } = {}) {
    const engines = new FakeDockerEngines({ images: options.images ?? [] });
    return new DockerLabProvider({
      engines,
      sandboxDaemonAvailable: options.enabled ?? true,
      sleep: async () => undefined,
    });
  }

  it('is available when the daemon answers and the image is present', async () => {
    const availability = await provider({ images: [DEFAULT_DOCKER_SANDBOX_IMAGE] }).availability();
    expect(availability.available).toBe(true);
  });

  it('is unavailable, with the command that fixes it, when the image is missing', async () => {
    const availability = await provider({ images: ['docker:27-dind'] }).availability();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain(DEFAULT_DOCKER_SANDBOX_IMAGE);
    expect(availability.reason).toContain('has not been built');
    // An operator must be told what to run, not just what is wrong.
    expect(availability.remediation).toBe(DOCKER_SANDBOX_IMAGE_REMEDIATION);
    expect(DOCKER_SANDBOX_IMAGE_REMEDIATION).toContain('npm run sandbox:build');
  });

  it('honours a configured image rather than the default', async () => {
    const engines = new FakeDockerEngines({ images: ['jumptotech/lab-docker:pinned'] });
    const configured = new DockerLabProvider({
      engines,
      sandboxDaemonAvailable: true,
      sandboxImage: 'jumptotech/lab-docker:pinned',
      sleep: async () => undefined,
    });

    expect((await configured.availability()).available).toBe(true);

    // ...and the same provider pointed at an image nobody built is not available.
    const missing = new DockerLabProvider({
      engines,
      sandboxDaemonAvailable: true,
      sandboxImage: 'jumptotech/lab-docker:absent',
      sleep: async () => undefined,
    });
    expect((await missing.availability()).available).toBe(false);
  });

  it('reports the track being disabled before it reports the image', async () => {
    // Order matters for the message an operator reads: a deployment that has
    // not enabled Docker at all should be told that, not told to build an image
    // it has no use for yet.
    const availability = await provider({ images: [], enabled: false }).availability();

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('DOCKER_TRACK_ENABLED');
  });

  it('fails closed when the image cannot be inspected at all', async () => {
    const engines = new FakeDockerEngines({ images: [DEFAULT_DOCKER_SANDBOX_IMAGE] });
    engines.host.unreachable = 'host daemon is not responding';

    const availability = await new DockerLabProvider({
      engines,
      sandboxDaemonAvailable: true,
      sleep: async () => undefined,
    }).availability();

    // Not available, and never "available because we could not check".
    expect(availability.available).toBe(false);
  });
});
