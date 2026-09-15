/**
 * "What should I do next?" — answered by rules, never by a model.
 *
 * The suggestion is a pure function of three things the platform already
 * knows: the catalog's order (tracks as the API orders them, labs by their
 * declared `order`), this student's saved per-lab status, and the order of
 * their recent attempts. Every suggestion carries the rule that produced it, in
 * words, so a student can see why it was chosen.
 *
 * In priority order:
 *
 *   1. A lab they started and have not completed — the most recently attempted
 *      one if the history says which, otherwise the first in catalog order.
 *   2. The next uncompleted lab in the track of their most recent attempt.
 *   3. The first uncompleted lab in catalog order.
 *
 * Labs whose environment cannot run on this deployment are never suggested.
 * With no progress data there is no suggestion at all: guessing where a
 * student stands would be exactly the fabrication the dashboard must not do.
 */
import type { LabProgressEntry, LabSummary, TrackSummary } from './types';

export interface Suggestion {
  lab: LabSummary;
  reason: string;
}

interface Inputs {
  /** Already in catalog order (see `sortLabs`). */
  labs: LabSummary[];
  tracks: TrackSummary[];
  progressFor: (labId: string) => LabProgressEntry | undefined;
  /** Lab ids of recent attempts, newest first. */
  recentLabIds?: string[];
}

const startable = (lab: LabSummary) => lab.availability?.available !== false;

export function nextInTrack(
  trackLabs: LabSummary[],
  progressFor: (labId: string) => LabProgressEntry | undefined,
): LabSummary | undefined {
  return trackLabs.find((lab) => startable(lab) && progressFor(lab.id)?.status !== 'COMPLETED');
}

export function suggestNextLab({ labs, tracks, progressFor, recentLabIds = [] }: Inputs): Suggestion | null {
  const candidates = labs.filter(startable);
  if (candidates.length === 0) return null;

  const title = (track: string) => tracks.find((t) => t.track === track)?.title ?? track;
  const byId = new Map(candidates.map((lab) => [lab.id, lab]));

  // 1. Unfinished work.
  const inProgress = candidates.filter((lab) => progressFor(lab.id)?.status === 'IN_PROGRESS');
  if (inProgress.length > 0) {
    const recent = recentLabIds
      .map((id) => byId.get(id))
      .find((lab): lab is LabSummary => lab !== undefined && progressFor(lab.id)?.status === 'IN_PROGRESS');
    const lab = recent ?? inProgress[0]!;
    return { lab, reason: 'You started this lab and have not completed it yet.' };
  }

  // 2. Carry on in the track they were last working in.
  const lastLab = recentLabIds.map((id) => labs.find((lab) => lab.id === id)).find(Boolean);
  if (lastLab) {
    const next = nextInTrack(
      candidates.filter((lab) => lab.track === lastLab.track),
      progressFor,
    );
    if (next) {
      return { lab: next, reason: `The next lab you have not completed in ${title(next.track)}.` };
    }
  }

  // 3. The first thing not yet done, in catalog order.
  const first = nextInTrack(candidates, progressFor);
  if (!first) return null;
  const anyDone = candidates.some((lab) => progressFor(lab.id)?.status === 'COMPLETED');
  return {
    lab: first,
    reason: anyDone
      ? `The first lab you have not completed in ${title(first.track)}.`
      : `The first lab in ${title(first.track)} — a good place to begin.`,
  };
}
