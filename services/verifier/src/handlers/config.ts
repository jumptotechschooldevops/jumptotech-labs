/**
 * Configuration requirement handlers (ConfigMap, Secret).
 *
 * Secret handling is deliberately shallow: the platform reads key *names* and
 * the Secret type, never the values. A lab can require that a Secret exists
 * with certain keys; it cannot be used to exfiltrate what a student put in it.
 */
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';

export const configMapExists: VerifierHandler<'configmap_exists'> = {
  type: 'configmap_exists',
  label: (r) => `ConfigMap ${r.name} exists`,
  async run(r, reader) {
    const configMap = await reader.configMap(r.name);
    return configMap ? pass() : missing('ConfigMap', r.name, reader.namespace);
  },
};

export const configMapKey: VerifierHandler<'configmap_key'> = {
  type: 'configmap_key',
  label: (r) =>
    r.value === undefined
      ? `ConfigMap ${r.name} contains the key ${r.key}`
      : `ConfigMap ${r.name} sets ${r.key}=${r.value}`,
  async run(r, reader) {
    const configMap = await reader.configMap(r.name);
    if (!configMap) return missing('ConfigMap', r.name, reader.namespace);

    const actual = configMap.data[r.key];
    if (actual === undefined) {
      const keys = Object.keys(configMap.data);
      return fail(
        keys.length === 0
          ? `ConfigMap '${r.name}' has no data keys`
          : `ConfigMap '${r.name}' has no key '${r.key}' — it defines ${keys.map((k) => `'${k}'`).join(', ')}`,
      );
    }
    if (r.value === undefined) return pass();

    return actual === r.value
      ? pass()
      : fail(`Key '${r.key}' is '${actual}', expected '${r.value}'`);
  },
};

export const secretExists: VerifierHandler<'secret_exists'> = {
  type: 'secret_exists',
  label: (r) => `Secret ${r.name} exists`,
  async run(r, reader) {
    const secret = await reader.secret(r.name);
    return secret ? pass() : missing('Secret', r.name, reader.namespace);
  },
};

/**
 * A Secret carries a key.
 *
 * Only key *names* are compared. There is no `value` on this requirement type
 * and no code path that decodes `data`, so a Secret's contents never enter the
 * platform, the logs, or a check result.
 */
export const secretKey: VerifierHandler<'secret_key'> = {
  type: 'secret_key',
  label: (r) => `Secret ${r.name} contains the key ${r.key}`,
  async run(r, reader) {
    const secret = await reader.secret(r.name);
    if (!secret) return missing('Secret', r.name, reader.namespace);

    if (secret.keys.includes(r.key)) return pass();
    return fail(
      secret.keys.length === 0
        ? `Secret '${r.name}' has no data keys`
        : `Secret '${r.name}' has no key '${r.key}' — it defines ${secret.keys.map((k) => `'${k}'`).join(', ')}`,
    );
  },
};

export const secretType: VerifierHandler<'secret_type'> = {
  type: 'secret_type',
  label: (r) => `Secret ${r.name} is of type ${r.expected}`,
  async run(r, reader) {
    const secret = await reader.secret(r.name);
    if (!secret) return missing('Secret', r.name, reader.namespace);
    return secret.type === r.expected
      ? pass()
      : fail(`Secret '${r.name}' is of type '${secret.type}', expected '${r.expected}'`);
  },
};
