/**
 * Container image comparison.
 *
 * The kubelet reports images with registry prefixes the student never typed
 * (`docker.io/library/nginx:stable`), and Kubernetes treats a missing tag as
 * `:latest`. Both are normalised away before comparison, so a correct answer
 * passes regardless of how it was spelled — while a genuinely different image
 * or tag still fails.
 */

/** Parse `repo:tag` / `repo@digest`, defaulting a missing tag to `latest`. */
export function normalizeImageReference(image: string): string {
  const trimmed = image.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes('@')) return trimmed;

  // A colon before the last slash belongs to a registry port, not a tag.
  const lastColon = trimmed.lastIndexOf(':');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastColon > lastSlash) return trimmed;
  return `${trimmed}:latest`;
}

const REGISTRY_PREFIXES = [
  'docker.io/library/',
  'index.docker.io/library/',
  'docker.io/',
  'index.docker.io/',
];

/** True when the observed image satisfies the required image. */
export function imageMatches(required: string, observed: string): boolean {
  const norm = (value: string) => {
    let v = normalizeImageReference(value);
    for (const prefix of REGISTRY_PREFIXES) {
      if (v.startsWith(prefix)) {
        v = v.slice(prefix.length);
        break;
      }
    }
    return v;
  };
  return norm(required) === norm(observed);
}
