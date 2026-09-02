// How a connection-per-poll idle boundary is CLASSIFIED: the boundary a
// completed session reached, the two questions a reading of one answers, and the
// exhaustive tables that project an idle-release outcome onto both.
//
// Everything here is a declaration or a pure lookup over one recorded outcome:
// nothing holds adapter state, reaches an ssh2 or ssh2-sftp-client value, or
// issues a server round trip. The outcome is what the adapter records; the
// reading a boundary leaves behind and whether it ended a session generation are
// projections of it, which is why each table is exhaustive over its key type --
// a fourth boundary variant or a further outcome states every answer or it does
// not compile. The model these belong to is
// docs/notes/sftp-adapter-state-machine.md.
import type { IdleBoundaryOutcome } from "./sftpAdapterLedger";

// How the session's last completed boundary was reached. `deliberatelyReleased`
// is the connection-per-poll release having been itself what ended the session;
// `releasedOverEndedTransport` is that same release having closed over a
// transport already ended without it -- a PARTNER-side drop is the shape it
// exists for -- so the session's absence is the release's while the LOSS is not
// its doing. `notReleased` is everything else -- including a release that raised,
// one that walked into the PEER's teardown, and one that could not clear the
// session it destroyed.
export type SessionBoundary =
  "deliberatelyReleased" | "releasedOverEndedTransport" | "notReleased";

// What a boundary reading answers at each of the two sites that reads one. The
// two questions are separate, and conflating them is what the middle variant
// exists to stop: a release that closed over a partner's drop took the session
// away exactly as any other release did, while the loss an operation suffered at
// that boundary is the partner's and the operator must see it counted and warned.
export interface SessionBoundaryReadings {
  // Whether the session is absent because a release of this adapter's took it,
  // read by the recovery chokepoint's pre-establish gate and by the deferred
  // cleanup delete (see SSH2SFTPClientAdapter.idleReleaseLeftNoSession). It is
  // also what no transition may leave standing over a LIVE session (see
  // SSH2SFTPClientAdapter.runTransition).
  readonly releaseTookTheSession: boolean;
  // Whether the loss the session suffered at this boundary was this adapter's own
  // doing, and so exempt from the reconnect counters, the cumulative
  // mid-exchange budget and the operator warning. It is what the cause a boundary
  // charges is read off (see SSH2SFTPClientAdapter.recordIdleBoundaryOutcome).
  readonly lossWasDeliberate: boolean;
}

// Exhaustive over the boundary readings, so a fourth cannot be added without
// stating both answers for it.
export const SESSION_BOUNDARY_READINGS: Record<
  SessionBoundary,
  SessionBoundaryReadings
> = {
  deliberatelyReleased: {
    releaseTookTheSession: true,
    lossWasDeliberate: true,
  },
  releasedOverEndedTransport: {
    releaseTookTheSession: true,
    lossWasDeliberate: false,
  },
  notReleased: { releaseTookTheSession: false, lossWasDeliberate: false },
};

// The session reading each idle-boundary outcome leaves behind, or `unchanged`
// where the boundary closed nothing and the standing reading is not the
// release's to move. Exhaustive over the outcomes, so a new one cannot be added
// without stating what it leaves for the recovery chokepoint's gate and for the
// loss classification.
//
// `forced` is `unchanged` for a reason of its own rather than because it closed
// nothing: the forcing says how the boundary concluded, not who ended the
// transport beneath it, and the entry classification has already recorded that
// answer. Reading it back is what keeps a partner drop this side had to force
// closed over charged to the partner rather than exempted as a deliberate
// release.
export const IDLE_BOUNDARY_SESSION_READING: Record<
  IdleBoundaryOutcome,
  SessionBoundary | "unchanged"
> = {
  skipped: "unchanged",
  held: "unchanged",
  declined: "unchanged",
  alreadyEnded: "unchanged",
  noSession: "notReleased",
  closedByPeer: "notReleased",
  releasedOverEndedTransport: "releasedOverEndedTransport",
  released: "deliberatelyReleased",
  forced: "unchanged",
  didNotClose: "notReleased",
  destroyDidNotClear: "unchanged",
};

// Whether an idle-boundary outcome ENDED the session's generation, which is what
// decides whether it charges a loss at all. Exhaustive on the same terms as the
// projection above.
export const IDLE_BOUNDARY_ENDS_THE_GENERATION: Record<
  IdleBoundaryOutcome,
  boolean
> = {
  skipped: false,
  held: false,
  declined: false,
  alreadyEnded: false,
  noSession: true,
  closedByPeer: true,
  releasedOverEndedTransport: true,
  released: true,
  forced: true,
  didNotClose: false,
  destroyDidNotClear: false,
};

// The projection above, read as the lookup the adapter's record site makes. The
// table stays exported because its exhaustiveness is what a reader of this seam
// checks.
export function idleBoundarySessionReading(
  outcome: IdleBoundaryOutcome,
): SessionBoundary | "unchanged" {
  return IDLE_BOUNDARY_SESSION_READING[outcome];
}
