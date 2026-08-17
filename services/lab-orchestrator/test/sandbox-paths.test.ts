/**
 * PLATFORM-004 — sandbox path safety (story test requirement 28).
 *
 * Filesystem and Terraform requirements name paths, and those paths end up in a
 * read inside a student's sandbox. Two gates stand in front of that, and this
 * file pins both: the shape check the lab schema applies, and the resolved-path
 * check the runtime applies immediately before reading.
 *
 * The second gate is the one that matters. A path can look safe segment by
 * segment and still normalise somewhere else, so the *resolved* result is
 * re-checked against the sandbox home rather than the input being trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  LabDefinitionError,
  assertSafeSandboxPath,
  isSafeSandboxPath,
  resolveSandboxPath,
  SandboxPathError,
  parseLabDefinition,
} from '../src/index.js';

const HOME = '/home/student';

const TRAVERSALS = [
  '../etc/passwd',
  '../../../../etc/shadow',
  'deploy/../../etc/hosts',
  'deploy/../..',
  '/etc/passwd',
  '/',
  '~/.ssh/id_rsa',
  '~',
  './deploy',
  'deploy/./release.txt',
  'deploy//release.txt',
  'deploy\\release.txt',
  'C:\\Windows\\System32',
  '',
  'deploy/release.txt\0/etc/passwd',
  'deploy/$(whoami)',
  'deploy/`id`',
  'deploy/;rm -rf /',
  'deploy/file name.txt',
  '.hidden/../../root',
];

describe('sandbox path validation (test requirement 28)', () => {
  it('accepts ordinary relative paths inside the sandbox', () => {
    for (const good of ['deploy', 'deploy/release.txt', 'terraform/build/manifest.txt', 'a.b-c_d']) {
      expect(isSafeSandboxPath(good)).toBe(true);
      expect(() => assertSafeSandboxPath(good)).not.toThrow();
    }
  });

  it('accepts dotfiles, which is where much of the state a lab grades lives', () => {
    // `.terraform/` and its lock file are exactly what `terraform_initialized`
    // has to look at, so refusing a leading dot would make the check unable to
    // read the thing it exists to check.
    for (const good of [
      'terraform/.terraform',
      'terraform/.terraform.lock.hcl',
      '.bashrc',
      '.config/app/settings.conf',
    ]) {
      expect(isSafeSandboxPath(good), `expected '${good}' to be accepted`).toBe(true);
    }
    expect(resolveSandboxPath(HOME, 'terraform/.terraform')).toBe(
      '/home/student/terraform/.terraform',
    );
  });

  it('still refuses the dot segments that mean traversal', () => {
    for (const bad of ['.', '..', 'a/..', 'a/./b', '...', 'a/.../b']) {
      expect(isSafeSandboxPath(bad), `expected '${bad}' to be rejected`).toBe(false);
    }
  });

  it('rejects every form of traversal, absolute path and shell metacharacter', () => {
    for (const bad of TRAVERSALS) {
      expect(isSafeSandboxPath(bad), `expected '${bad}' to be rejected`).toBe(false);
      expect(() => assertSafeSandboxPath(bad)).toThrow(SandboxPathError);
    }
  });

  it('rejects non-strings and over-long paths', () => {
    expect(isSafeSandboxPath(undefined)).toBe(false);
    expect(isSafeSandboxPath(42)).toBe(false);
    expect(isSafeSandboxPath({ path: 'deploy' })).toBe(false);
    expect(isSafeSandboxPath('a'.repeat(256))).toBe(false);
  });

  it('resolves a safe path under the sandbox home', () => {
    expect(resolveSandboxPath(HOME, 'deploy/release.txt')).toBe('/home/student/deploy/release.txt');
    expect(resolveSandboxPath('/home/student/', 'deploy')).toBe('/home/student/deploy');
  });

  it('refuses to resolve anything that would land outside the home', () => {
    for (const bad of TRAVERSALS) {
      expect(() => resolveSandboxPath(HOME, bad)).toThrow(SandboxPathError);
    }
  });

  it('will not resolve against a relative sandbox home', () => {
    expect(() => resolveSandboxPath('home/student', 'deploy')).toThrow(/absolute path/);
  });
});

// --- the same rule, enforced at the schema layer ----------------------------

const LAB_HEAD = `
id: LINUX-900
slug: linux-900-example
title: Example
track: linux
topic: permissions
difficulty: beginner
duration_minutes: 30
environment:
  provider: linux
task:
  summary: Example summary
  description: Example description
references:
  - title: chmod(1)
    url: https://man7.org/linux/man-pages/man1/chmod.1.html
skills:
  - linux.filesystem.create
`;

/**
 * The validation issues a definition produced.
 *
 * `LabDefinitionError.message` is only a count; the precise, field-level lines
 * an author needs live in `issues`, and that is what these assertions read —
 * the same text the startup log prints.
 */
function issuesFrom(yaml: string): string[] {
  try {
    parseLabDefinition(yaml);
  } catch (error) {
    if (error instanceof LabDefinitionError) return error.issues;
    throw error;
  }
  throw new Error('expected the lab definition to be rejected');
}

function labWithPath(requirementPath: string): string {
  return `${LAB_HEAD}
requirements:
  - type: file_exists
    path: ${JSON.stringify(requirementPath)}
    label: A file exists
`;
}

describe('the lab schema refuses an unsafe path before anything reads it', () => {
  it('accepts a relative path inside the sandbox', () => {
    const def = parseLabDefinition(labWithPath('deploy/release.txt'));
    expect(def.requirements[0]).toMatchObject({ type: 'file_exists', path: 'deploy/release.txt' });
  });

  it('rejects a traversal, an absolute path and a home-relative path', () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', '~/.ssh/id_rsa', 'deploy/../../root']) {
      expect(issuesFrom(labWithPath(bad)).join('\n'), `expected '${bad}' to be rejected`).toMatch(
        /relative path inside the sandbox home/,
      );
    }
  });

  it('refuses a Kubernetes requirement on a Linux lab, and vice versa', () => {
    const linuxAskingForPods = `${LAB_HEAD}
requirements:
  - type: pod_exists
    name: nginx
    label: Pod exists
`;
    expect(issuesFrom(linuxAskingForPods).join('\n')).toMatch(
      /is a kubernetes check, which the 'linux' provider cannot verify/,
    );

    const kubernetesAskingForFiles = linuxAskingForPods
      .replace('track: linux', 'track: kubernetes')
      .replace('provider: linux', 'provider: kubernetes')
      .replace('url: https://man7.org/linux/man-pages/man1/chmod.1.html', 'url: https://kubernetes.io/docs/concepts/workloads/pods/')
      .replace('linux.filesystem.create', 'kubernetes.pods.create')
      .replace('  - type: pod_exists\n    name: nginx\n    label: Pod exists\n', '  - type: file_mode\n    path: deploy\n    mode: "750"\n    label: Mode is right\n');
    expect(issuesFrom(kubernetesAskingForFiles).join('\n')).toMatch(
      /is a filesystem check, which the 'kubernetes' provider cannot verify/,
    );
  });
});
