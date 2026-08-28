/**
 * The one reason every surface that starts an exchange gives while the browser
 * reports no network. The inviter's create, the acceptor's launch, the console's
 * direct run, and the managed re-run each state it at the control they hold, and
 * the lobby states it as advice above entries that only navigate and read, so an
 * operator held back meets one explanation rather than a different sentence per
 * screen.
 *
 * Only the offline direction is ever gated on it: `navigator.onLine === true`
 * says an interface exists, not that the partner or the coordination server is
 * reachable (see `apps/web/src/utils/networkStatus.ts`), so no surface reads it
 * as a promise that a run will work.
 *
 * Those surfaces span every channel psilink runs -- a browser exchange reaching
 * the partner's browser, a console SFTP run reaching the server the two parties
 * agreed on, and a console shared-folder run reaching the mount a sync tool
 * keeps in step -- so the sentence names the network the run needs rather than a
 * connection to the partner, which only one of them makes. The simultaneity is
 * what all of them do share, so it is stated outright.
 */
export const OFFLINE_EXCHANGE_REASON =
  "This device is offline, so an exchange cannot run: it needs the network for " +
  "the whole run -- to your partner's browser, an agreed server, or a shared " +
  "folder -- and your partner has to be running their side at the same time.";
