import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';

export const ingressExists: VerifierHandler<'ingress_exists'> = {
  type: 'ingress_exists',
  label: (r) => `Ingress ${r.name} exists`,
  async run(r, reader) {
    const ingress = await reader.ingress(r.name);
    if (!ingress) return missing('Ingress', r.name, reader.namespace);
    if (ingress.deleting) return fail(`Ingress '${r.name}' exists but is terminating`);
    return pass();
  },
};

export const ingressClass: VerifierHandler<'ingress_class'> = {
  type: 'ingress_class',
  label: (r) => `Ingress ${r.name} uses ingressClassName ${r.ingressClassName}`,
  async run(r, reader) {
    const ingress = await reader.ingress(r.name);
    if (!ingress) return missing('Ingress', r.name, reader.namespace);
    return ingress.ingressClassName === r.ingressClassName
      ? pass()
      : fail(`ingressClassName is '${ingress.ingressClassName ?? 'unset'}', expected '${r.ingressClassName}'`);
  },
};

export const ingressRule: VerifierHandler<'ingress_rule'> = {
  type: 'ingress_rule',
  label: (r) => `Ingress ${r.name} routes ${r.host}${r.path} to ${r.service}:${String(r.port)}`,
  async run(r, reader) {
    const ingress = await reader.ingress(r.name);
    if (!ingress) return missing('Ingress', r.name, reader.namespace);

    const match = ingress.rules.find(
      (rule) =>
        rule.host === r.host &&
        rule.path === r.path &&
        rule.service === r.service &&
        String(rule.port) === String(r.port) &&
        (r.pathType === undefined || rule.pathType === r.pathType),
    );
    return match
      ? pass()
      : fail(`No rule routing ${r.host}${r.path} to Service '${r.service}' on port ${String(r.port)}`);
  },
};

export const ingressTls: VerifierHandler<'ingress_tls'> = {
  type: 'ingress_tls',
  label: (r) => `Ingress ${r.name} terminates TLS for ${r.hosts.join(', ')}`,
  async run(r, reader) {
    const ingress = await reader.ingress(r.name);
    if (!ingress) return missing('Ingress', r.name, reader.namespace);

    const match = ingress.tls.find(
      (entry) =>
        entry.secretName === r.secretName &&
        r.hosts.every((host) => entry.hosts.includes(host)),
    );
    return match
      ? pass()
      : fail(`No TLS entry with secret '${r.secretName}' covering ${r.hosts.join(', ')}`);
  },
};

export const ingressDefaultBackend: VerifierHandler<'ingress_default_backend'> = {
  type: 'ingress_default_backend',
  label: (r) => `Ingress ${r.name} default backend is ${r.service}:${String(r.port)}`,
  async run(r, reader) {
    const ingress = await reader.ingress(r.name);
    if (!ingress) return missing('Ingress', r.name, reader.namespace);
    const backend = ingress.defaultBackend;
    if (!backend) return fail('Ingress defines no default backend');
    if (backend.service !== r.service || String(backend.port) !== String(r.port)) {
      return fail(
        `Default backend is ${backend.service}:${String(backend.port)}, expected ${r.service}:${String(r.port)}`,
      );
    }
    return pass();
  },
};
