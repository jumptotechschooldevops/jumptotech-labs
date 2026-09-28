/**
 * Plans — what an entitlement lets its holder use (docs/commercial-access.md §10).
 *
 * An entitlement says *whether* and *until when* somebody may use labs. A plan
 * says *what*: which tracks, and how many labs at once. Plans are
 * configuration, never code: the product has made no decision about which plans
 * exist or what they include, so nothing here names one. A deployment with no
 * plan file has no plans, and every entitlement is what it was before plans
 * existed — every track, the deployment's own session limits.
 *
 * ```json
 * { "plans": [
 *   { "id": "beta", "name": "Private beta", "tracks": "all" },
 *   { "id": "fixture-linux", "name": "Linux only", "tracks": ["linux"], "maxConcurrentSessions": 1 }
 * ] }
 * ```
 *
 * No price lives here. What a plan costs is decided with, and charged by, a
 * billing provider (docs/commercial-access.md §9); the platform owns only what
 * the plan entitles.
 *
 * Plans can narrow, never widen, the deployment's safety limits:
 * `maxConcurrentSessions` is capped by `MAX_ACTIVE_SESSIONS_PER_STUDENT`, and
 * `MAX_ACTIVE_SESSIONS` still bounds the whole platform.
 */
import { readFileSync } from 'node:fs';

/** Plan ids: short, lower-case, stable — they are stored on entitlements. */
export const PLAN_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TRACK_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PLANS = 50;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

export interface Plan {
  id: string;
  /** Shown to the student and the operator. */
  name: string;
  description: string | null;
  /** `all`, or the track ids this plan includes. */
  tracks: 'all' | readonly string[];
  /** Labs one holder may run at once; null = the deployment's per-student limit. */
  maxConcurrentSessions: number | null;
}

export class PlanConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanConfigError';
  }
}

export class PlanCatalog {
  readonly #plans: ReadonlyMap<string, Plan>;

  constructor(plans: readonly Plan[] = []) {
    this.#plans = new Map(plans.map((plan) => [plan.id, plan]));
  }

  get(id: string): Plan | undefined {
    return this.#plans.get(id);
  }

  list(): Plan[] {
    return [...this.#plans.values()];
  }

  get size(): number {
    return this.#plans.size;
  }

  /**
   * Every track a plan names must exist in the lab catalog. A typo in a plan
   * file would otherwise silently sell a track nobody can open.
   */
  assertTracksExist(knownTracks: ReadonlySet<string>): void {
    for (const plan of this.#plans.values()) {
      if (plan.tracks === 'all') continue;
      const unknown = plan.tracks.filter((track) => !knownTracks.has(track));
      if (unknown.length > 0) {
        throw new PlanConfigError(
          `Plan ${plan.id} names track(s) the lab catalog does not have: ${unknown.join(', ')}. ` +
            `Known tracks: ${[...knownTracks].sort().join(', ')}.`,
        );
      }
    }
  }
}

/** Whether a plan (or no plan: everything) includes a track. */
export function planIncludesTrack(plan: Plan | null, track: string | undefined): boolean {
  if (!plan || plan.tracks === 'all') return true;
  return track !== undefined && plan.tracks.includes(track);
}

/**
 * The number of labs one holder may run at once: the stricter of the
 * deployment's per-student limit and the plan's. A plan never raises the
 * deployment's limit — that is a capacity safety control, not a product one.
 */
export function effectiveSessionLimit(
  deploymentLimit: number | undefined,
  plan: Plan | null,
): number | undefined {
  const planLimit = plan?.maxConcurrentSessions ?? undefined;
  if (planLimit === undefined) return deploymentLimit;
  if (deploymentLimit === undefined) return planLimit;
  return Math.min(deploymentLimit, planLimit);
}

/** Parse and validate a plan document. Refuses anything it does not understand. */
export function parsePlans(document: unknown, source = 'the plan file'): PlanCatalog {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new PlanConfigError(`${source} must be a JSON object with a "plans" array.`);
  }
  const top = document as Record<string, unknown>;
  const extraTop = Object.keys(top).filter((key) => key !== 'plans');
  if (extraTop.length > 0) throw new PlanConfigError(`${source}: unknown top-level field(s) ${extraTop.join(', ')}.`);
  if (!Array.isArray(top.plans)) throw new PlanConfigError(`${source} must have a "plans" array.`);
  if (top.plans.length > MAX_PLANS) throw new PlanConfigError(`${source} defines more than ${MAX_PLANS} plans.`);

