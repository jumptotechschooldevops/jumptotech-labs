/**
 * What a platform error means to a student.
 *
 * The API answers with a stable `code`, a message and sometimes a remediation.
 * Those are written for everybody — operators, integrators, the student — and
 * several remediations name commands only an operator can run. Rendering them
 * raw turned "every environment is busy" into `LAB_CAPACITY_REACHED` in red.
 *
 * This maps each code the student can actually meet to a plain title, what
 * happened, and what they can do about it. Three rules:
 *
 *   1. **The code is never hidden.** It is kept as `reference`, rendered small,
 *      so a student can quote it to an instructor and an operator can find the
 *      matching log line and runbook.
 *   2. **Unknown codes fall back to the API's own message** when the page was
 *      *reading* something, never to a generic "something went wrong": a new
 *      error is still explained by the server. An *action on the environment*
 *      (launch, verify, reset, end, terminal) is different. Its unknown codes
 *      are the provider's — `SETUP_FAILED`, `EXEC_FAILED`, `KUBECTL_UNAVAILABLE`
 *      — and their messages are raw kubectl or exec output with internal paths
 *      in it, so those get plain words for the action instead (the code is
 *      still the reference).
 *   3. **A platform fault is never described as the student's mistake.** An
 *      unreadable environment during Verify is `environment`, not a failure.
 *
 * Nothing here decides behaviour. The caller still reads the code (for example,
 * to offer Continue on STUDENT_SESSION_LIMIT_REACHED).
 */
import { ApiRequestError } from './api';
import type { ApiError } from './types';

export type ErrorKind =
  /** Every environment on the platform is in use. Retry later. */
  | 'capacity'
  /** This student already holds their quota of running labs. */
  | 'student-limit'
  /** The browser's sign-in is gone. */
  | 'auth'
  /** The platform could not be reached at all. */
  | 'network'
  | 'not-found'
  /** The session exists but is not in a state that allows this. */
  | 'not-ready'
  /** A backend this needs is down; nothing the student did. */
  | 'unavailable'
  /** The sandbox could not be read or attached; nothing the student did. */
  | 'environment'
  /** An operation ran and did not finish. */
  | 'failed'
  /** Accepted, still finishing in the background. */
  | 'pending'
  | 'unknown';

export interface StudentError {
  kind: ErrorKind;
  title: string;
  message: string;
  /** What to do next, when there is something to do. */
  guidance?: string;
  /** The API's error code, shown as a support reference. */
  reference: string;
  /** Whether trying the same thing again can reasonably work. */
  retryable: boolean;
}

