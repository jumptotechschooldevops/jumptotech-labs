/**
 * Container checks.
 *
 * Every handler here is a read of `docker inspect` against the session's own
 * daemon. None of them looks at what the student typed: a container created
 * with `docker run`, with `docker create` + `docker start`, or from a Compose
 * file all produce the same inspect output and all pass identically.
 *
 * Failure detail describes *what was observed*, never what to type. "Container
 * 'web' is exited, not running" tells a student where they are; it does not
 * hand them the command.
 */
import type { DockerVerifierHandler } from '../contract.js';
import { fail, missingDocker, pass } from '../contract.js';
import { imageMatches } from '../image.js';
import { parseDockerMemory, parseDockerCpus, formatBytes, formatNanoCpus } from '../docker-quantity.js';

export const dockerContainerExists: DockerVerifierHandler<'docker_container_exists'> = {
  type: 'docker_container_exists',
  label: (r) => `Container ${r.name} exists`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    return container ? pass(`state: ${container.state}`) : missingDocker('container', r.name);
  },
};

export const dockerContainerRunning: DockerVerifierHandler<'docker_container_running'> = {
  type: 'docker_container_running',
  label: (r) => `Container ${r.name} is running`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);
    if (container.running) return pass();
    // An exit code is the single most useful fact about a container that
    // stopped, so it is surfaced without being told what caused it.
    return fail(
      `Container '${r.name}' is ${container.state}${
        container.state === 'exited' ? ` (exit code ${container.exitCode})` : ''
      }, not running`,
    );
  },
};

export const dockerContainerState: DockerVerifierHandler<'docker_container_state'> = {
  type: 'docker_container_state',
  label: (r) => `Container ${r.name} is ${r.expected}`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);
    return container.state === r.expected
      ? pass()
      : fail(`Container '${r.name}' is ${container.state}, expected ${r.expected}`);
  },
};

export const dockerContainerImage: DockerVerifierHandler<'docker_container_image'> = {
  type: 'docker_container_image',
  label: (r) => `Container ${r.name} runs ${r.image}`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);
    // `imageMatches` normalises registry and library prefixes, so `alpine:3.20`
    // and `docker.io/library/alpine:3.20` are the same answer.
    return imageMatches(container.image, r.image)
      ? pass()
      : fail(`Container '${r.name}' runs image '${container.image}', expected '${r.image}'`);
  },
};

export const dockerContainerExitCode: DockerVerifierHandler<'docker_container_exit_code'> = {
  type: 'docker_container_exit_code',
  label: (r) => `Container ${r.name} exited with code ${r.expected}`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);
    if (container.running) {
      return fail(`Container '${r.name}' is still running, so it has no final exit code yet`);
    }
    return container.exitCode === r.expected
      ? pass()
      : fail(`Container '${r.name}' exited with code ${container.exitCode}, expected ${r.expected}`);
  },
};

export const dockerContainerEnv: DockerVerifierHandler<'docker_container_env'> = {
  type: 'docker_container_env',
  label: (r) =>
    r.value === undefined
      ? `Container ${r.name} has ${r.key} set`
      : `Container ${r.name} has ${r.key}=${r.value}`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);

    const actual = container.env[r.key];
    if (actual === undefined) {
      return fail(`Container '${r.name}' has no environment variable '${r.key}'`);
    }
    if (r.value === undefined) return pass();
    return actual === r.value
      ? pass()
      : fail(`Container '${r.name}' has ${r.key}='${actual}', expected '${r.value}'`);
  },
};

export const dockerContainerPort: DockerVerifierHandler<'docker_container_port'> = {
  type: 'docker_container_port',
  label: (r) =>
    r.host_port === undefined
      ? `Container ${r.name} exposes port ${r.container_port}`
      : `Container ${r.name} publishes ${r.host_port} to ${r.container_port}`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);

    const matching = container.ports.filter(
      (p) => p.containerPort === r.container_port && p.protocol === r.protocol,
    );
    if (matching.length === 0) {
      const seen = container.ports.map((p) => describePort(p)).join(', ');
      return fail(
        `Container '${r.name}' does not expose ${r.container_port}/${r.protocol}${
          seen ? ` (it has: ${seen})` : ' (it publishes no ports)'
        }`,
      );
    }

    if (r.host_port === undefined) return pass();

    const published = matching.find((p) => p.hostPort === r.host_port);
    if (published) return pass();

    const actual = matching.map((p) => p.hostPort).filter((p) => p !== undefined);
    return fail(
      actual.length === 0
        ? `Container '${r.name}' exposes ${r.container_port}/${r.protocol} but does not publish it to a host port`
        : `Container '${r.name}' publishes ${r.container_port}/${r.protocol} on host port ${actual.join(', ')}, expected ${r.host_port}`,
    );
  },
};

