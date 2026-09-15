/**
 * The next lab within one track, for the track page.
 *
 * "What should I do next?" across the platform is answered by the learning path
 * — a deterministic rule the API computes from verified progress
 * (`GET /api/me/learning-paths/:pathId`, see docs/learning-paths.md). This is
 * the narrower question a track page asks: the first lab in this track, in its
 * declared order, that is not completed and can run on this deployment.
 */
import type { LabProgressEntry, LabSummary } from './types';

const startable = (lab: LabSummary) => lab.availability?.available !== false;

export function nextInTrack(
  trackLabs: LabSummary[],
  progressFor: (labId: string) => LabProgressEntry | undefined,
): LabSummary | undefined {
  return trackLabs.find((lab) => startable(lab) && progressFor(lab.id)?.status !== 'COMPLETED');
}
