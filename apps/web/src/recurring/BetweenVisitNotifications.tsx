import { useCallback, useEffect, useState } from "react";

import { Button } from "@mantine/core";

import {
  disableBetweenVisitNotifications as disableNotifications,
  enableBetweenVisitNotifications as enableNotifications,
  betweenVisitNotificationState as readNotificationState,
} from "@psi/managed/betweenVisitNotifier";

import { isConsoleBuild as consoleBuild } from "@utils/clientConfig";
import { isInstalledRuntime as installedRuntime } from "@utils/installedRuntime";

import styles from "@styles/app.module.css";

import { betweenVisitNotificationDisplay } from "./betweenVisitNotificationModel";

import type { BetweenVisitNotificationState } from "@psi/managed/betweenVisitNotifier";

/** The call sites this control reads its environment through, so a test can drive
 * every state without an installed app or a browser permission. */
interface BetweenVisitNotificationsProps {
  /** Whether this page is an installed app runtime. Defaults to
   * {@link isInstalledRuntime}. */
  isInstalledRuntime?: () => boolean;
  /** Whether this is a console build. Defaults to {@link isConsoleBuild}. */
  isConsoleBuild?: () => boolean;
  /** Where the opt-in and the browser's permission stand. Defaults to
   * {@link betweenVisitNotificationState}. */
  readState?: () => BetweenVisitNotificationState;
  /** Asks for permission and remembers the opt-in. Defaults to
   * {@link enableBetweenVisitNotifications}. */
  enable?: () => Promise<BetweenVisitNotificationState>;
  /** Drops the opt-in. Defaults to
   * {@link disableBetweenVisitNotifications}. */
  disable?: () => void;
}

/**
 * The operator's opt-in to OS notifications about scheduled runs, shown beside
 * the recurring exchanges the notifications would be about.
 *
 * The browser's permission prompt is reached through a press of this control and
 * through no render, so no visit meets a prompt it did not ask for -- a prompt at
 * first load is refused once and can never be asked again
 * (docs/MANAGED_EXCHANGE.md, "The between-visit notification").
 *
 * It renders nothing outside an installed app runtime, which is the only runtime
 * that runs a schedule unattended: offering notifications where nothing runs
 * between visits would promise what the app cannot do. A console build runs no
 * schedule of its own either -- recurrence there is the host scheduler's -- so it
 * shows nothing too.
 *
 * The state is read after mount rather than during render: a server render
 * reaches neither the permission nor this device's stored choice.
 */
export function BetweenVisitNotifications({
  isInstalledRuntime = installedRuntime,
  isConsoleBuild = consoleBuild,
  readState = readNotificationState,
  enable = enableNotifications,
  disable = disableNotifications,
}: BetweenVisitNotificationsProps) {
  const [state, setState] = useState<BetweenVisitNotificationState>();
  useEffect(() => {
    if (isConsoleBuild() || !isInstalledRuntime()) return;
    setState(readState());
    // Mount-scoped by design: the runtime gate cannot change its answer while
    // this page is open (see isInstalledRuntime), and every later reading
    // follows the operator's own press below.
  }, []);
  const turnOn = useCallback(() => {
    void enable().then(setState);
  }, [enable]);
  const turnOff = useCallback(() => {
    disable();
    setState(readState());
  }, [disable, readState]);

  if (state === undefined) return null;
  const display = betweenVisitNotificationDisplay(state);
  if (display === undefined) return null;
  const action = display.action;
  return (
    <>
      <p className={`${styles.sub} ${styles.small}`}>{display.note}</p>
      {action === undefined ? null : (
        <p>
          <Button variant="default" onClick={action.turnsOn ? turnOn : turnOff}>
            {action.label}
          </Button>
        </p>
      )}
    </>
  );
}
