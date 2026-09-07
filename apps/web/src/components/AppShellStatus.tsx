import { useSyncExternalStore } from "react";

import { Alert, Button, VisuallyHidden } from "@mantine/core";

import {
  appShellUpdateReady,
  applyAppShellUpdate,
  subscribeAppShellUpdate,
} from "@utils/appShellUpdate";
import { useDeferredAnnouncement } from "./useDeferredAnnouncement";
import { useOnlineStatus } from "./useOnlineStatus";

/** The offline strip's title, and what the shell's polite region announces for
 * it -- the strip's body stays in reading order. */
const OFFLINE_TITLE = "You are offline";

/** The waiting-update strip's title, announced the same way. */
const UPDATE_READY_TITLE = "A new version of psilink is ready";

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
 * ANNOUNCING. The polite region lives as long as the shell, holding nothing in
 * the ordinary case, so a strip that appears mid-session reaches an assistive
 * technology as a change to a region it is already observing rather than as a
 * freshly inserted node. Each Alert takes `role="presentation"` to displace Mantine's
 * `role="alert"` default, which would announce the same strip a second time and
 * interrupt.
 *
 * Nothing is shown when the browser is online and no update is waiting, which is
 * the ordinary case.
 */
export function AppShellStatus() {
  const online = useOnlineStatus();
  const updateReady = useAppShellUpdateReady();
  const announcement = useDeferredAnnouncement(
    [online ? "" : OFFLINE_TITLE, updateReady ? UPDATE_READY_TITLE : ""]
      .filter((sentence) => sentence !== "")
      .join(". "),
  );

  return (
    <>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </VisuallyHidden>
      {!online && (
        <Alert
          color="yellow"
          variant="light"
          radius={0}
          role="presentation"
          title={OFFLINE_TITLE}
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
          role="presentation"
          title={UPDATE_READY_TITLE}
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
    </>
  );
}
