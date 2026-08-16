/**
 * Batch workload handlers (Job, CronJob).
 *
 * The distinction these labs turn on is that a Job is *finished* work while a
 * CronJob is a *schedule* for work. So a Job is graded on its terminal
 * condition, and a CronJob on its configuration — deliberately not on whether
 * it has fired yet, because a lab must not require a student to sit and wait
 * for a five-minute cron window before their work can be marked correct.
 */
import { imageMatches } from '../image.js';
import type { VerifierHandler } from '../contract.js';
import { fail, missing, pass } from '../contract.js';
import { selectContainer } from './pods.js';

export const jobExists: VerifierHandler<'job_exists'> = {
  type: 'job_exists',
  label: (r) => `Job ${r.name} exists`,
  async run(r, reader) {
    const job = await reader.job(r.name);
    if (!job) return missing('Job', r.name, reader.namespace);
    if (job.deleting) return fail(`Job '${r.name}' exists but is terminating`);
    return pass();
  },
};

/**
 * The Job finished successfully.
 *
 * `Complete` is the authoritative signal — a Job asking for several completions
 * can report successes while still running, so a non-zero `succeeded` count
 * alone would pass too early.
 */
export const jobCompleted: VerifierHandler<'job_completed'> = {
  type: 'job_completed',
  label: (r) => `Job ${r.name} completed successfully`,
  async run(r, reader) {
    const job = await reader.job(r.name);
    if (!job) return missing('Job', r.name, reader.namespace);

    if (r.min_succeeded !== undefined) {
      return job.succeeded >= r.min_succeeded
        ? pass()
        : fail(
            `Job '${r.name}' has ${job.succeeded} successful completion${job.succeeded === 1 ? '' : 's'}, expected at least ${r.min_succeeded}`,
          );
    }

    if (job.complete) return pass();

    if (job.failedCondition) {
      const reason = job.failureReason ? ` (${job.failureReason})` : '';
      return fail(
        `Job '${r.name}' failed${reason} — ${job.failed} failed pod${job.failed === 1 ? '' : 's'}`,
      );
    }
    if (job.active > 0) {
      return fail(
        `Job '${r.name}' is still running — ${job.succeeded} of ${job.completions} completion${job.completions === 1 ? '' : 's'} done, ${job.active} pod(s) active`,
      );
    }
    return fail(
      `Job '${r.name}' has not completed — ${job.succeeded} of ${job.completions} completion${job.completions === 1 ? '' : 's'} succeeded`,
    );
  },
};

export const jobImage: VerifierHandler<'job_image'> = {
  type: 'job_image',
  label: (r) => `Job ${r.name} uses image ${r.image}`,
  async run(r, reader) {
    const job = await reader.job(r.name);
    if (!job) return missing('Job', r.name, reader.namespace);

    if (!r.container) {
      if (job.containers.length === 0) return fail('Job declares no containers');
      if (job.containers.some((c) => imageMatches(r.image, c.image))) return pass();
      const observed = job.containers.map((c) => c.image).join(', ');
      return fail(`Incorrect image — found '${observed}', expected '${r.image}'`);
    }

    const { container, detail } = selectContainer(job, r.container);
    if (!container) return fail(`Job '${r.name}' has ${detail}`);
    return imageMatches(r.image, container.image)
      ? pass()
      : fail(
          `Incorrect image — container '${container.name}' is set to '${container.image}', expected '${r.image}'`,
        );
  },
};

export const cronJobExists: VerifierHandler<'cronjob_exists'> = {
  type: 'cronjob_exists',
  label: (r) => `CronJob ${r.name} exists`,
  async run(r, reader) {
    const cronJob = await reader.cronJob(r.name);
    if (!cronJob) return missing('CronJob', r.name, reader.namespace);
    if (cronJob.deleting) return fail(`CronJob '${r.name}' exists but is terminating`);
    return pass();
  },
};

/** Cron fields are whitespace-separated; collapse runs so spacing never fails a student. */
function normalizeSchedule(schedule: string): string {
  return schedule.trim().split(/\s+/).join(' ');
}

export const cronJobSchedule: VerifierHandler<'cronjob_schedule'> = {
  type: 'cronjob_schedule',
  label: (r) => `CronJob ${r.name} runs on schedule ${r.schedule}`,
  async run(r, reader) {
    const cronJob = await reader.cronJob(r.name);
    if (!cronJob) return missing('CronJob', r.name, reader.namespace);

    return normalizeSchedule(cronJob.schedule) === normalizeSchedule(r.schedule)
      ? pass()
      : fail(`Schedule is '${cronJob.schedule}', expected '${r.schedule}'`);
  },
};

export const cronJobSuspended: VerifierHandler<'cronjob_suspended'> = {
  type: 'cronjob_suspended',
  label: (r) =>
    r.expected ? `CronJob ${r.name} is suspended` : `CronJob ${r.name} is not suspended`,
  async run(r, reader) {
    const cronJob = await reader.cronJob(r.name);
    if (!cronJob) return missing('CronJob', r.name, reader.namespace);

    if (cronJob.suspend === r.expected) return pass();
    return fail(
      r.expected
        ? `CronJob '${r.name}' is active, expected it to be suspended`
        : `CronJob '${r.name}' is suspended, so it will never run`,
    );
  },
};
