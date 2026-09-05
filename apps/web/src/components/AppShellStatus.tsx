import { useSyncExternalStore } from "react";

import { Alert, Button } from "@mantine/core";

import {
  appShellUpdateReady,
  applyAppShellUpdate,
  subscribeAppShellUpdate,
} from "@utils/appShellUpdate";
import { useOnlineStatus } from "./useOnlineStatus";

/** Whether a newer app version is installed and waiting. Always `false` on the
 * server, which registers no worker. */
function useAppShellUpdateReady(): boolean {
  return useSyncExternalStore(
    subscribeAppShellUpdate,
    appShellUpdateReady,
    () => false,
  );
}

/**
 * The shell-wide status strip: what the app cannot do right now, above whatever
 * route is rendering.
 *
 * OFFLINE. The app shell and the recurring-exchange list are served from the
 * service worker's cache and read the browser's own store, so they render with
 * no network -- but an exchange is a live two-party session and cannot. Stating
 * it once at the shell keeps the warning off the surfaces that still work and
 * names the action that cannot run, rather than letting it fail when the
 * operator presses it.
 *
 * UPDATE READY. A new deployment's worker waits rather than swapping code under
 * a running page, so applying it is an explicit reload. See
 * `apps/web/src/utils/appShellUpdate.ts`.
 *
 * Renders nothing when the browser is online and no update is waiting, which is
 * the ordinary case.
 */
export function AppShellStatus() {
  const online = useOnlineStatus();
  const updateReady = useAppShellUpdateReady();

  if (online && !updateReady) return null;

  return (
    <div role="status" aria-live="polite">
      {!online && (
        <Alert
          color="yellow"
          variant="light"
          radius={0}
          title="You are offline"
        >
          Your recurring exchanges and their details are stored in this browser
          and open without a connection. Running an exchange does need one -- it
          takes you and your partner online at the same time.
        </Alert>
      )}
      {updateReady && (
        <Alert
          color="blue"
          variant="light"
          radius={0}
          title="A new version of psilink is ready"
        >
          Reload to use it. It replaces the app&apos;s code; your saved
          exchanges stay in this browser.{" "}
          <Button
            size="compact-sm"
            variant="default"
            onClick={applyAppShellUpdate}
          >
            Reload
          </Button>
        </Alert>
      )}
    </div>
  );
}