export type ErrorContext = 'launch' | 'verify' | 'reset' | 'end' | 'load' | 'terminal' | 'progress' | 'activity';

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiRequestError) return error.error;
  return {
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

const FALLBACK_TITLE: Record<ErrorContext, string> = {
  launch: 'The lab could not be started',
  verify: 'Verification could not run',
  reset: 'The lab could not be reset',
  end: 'The lab could not be ended',
  load: 'This page could not be loaded',
  terminal: 'The terminal could not connect',
  progress: 'Your progress could not be loaded',
  activity: 'Your lab could not be kept active',
};

type Known = Omit<StudentError, 'reference'>;

function known(code: string, error: ApiError, context: ErrorContext): Known | null {
  // The api could not *check* the sign-in (its session store was unreachable).
  // The cookie is intact; telling the student to sign in again would be wrong.
  if (code === 'AUTH_UNAVAILABLE') {
    return {
      kind: 'unavailable',
      title: 'The platform is busy for a moment',
      message: 'Your sign-in could not be checked just now. You are still signed in, and your lab keeps running.',
      guidance: 'Try again in a few seconds.',
      retryable: true,
    };
  }
  if (code.startsWith('AUTH_')) {
    return {
      kind: 'auth',
      title: 'Your sign-in has expired',
      message: 'Sign in again to carry on. Your lab environment and saved progress are not affected.',
      retryable: false,
    };
  }

  switch (code) {
    case 'LAB_CAPACITY_REACHED':
      return {
        kind: 'capacity',
        title: 'All lab environments are in use',
        message:
          'Every lab environment on the platform is busy right now. One frees up as soon as another student finishes or goes idle.',
        guidance: 'Please try again in a few minutes.',
        retryable: true,
      };
    case 'LAB_LAUNCHES_PAUSED':
      return {
        kind: 'capacity',
        title: 'New labs are paused',
        message:
          'Starting new labs is paused for maintenance. Labs that are already running keep working.',
        guidance: 'Please try again later.',
        retryable: true,
      };
    case 'STUDENT_SESSION_LIMIT_REACHED': {
      const limit = (error.details as { maxActiveSessionsPerStudent?: unknown } | undefined)
        ?.maxActiveSessionsPerStudent;
      return {
        kind: 'student-limit',
        title: 'You already have a lab running',
        message:
          typeof limit === 'number' && limit > 1
            ? `You can run up to ${limit} labs at a time, and all of them are in use.`
            : 'You can run one lab at a time, and yours is still running.',
        guidance: 'Continue the lab you already have, or end it before starting a different one.',
        retryable: false,
      };
    }
    case 'PROVIDER_UNAVAILABLE':
      return {
        kind: 'unavailable',
        title: 'This kind of lab is unavailable right now',
        message:
          'The platform cannot create this type of environment at the moment. Labs in other tracks may still work.',
        guidance: 'Try again later. If it keeps happening, let your instructor know.',
        retryable: true,
      };
    case 'SESSION_PROVISION_FAILED':
      return {
        kind: 'failed',
        title: 'Your lab environment could not be prepared',
        message: 'Something went wrong while the environment was being created, and it was cleaned up.',
        guidance: 'Try again. If it fails again, tell your instructor and include the reference below.',
        retryable: true,
      };
    case 'API_UNREACHABLE':
      return {
        kind: 'network',
        title: 'Cannot reach JumpToTech Labs',
        message: 'Your browser could not connect to the platform.',
        guidance: 'Check your internet connection, then try again.',
        retryable: true,
      };
    case 'BAD_RESPONSE':
      return {
        kind: 'network',
        title: 'The platform sent an unexpected response',
        message: 'This is usually temporary — for example while the platform is restarting.',
        guidance: 'Wait a moment and try again.',
        retryable: true,
      };
    case 'LAB_NOT_FOUND':
    case 'INVALID_LAB_ID':
      return {
        kind: 'not-found',
        title: 'Lab not found',
        message: 'There is no lab with that id. It may have been renamed or removed from the catalog.',
        guidance: 'Browse the lab catalog to find it.',
        retryable: false,
      };
    case 'TRACK_NOT_FOUND':
    case 'INVALID_TRACK_ID':
      return {
        kind: 'not-found',
        title: 'Track not found',
        message: 'There is no track with that name.',
        retryable: false,
      };
    case 'SESSION_NOT_FOUND':
    case 'INVALID_SESSION_ID':
      return {
        kind: 'not-found',
        title: 'This lab environment no longer exists',
        message:
          'It may have been ended, or released after a period of inactivity or when its time ran out. Your saved progress is not affected.',
        retryable: false,
      };
    case 'SESSION_NOT_ACTIVE':
      return {
        kind: 'not-ready',
        title:
          context === 'verify'
            ? 'Your environment is not ready to verify'
            : 'Your environment is not ready for that',
        message: 'The environment is busy or no longer running, so this could not be done right now.',
        guidance: 'Wait until it shows as Ready, then try again.',
        retryable: true,
      };
    case 'ENVIRONMENT_UNREACHABLE':
      // Providers report it for Reset too, when the sandbox cannot be reached.
      if (context === 'reset') {
        return {
          kind: 'environment',
          title: 'The reset could not reach your environment',
          message:
            'Your lab environment could not be reached, so it was not reset. This is a platform problem, not a mistake in your work.',
          guidance: 'Try Reset again in a moment. If it keeps happening, end the lab and start it again, or let your instructor know.',
          retryable: true,
        };
      }
      return {
        kind: 'environment',
        title: 'Verification could not run',
        message:
          'Your lab environment could not be read, so nothing was checked and nothing was recorded. This is a platform problem, not a mistake in your work.',
        guidance: 'Try Verify again in a moment. If it keeps happening, let your instructor know.',
        retryable: true,
      };
    case 'CREDENTIALS_UNAVAILABLE':
      return {
        kind: 'environment',
        title: 'The terminal could not attach to your environment',
        message: 'The platform could not hand the terminal access to your environment.',
        guidance: 'Try reconnecting. If it keeps happening, Reset or End the lab.',
        retryable: true,
      };
    case 'SESSION_RESET_FAILED':
    case 'RESET_FAILED':
      return {
        kind: 'failed',
        title: 'The reset did not finish',
        message: 'Your environment could not be rebuilt and cannot be used as it is.',
        guidance: 'Press Reset to try again, or End lab to release it.',
        retryable: true,
      };
    case 'DESTROY_FAILED':
    case 'SESSION_CLEANUP_FAILED':
      return {
        kind: 'pending',
        title: 'Your lab is still shutting down',
        message: 'The environment is being removed. Cleanup keeps retrying automatically in the background.',
        guidance: 'You do not need to press End lab again.',
        retryable: false,
      };
    case 'PROGRESS_UNAVAILABLE':
      return {
        kind: 'unavailable',
        title: 'Progress is unavailable right now',
        message: 'Your saved progress could not be read. Lab environments are not affected.',
        guidance: 'Try again later.',
        retryable: true,
      };
    case 'RATE_LIMITED':
      return {
        kind: 'unavailable',
        title: 'Too many requests',
        message: 'This browser sent a lot of requests in a short time, so the platform is asking it to slow down.',
        guidance: 'Wait a minute, then try again. Your lab and saved progress are not affected.',
        retryable: true,
      };
    case 'CHECK_IN_PROGRESS':
      return {
        kind: 'pending',
        title: 'A check is already running',
        message: 'Verify is already checking this lab — perhaps from another tab.',
        guidance: 'Wait a few seconds, then press Verify again.',
        retryable: true,
      };
    case 'INTERNAL_ERROR':
      return {
        kind: 'unknown',
        title: FALLBACK_TITLE[context],
        message: 'Something went wrong on the platform. This is not a mistake in your work.',
        guidance: 'Try again in a moment. If it keeps happening, tell your instructor and include the reference below.',
        retryable: true,
      };
    case 'UNEXPECTED_ERROR':
      // Not from the API at all: an exception in this page. Its text is a
      // JavaScript error message, which means nothing to a student.
      return {
        kind: 'unknown',
        title: FALLBACK_TITLE[context],
        message: 'Something unexpected happened in this page.',
        guidance: 'Reload the page and try again. Your lab and saved progress are not affected.',
        retryable: true,
      };
    case 'ORIGIN_NOT_ALLOWED':
      return {
        kind: 'unknown',
        title: FALLBACK_TITLE[context],
        message: 'The platform refused a request from this page. Reload the page and try again.',
        retryable: true,
      };
    default:
      return null;
  }
}

/**
 * Plain words for an action on the environment that failed with a code this
 * file does not know — rule 2 above. Null for contexts that read, where the
 * server's own message is the better explanation.
 */
function actionFallback(context: ErrorContext): Known | null {
  switch (context) {
    case 'verify':
      // Any refusal the check route does not name is the platform failing to
      // look. It is never a verdict on the student's work.
      return {
        kind: 'environment',
        title: 'Verification could not run',
        message:
          'Your lab environment could not be checked just now, so nothing was checked and nothing was recorded. This is a platform problem, not a mistake in your work.',
        guidance: 'Try Verify again in a moment. If it keeps happening, let your instructor know.',
        retryable: true,
      };
    case 'reset':
      return {
        kind: 'failed',
        title: 'The lab could not be reset',
        message: 'Something went wrong on the platform while resetting your environment. This is not a mistake in your work.',
        guidance: 'Press Reset to try again. If it keeps failing, End lab and launch it again, or let your instructor know.',
        retryable: true,
      };
    case 'end':
      return {
        kind: 'failed',
        title: 'The lab could not be ended',
        message: 'Something went wrong on the platform while ending your lab.',
        guidance: 'Try End lab again in a moment. Your saved progress is not affected.',
        retryable: true,
      };
    case 'launch':
      return {
        kind: 'failed',
        title: 'The lab could not be started',
        message: 'Something went wrong on the platform while preparing your environment.',
        guidance: 'Try again in a moment. If it keeps happening, tell your instructor and include the reference below.',
        retryable: true,
      };
    case 'activity':
      return {
        kind: 'failed',
        title: 'Your lab could not be kept active',
        message: 'Something went wrong on the platform while recording that you are still here.',
        guidance: 'Press Stay active again in a moment. Typing in the terminal also counts as activity.',
        retryable: true,
      };
    case 'terminal':
      return {
        kind: 'environment',
        title: 'The terminal could not connect',
        message: 'Something went wrong while connecting the terminal to your environment.',
        guidance: 'Try again in a moment. If it keeps happening, Reset or End the lab.',
        retryable: true,
      };
    default:
      return null;
  }
}

export function describeError(error: ApiError, context: ErrorContext = 'load'): StudentError {
  const match = known(error.code, error, context) ?? actionFallback(context);
  if (match) return { ...match, reference: error.code };
  return {
    kind: 'unknown',
    title: FALLBACK_TITLE[context],
    // The server's own words: better than a generic line, and never a guess.
    message: error.message || 'The platform did not say why.',
    ...(error.remediation ? { guidance: error.remediation } : {}),
    reference: error.code,
    retryable: true,
  };
}
