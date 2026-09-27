/**
 * The api's side of the migration rollback boundary (disaster-recovery audit).
 *
 * services/progress/test/migration-rollback-boundary.test.ts proves the runner
 * refuses a database a newer release migrated unless told otherwise. This pins
 * who tells it: production refuses by default, and only an explicit
 * DATABASE_ALLOW_NEWER_SCHEMA=true — a rollback decision — lets older code start
 * on the newer schema. Development keeps branch switching working.
 */
import { describe, expect, it } from 'vitest';
import { loadProgressConfig } from '../src/config.js';

describe('DATABASE_ALLOW_NEWER_SCHEMA', () => {
  it('is off in production unless set', () => {
    expect(loadProgressConfig({ NODE_ENV: 'production' }).allowNewerSchema).toBe(false);
  });

  it('is an explicit production override', () => {
    expect(loadProgressConfig({ NODE_ENV: 'production', DATABASE_ALLOW_NEWER_SCHEMA: 'true' }).allowNewerSchema).toBe(true);
    expect(loadProgressConfig({ NODE_ENV: 'production', DATABASE_ALLOW_NEWER_SCHEMA: 'false' }).allowNewerSchema).toBe(false);
  });

  it('is on outside production, so a laptop can switch branches', () => {
    expect(loadProgressConfig({}).allowNewerSchema).toBe(true);
    expect(loadProgressConfig({ NODE_ENV: 'test' }).allowNewerSchema).toBe(true);
    expect(loadProgressConfig({ NODE_ENV: 'development', DATABASE_ALLOW_NEWER_SCHEMA: 'false' }).allowNewerSchema).toBe(false);
  });
});
