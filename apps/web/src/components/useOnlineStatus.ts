import { useSyncExternalStore } from "react";

import { isOnline, subscribeOnlineStatus } from "@utils/networkStatus";

/**
 * Whether the browser reports a usable network interface, re-rendering on the
 * `online`/`offline` events. Server rendering returns `true`, and the client
 * corrects it on hydration.
 *
 * Only `false` is a reliable answer -- see `apps/web/src/utils/networkStatus.ts`
 * -- so a caller gates on the offline case and never treats `true` as a
 * guarantee that a partner is reachable.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnlineStatus, isOnline, () => true);
}
