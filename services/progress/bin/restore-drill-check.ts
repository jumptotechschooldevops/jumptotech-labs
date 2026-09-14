#!/usr/bin/env node
/**
 * BETA-P0-013 — the application half of the restore drill.
 *
 *   DATABASE_URL=… tsx services/progress/bin/restore-drill-check.ts
 *
 * Run by `scripts/db-restore-drill.sh` against a database it has just restored.
 * psql reading the rows back proves the data returned; this proves the api
 * could serve it. It goes through the same config loader, transport rules, pool
 * and repository the api uses, reads history written before the backup, and
 * writes a new attempt through the restored constraints and sequence.
 *
 * It expects the drill's seed data (`scripts/db-restore-drill/seed.sql`) and
 * writes one student and one attempt, so it is not for any other database.
 */
import { randomUUID } from 'node:crypto';
import {
  PostgresDatabase,
  PostgresProgressRepository,
  describeDatabase,
  loadDatabaseConfig,
  resolveDatabaseTransport,
} from '../src/postgres/index.js';

const KNOWN_STUDENT = 'drill-student-003';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  check(config, 'DATABASE_URL is not set');
  resolveDatabaseTransport(config, process.env, 'restore-drill');

  const db = PostgresDatabase.fromConfig(config);
  const repository = new PostgresProgressRepository(db);
  try {
    console.log(`[restore-drill] application check against ${describeDatabase(config)}`);

    const progress = await repository.listProgress(KNOWN_STUDENT);
    const completed = progress.filter((entry) => entry.status === 'COMPLETED').length;
    check(
      progress.length === 10 && completed === 7,
      `expected 7 of 10 labs completed for ${KNOWN_STUDENT}, read ${completed} of ${progress.length}`,
    );
    const attempts = await repository.listAttempts(KNOWN_STUDENT, 50);
    check(attempts.length === 10, `expected 10 attempts for ${KNOWN_STUDENT}, read ${attempts.length}`);
    console.log(
      `[restore-drill] read restored history: ${completed} of ${progress.length} labs completed, ${attempts.length} attempts`,
    );

    const at = new Date().toISOString();
    const studentId = `drill-restored-${randomUUID().slice(0, 8)}`;
    await repository.ensureStudent({ studentId, identitySource: 'restore-drill', displayName: 'Restored', at });
    const attempt = await repository.createAttempt({
      attemptId: randomUUID(),
      studentId,
      labId: 'K8S-001',
      track: 'kubernetes',
      startedAt: at,
    });
    const found = await repository.findAttempt(attempt.attemptId);
    check(found?.status === 'IN_PROGRESS', 'the new attempt could not be read back');

    // A restore that lost the sequence position would hand out seq 1 again.
    const { rows } = await db.query<{ seq: number; previous: number }>(
      `SELECT (SELECT seq FROM lab_attempts WHERE attempt_id = $1) AS seq,
              (SELECT max(seq) FROM lab_attempts WHERE attempt_id <> $1) AS previous`,
      [attempt.attemptId],
    );
    const row = rows[0];
    check(row && row.seq > row.previous, 'lab_attempts.seq did not continue after the restored rows');
    console.log(`[restore-drill] wrote a new attempt through the repository (seq ${row.seq}, after ${row.previous})`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[restore-drill] application check FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
