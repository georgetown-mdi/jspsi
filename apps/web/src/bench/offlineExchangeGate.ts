/**
 * The one reason every surface that starts an exchange gives while the browser
 * reports no network. The lobby's two entries, the inviter's create, the
 * acceptor's launch, and the managed re-run all state it, so an operator held
 * back meets one explanation rather than a different sentence per screen.
 *
 * Only the offline direction is ever gated on it: `navigator.onLine === true`
 * says an interface exists, not that the partner or the coordination server is
 * reachable (see `apps/web/src/utils/networkStatus.ts`), so no surface reads it
 * as a promise that a run will work.
 */
export const OFFLINE_EXCHANGE_REASON =
  "This device is offline, so an exchange cannot run: it connects straight to " +
  "your partner, who has to be running their side at the same time.";
