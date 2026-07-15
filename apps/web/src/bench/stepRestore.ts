/**
 * The restore-clamp predicates for the two benches: given a step a history entry
 * names and the backing state the bench currently holds, the step that can
 * actually render. A browser Back can land on an entry whose work column reads
 * state a later action cleared -- an inviter `share` entry a start-over emptied
 * of its invitation, an acceptor `launched` entry a back-to-columns recovery
 * emptied of its launch -- and rendering it would leave the operator on a blank
 * or bogus column. The invariant these encode: a step is restored only when the
 * state its work column requires still exists, else it clamps to the nearest
 * step whose backing state the clearing action left intact.
 *
 * Pure and dependency-free so the clamp is the tested boundary, pinned without
 * mounting either bench.
 */

import type { SpineTarget } from "./inviterModel";

/** The inviter bench's work-column sections: the required spine, the Customize
 * tabs, and the two terminal surfaces. */
export type Section = SpineTarget | "share" | "save";

/** The backing state the inviter's guarded sections read: `share` renders only
 * with a live invitation, `save` only under a CLI transport. */
export interface SectionPreconditions {
  hasInvitation: boolean;
  isCliTransport: boolean;
}

/** The section to restore for `requested`: the section itself when its backing
 * state still exists, else `review` -- the nearest step whose state (the loaded
 * file and derived terms) a start-over leaves intact. */
export function restorableSection(
  requested: Section,
  preconditions: SectionPreconditions,
): Section {
  if (requested === "share" && !preconditions.hasInvitation) return "review";
  if (requested === "save" && !preconditions.isCliTransport) return "review";
  return requested;
}

/** The position token to restore for `token`: the token itself when its backing
 * state still exists, else `columns` -- the nearest step whose state (the
 * acquired file and confirmed columns) a back-to-columns recovery leaves intact.
 * `launched` reads the run the launch drives, which that recovery clears. */
export function restorablePosition(
  token: string,
  preconditions: { hasLaunch: boolean },
): string {
  if (token === "launched" && !preconditions.hasLaunch) return "columns";
  return token;
}
