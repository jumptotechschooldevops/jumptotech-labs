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
 *   bash
 *        ↓
 *   verifier reads the real filesystem back
 * ```
 *
 * Everything mechanical lives in `ContainerLabProvider`; this file exists to
 * pin the image and the provider id, and to say what a Linux sandbox is for.
 *
 * The image is built on the host by `npm run sandbox:build`, deliberately not
 * by this process — building an image needs the Docker socket, and the same
 * rule that keeps `kind` cluster creation out of the API applies here.
 */
import type { ContainerRuntimePort } from './container/runtime.js';
import { ContainerLabProvider } from './container/sandbox-provider.js';

export const DEFAULT_LINUX_SANDBOX_IMAGE = 'jumptotech/lab-linux:latest';

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
      ...(options.home ? { home: options.home } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
}