  const plans: Plan[] = [];
  const seen = new Set<string>();
  top.plans.forEach((raw, index) => {
    const where = `${source} plans[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlanConfigError(`${where} must be an object.`);
    const entry = raw as Record<string, unknown>;
    const allowed = ['id', 'name', 'description', 'tracks', 'maxConcurrentSessions'];
    const extra = Object.keys(entry).filter((key) => !allowed.includes(key));
    if (extra.length > 0) throw new PlanConfigError(`${where}: unknown field(s) ${extra.join(', ')}.`);

    if (typeof entry.id !== 'string' || !PLAN_ID_SHAPE.test(entry.id)) {
      throw new PlanConfigError(`${where}.id must be 1–32 of a-z, 0-9 and '-', starting with a letter or digit.`);
    }
    if (seen.has(entry.id)) throw new PlanConfigError(`${where}.id ${entry.id} is defined twice.`);
    seen.add(entry.id);

    if (typeof entry.name !== 'string' || entry.name.trim() === '' || entry.name.length > MAX_NAME) {
      throw new PlanConfigError(`${where}.name must be 1–${MAX_NAME} characters.`);
    }
    if (
      entry.description !== undefined &&
      (typeof entry.description !== 'string' || entry.description.length > MAX_DESCRIPTION)
    ) {
      throw new PlanConfigError(`${where}.description must be text of at most ${MAX_DESCRIPTION} characters.`);
    }

    let tracks: Plan['tracks'];
    if (entry.tracks === 'all') {
      tracks = 'all';
    } else if (
      Array.isArray(entry.tracks) &&
      entry.tracks.length > 0 &&
      entry.tracks.every((track) => typeof track === 'string' && TRACK_ID_SHAPE.test(track))
    ) {
      tracks = Object.freeze([...new Set(entry.tracks as string[])]);
    } else {
      // Required and explicit: an absent list must not quietly mean "everything".
      throw new PlanConfigError(`${where}.tracks must be "all" or a non-empty list of track ids.`);
    }

    let maxConcurrentSessions: number | null = null;
    if (entry.maxConcurrentSessions !== undefined) {
      const value = entry.maxConcurrentSessions;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
        throw new PlanConfigError(`${where}.maxConcurrentSessions must be a whole number from 1 to 100.`);
      }
      maxConcurrentSessions = value;
    }

    plans.push(
      Object.freeze({
        id: entry.id,
        name: entry.name.trim(),
        description: typeof entry.description === 'string' ? entry.description.trim() || null : null,
        tracks,
        maxConcurrentSessions,
      }),
    );
  });
  return new PlanCatalog(plans);
}

/**
 * The plan document: `ACCESS_PLANS_FILE` (a path) or `ACCESS_PLANS_JSON` (the
 * document itself, for a compose deployment that has nowhere to mount a file).
 * Neither: no plans. Both, or either unreadable or invalid: the api refuses to
 * start, rather than running with a different set of plans than the operator
 * wrote.
 */
export function plansFromEnv(env: NodeJS.ProcessEnv, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): PlanCatalog {
  const file = env.ACCESS_PLANS_FILE?.trim();
  const inline = env.ACCESS_PLANS_JSON?.trim();
  if (file && inline) throw new PlanConfigError('Set ACCESS_PLANS_FILE or ACCESS_PLANS_JSON, not both.');
  if (inline) {
    let document: unknown;
    try {
      document = JSON.parse(inline);
    } catch {
      throw new PlanConfigError('ACCESS_PLANS_JSON is not valid JSON.');
    }
    return parsePlans(document, 'ACCESS_PLANS_JSON');
  }
  if (!file) return new PlanCatalog();
  let text: string;
  try {
    text = read(file);
  } catch (error) {
    throw new PlanConfigError(`ACCESS_PLANS_FILE=${file} cannot be read: ${(error as Error).message}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new PlanConfigError(`ACCESS_PLANS_FILE=${file} is not valid JSON.`);
  }
  return parsePlans(document, `ACCESS_PLANS_FILE=${file}`);
}

/**
 * Trials — docs/commercial-access.md §10.
 *
 * How long a trial lasts is a business decision, so there is no default: with
 * `TRIAL_DURATION_DAYS` unset, trials cannot be started at all. `TRIAL_PLAN`
 * optionally names the plan a trial is on; unset, a trial is on no plan
 * (every track, the deployment's limits).
 */
export interface TrialConfig {
  durationDays: number | null;
  planId: string | null;
}

export function trialFromEnv(env: NodeJS.ProcessEnv, plans: PlanCatalog): TrialConfig {
  const rawDays = env.TRIAL_DURATION_DAYS?.trim();
  let durationDays: number | null = null;
  if (rawDays) {
    if (!/^\d{1,3}$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 365) {
      throw new PlanConfigError('TRIAL_DURATION_DAYS must be a whole number of days from 1 to 365.');
    }
    durationDays = Number(rawDays);
  }
  const planId = env.TRIAL_PLAN?.trim() || null;
  if (planId !== null) {
    if (!plans.get(planId)) throw new PlanConfigError(`TRIAL_PLAN=${planId} is not a plan in ACCESS_PLANS_FILE.`);
    if (durationDays === null) throw new PlanConfigError('TRIAL_PLAN is set but TRIAL_DURATION_DAYS is not.');
  }
  return { durationDays, planId };
}
