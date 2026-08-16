/**
 * Service requirement handlers.
 *
 * A Service that exists, has the right type, and exposes the right port can
 * still route to nothing. `service_endpoints` is the check that catches that:
 * it reads the EndpointSlices Kubernetes built from the Service's selector, so
 * it fails exactly when a real client would get no answer.
 */
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';

export const serviceExists: VerifierHandler<'service_exists'> = {
  type: 'service_exists',
  label: (r) => `Service ${r.name} exists`,
  async run(r, reader) {
    const service = await reader.service(r.name);
    return service ? pass() : missing('Service', r.name, reader.namespace);
  },
};

export const serviceType: VerifierHandler<'service_type'> = {
  type: 'service_type',
  label: (r) => `Service ${r.name} is of type ${r.expected}`,
  async run(r, reader) {
    const service = await reader.service(r.name);
    if (!service) return missing('Service', r.name, reader.namespace);
    return service.type === r.expected
      ? pass()
      : fail(`Service type is '${service.type}', expected '${r.expected}'`);
  },
};

export const servicePort: VerifierHandler<'service_port'> = {
  type: 'service_port',
  label: (r) => `Service ${r.name} exposes port ${r.port}`,
  async run(r, reader) {
    const service = await reader.service(r.name);
    if (!service) return missing('Service', r.name, reader.namespace);

    if (service.ports.length === 0) return fail('Service exposes no ports');

    const onPort = service.ports.filter((p) => p.port === r.port);
    if (onPort.length === 0) {
      const observed = service.ports.map((p) => p.port).join(', ');
      return fail(`Service does not expose port ${r.port} — it exposes ${observed}`);
    }

    const match = onPort.find((p) => {
      if (r.protocol && p.protocol !== r.protocol) return false;
      if (r.target_port !== undefined) {
        // An omitted targetPort defaults to the Service port.
        const target = p.targetPort ?? p.port;
        if (String(target) !== String(r.target_port)) return false;
      }
      return true;
    });
    if (match) return pass();

    const detail = onPort
      .map((p) => `port ${p.port} → target ${String(p.targetPort ?? p.port)}/${p.protocol}`)
      .join(', ');
    const wanted = [
      r.target_port !== undefined ? `target ${String(r.target_port)}` : null,
      r.protocol ? `protocol ${r.protocol}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return fail(`Port ${r.port} is exposed but does not match ${wanted} — found ${detail}`);
  },
};

export const serviceSelector: VerifierHandler<'service_selector'> = {
  type: 'service_selector',
  label: (r) => `Service ${r.name} selects the intended Pods`,
  async run(r, reader) {
    const service = await reader.service(r.name);
    if (!service) return missing('Service', r.name, reader.namespace);

    if (Object.keys(service.selector).length === 0) {
      return fail('Service defines no selector, so it targets no Pods');
    }

    const problems: string[] = [];
    for (const [key, expected] of Object.entries(r.selector)) {
      const actual = service.selector[key];
      if (actual === undefined) problems.push(`selector is missing '${key}'`);
      else if (actual !== expected) {
        problems.push(`selector '${key}' is '${actual}', expected '${expected}'`);
      }
    }
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },
};

export const serviceEndpoints: VerifierHandler<'service_endpoints'> = {
  type: 'service_endpoints',
  label: (r) =>
    `Service ${r.name} has ${r.min_ready === 1 ? 'a ready backend endpoint' : `at least ${r.min_ready} ready backend endpoints`}`,
  async run(r, reader) {
    const service = await reader.service(r.name);
    if (!service) return missing('Service', r.name, reader.namespace);

    const endpoints = await reader.endpoints(r.name);
    const ready = endpoints?.readyAddresses ?? 0;
    if (ready >= r.min_ready) return pass();

    const notReady = endpoints?.notReadyAddresses ?? 0;
    if (ready === 0 && notReady === 0) {
      return fail(
        'The Service has no backend endpoints — no Pod in this namespace currently matches it',
      );
    }
    return fail(
      `The Service has ${ready} ready backend endpoint${ready === 1 ? '' : 's'}${
        notReady > 0 ? ` and ${notReady} not-ready` : ''
      }, expected at least ${r.min_ready}`,
    );
  },
};