export const dockerContainerNetwork: DockerVerifierHandler<'docker_container_network'> = {
  type: 'docker_container_network',
  label: (r) => `Container ${r.name} is attached to network ${r.network}`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);
    if (container.networks.includes(r.network)) return pass();
    return fail(
      `Container '${r.name}' is attached to ${
        container.networks.length > 0 ? container.networks.join(', ') : 'no network'
      }, not '${r.network}'`,
    );
  },
};

export const dockerContainerMount: DockerVerifierHandler<'docker_container_mount'> = {
  type: 'docker_container_mount',
  label: (r) =>
    r.destination === undefined
      ? `Volume ${r.volume} is mounted into container ${r.name}`
      : `Volume ${r.volume} is mounted at ${r.destination} in container ${r.name}`,
  async run(r, reader) {
    const container = await reader.container(r.name);
    if (!container) return missingDocker('container', r.name);

    // Only named volumes count. A bind mount would satisfy "there is something
    // at this path" without teaching what a Docker volume is, which is the
    // whole point of the lab this check serves.
    const volumeMounts = container.mounts.filter((m) => m.type === 'volume');
    const matching = volumeMounts.filter((m) => m.source === r.volume);
    if (matching.length === 0) {
      const seen = volumeMounts.map((m) => `${m.source} at ${m.destination}`).join(', ');
      return fail(
        `Container '${r.name}' has no named volume '${r.volume}' mounted${
          seen ? ` (it has: ${seen})` : ' (it has no volume mounts)'
        }`,
      );
    }

    if (r.destination === undefined) return pass();
    const atPath = matching.find((m) => m.destination === r.destination);
    return atPath
      ? pass()
      : fail(
          `Volume '${r.volume}' is mounted at ${matching.map((m) => m.destination).join(', ')} in '${r.name}', expected ${r.destination}`,
        );
  },
};

export const dockerContainerResourceLimit: DockerVerifierHandler<'docker_container_resource_limit'> =
  {
    type: 'docker_container_resource_limit',
    label: (r) => {
      const parts: string[] = [];
      if (r.memory) parts.push(`memory ${r.memory}`);
      if (r.cpus) parts.push(`${r.cpus} CPU`);
      if (r.pids_limit) parts.push(`${r.pids_limit} processes`);
      return `Container ${r.name} is limited to ${parts.join(' and ')}`;
    },
    async run(r, reader) {
      const container = await reader.container(r.name);
      if (!container) return missingDocker('container', r.name);
      const problems: string[] = [];

      if (r.memory !== undefined) {
        const expected = parseDockerMemory(r.memory);
        const actual = container.limits.memoryBytes;
        if (actual === 0) {
          problems.push('memory is unlimited');
        } else if (actual !== expected) {
          problems.push(`memory is ${formatBytes(actual)}, expected ${formatBytes(expected)}`);
        }
      }

      if (r.cpus !== undefined) {
        const expected = parseDockerCpus(r.cpus);
        const actual = container.limits.nanoCpus;
        if (actual === 0) {
          problems.push('CPU is unlimited');
        } else if (actual !== expected) {
          problems.push(
            `CPU limit is ${formatNanoCpus(actual)}, expected ${formatNanoCpus(expected)}`,
          );
        }
      }

      if (r.pids_limit !== undefined) {
        const actual = container.limits.pidsLimit;
        if (actual <= 0) {
          problems.push('process count is unlimited');
        } else if (actual !== r.pids_limit) {
          problems.push(`process limit is ${actual}, expected ${r.pids_limit}`);
        }
      }

      return problems.length === 0
        ? pass()
        : fail(`Container '${r.name}': ${problems.join('; ')}`);
    },
  };

function describePort(port: { containerPort: number; protocol: string; hostPort?: number }): string {
  return port.hostPort === undefined
    ? `${port.containerPort}/${port.protocol}`
    : `${port.hostPort}->${port.containerPort}/${port.protocol}`;
}
