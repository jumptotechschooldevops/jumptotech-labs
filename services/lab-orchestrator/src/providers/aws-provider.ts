/**
 * The AWS provider — future architecture, no student ever gets real access.
 *
 * **Nothing in this file provisions anything.** Every lifecycle method refuses
 * with `PROVIDER_UNAVAILABLE`, `availability()` reports unavailable
 * unconditionally, and there is no configuration flag that turns it on. It
 * exists so the shape of an AWS lab is decided *before* anyone is tempted to
 * hand out a key, and so the registry, the reaper, the session model and the
 * terminal binding are already generic enough to accept one.
 *
 * ## The intended production design
 *
 * ```text
 *   Student
 *      ↓
 *   AWS lab session
 *      ↓
 *   sts:AssumeRole  →  temporary scoped credentials (minutes, not hours)
 *      ↓
 *   dedicated per-lab IAM role + permission boundary
 *      ↓
 *   allowed services only, allowed regions only
 *      ↓
 *   every created resource tagged with the session
 *      ↓
 *   budget / cost guard
 *      ↓
 *   automatic cleanup by tag
 * ```
 *
 * ### Ownership tagging
 *
 * Cleanup can only be exact if creation is. Every resource an AWS lab creates
 * must carry, and the permission boundary must *require*, these tags:
 *
 * ```text
 *   jumptotech.io/session-id     the session that owns the resource
 *   jumptotech.io/lab-id         which lab created it
 *   jumptotech.io/student-id     reserved — arrives with authentication
 * ```
 *
 * `aws:RequestTag` conditions in the boundary make an untagged create fail, and
 * `aws:ResourceTag` conditions scope every mutating action to the session's own
 * resources. That is the AWS analogue of the namespace label gate the
 * Kubernetes provider already enforces: cleanup deletes what it owns and
 * nothing else, and it can prove ownership from the resource itself rather than
 * from a record that might be stale.
 *
 * ### The credential contract
 *
 * `credentials()` below is the shape a future implementation returns. Three
 * rules it must keep, all of which the platform already keeps for Kubernetes:
 *
 *   1. credentials are minted per session and expire with it;
 *   2. they never reach the browser — the terminal service fetches them over
 *      the internal, service-authenticated route, exactly as it does a
 *      kubeconfig today;
 *   3. they are never logged and never returned by a public endpoint.
 *
 * ### Cost guard
 *
 * A permission boundary that allows `ec2:RunInstances` allows a student to
 * spend money. The boundary therefore pins instance types, forbids anything
 * with an hourly floor a lab does not need (NAT gateways, provisioned IOPS,
 * dedicated hosts), and every account carries an AWS Budgets action that
 * revokes the lab role when a threshold is crossed. The reaper deletes by tag
 * on the session's deadline; the budget action is the backstop for when
 * something outlives it.
 *
 * ## What "not enabled" means concretely
 *
 * There is no AWS lab in `labs/`, the catalog shows AWS as *Coming soon*, and
 * there is no integration test — because there is nothing real to test against
 * and a mocked AWS would only prove that the mock returns what it was told to.
 */
import {
  ProviderUnavailableError,
  type CreateResult,
  type DestroyResult,
  type EnvironmentInfo,
  type ExecResult,
  type LabProvider,
  type LabSessionContext,
  type ManagedSandbox,
  type ResetResult,
  type TerminalContext,
} from '../types.js';
import { unavailable, type ProviderAvailability } from './catalog.js';

export const AWS_PROVIDER_DISABLED_REASON =
  'AWS labs are architecture only. No student credentials, roles, or resources are created by this platform yet.';

export const AWS_PROVIDER_REMEDIATION =
  'See README → Future AWS provider architecture. Enabling it requires scoped STS roles, a permission boundary, session resource tagging, and a budget guard.';

/** Tag keys every future AWS lab resource must carry. Cleanup depends on them. */
export const AWS_SESSION_TAG = 'jumptotech.io/session-id';
export const AWS_LAB_TAG = 'jumptotech.io/lab-id';
export const AWS_STUDENT_TAG = 'jumptotech.io/student-id';

/**
 * The credential shape a future implementation returns.
 *
 * Deliberately declared now: it is what the terminal binding would carry, and
 * writing it down is what makes "never returned to the browser" checkable.
 */
export interface AwsSessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO-8601. Never longer than the lab session itself. */
  expiresAt: string;
  region: string;
  /** The assumed role, for auditing. */
  roleArn: string;
}

export class AwsLabProvider implements LabProvider {
  readonly id = 'aws' as const;
  readonly name = 'aws-skeleton';
  readonly sandboxKind = 'cloud-session' as const;

  async availability(): Promise<ProviderAvailability> {
    return unavailable(AWS_PROVIDER_DISABLED_REASON, AWS_PROVIDER_REMEDIATION);
  }

  async create(context: LabSessionContext): Promise<CreateResult> {
    return {
      ok: false,
      environment: this.#environment(context),
      steps: [
        {
          id: 'aws-session',
          label: 'AWS lab session',
          status: 'failed',
          detail: AWS_PROVIDER_DISABLED_REASON,
        },
      ],
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message: AWS_PROVIDER_DISABLED_REASON,
        remediation: AWS_PROVIDER_REMEDIATION,
      },
    };
  }

  async status(context: LabSessionContext): Promise<EnvironmentInfo> {
    return this.#environment(context);
  }

  async reset(context: LabSessionContext): Promise<ResetResult> {
    return {
      ok: false,
      removed: [],
      restored: [],
      steps: [],
      environment: this.#environment(context),
      error: { code: 'PROVIDER_UNAVAILABLE', message: AWS_PROVIDER_DISABLED_REASON },
    };
  }

  /**
   * Destroy is a *success* with nothing to do.
   *
   * A provider that never creates anything must still let a session reach a
   * terminal state, or a failed start would sit in `FAILED` forever with the
   * reaper re-entering its teardown on every sweep.
   */
  async destroy(): Promise<DestroyResult> {
    return {
      ok: true,
      namespaceGone: true,
      steps: [
        { id: 'aws-session', label: 'AWS session released', status: 'ok', detail: 'nothing was created' },
      ],
    };
  }

  async destroySandbox(): Promise<DestroyResult> {
    return this.destroy();
  }

  /** Nothing is ever created, so there is never an orphan to reclaim. */
  async listManagedSandboxes(): Promise<ManagedSandbox[]> {
    return [];
  }

  async execute(): Promise<ExecResult> {
    throw new ProviderUnavailableError('aws', AWS_PROVIDER_DISABLED_REASON, AWS_PROVIDER_REMEDIATION);
  }

  async getTerminalContext(): Promise<TerminalContext> {
    throw new ProviderUnavailableError('aws', AWS_PROVIDER_DISABLED_REASON, AWS_PROVIDER_REMEDIATION);
  }

  /**
   * Reserved. A future implementation mints short-lived STS credentials for the
   * session's role and returns them to the *terminal service only*.
   */
  async credentials(): Promise<AwsSessionCredentials> {
    throw new ProviderUnavailableError('aws', AWS_PROVIDER_DISABLED_REASON, AWS_PROVIDER_REMEDIATION);
  }

  #environment(context: LabSessionContext): EnvironmentInfo {
    return {
      environmentId: `aws:disabled/${context.sessionId}#${context.labId}`,
      provider: this.name,
      providerId: this.id,
      phase: 'not_created',
      sandboxKind: this.sandboxKind,
      namespace: '',
      sessionId: context.sessionId,
      message: AWS_PROVIDER_DISABLED_REASON,
    };
  }
}
