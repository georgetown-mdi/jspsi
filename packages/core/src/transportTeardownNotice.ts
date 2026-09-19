// The one piece of a run's transport-teardown notice two workspaces both
// handle: the CLI writes it on its operator log, and the console reads it back
// out of the run's stderr tail. Both consume this package, so the text lives
// here and neither side keeps a copy of the other's.

/**
 * The clause a run's transport-teardown notice holds exactly when the
 * abandoned close may have left this party's protocol files in the shared
 * exchange directory.
 *
 * The CLI composes its stderr notice from it (`teardownCeilingNotice` in
 * apps/cli/src/transportTeardown.ts), and the console matches a run's retained
 * stderr tail against it to tell whether the run reported those leftovers
 * (`attachStderrTail` in apps/web/src/jobs/cliDriver.ts). A clause rather than
 * the notice's opening, so the console inherits the CLI's own classification of
 * what the close left rather than re-deriving it: a WebRTC run has no protocol
 * files and a retain-mode run keeps its own as a transcript, and the notice
 * states this for neither.
 */
export const TEARDOWN_LEFTOVER_FILES_CLAUSE =
  "remove any protocol files this run left there";
