import { useEffect } from "react";

import log from "loglevel";

import { isConsoleBuild as consoleBuild } from "@utils/clientConfig";
import { isInstalledRuntime as installedRuntime } from "@utils/installedRuntime";

import type { ManagedScheduleRuntimeOptions } from "@psi/managed/managedScheduleRuntime";

/** The call sites the mount reads its environment through, so a test can drive
 * the gate and the runtime it guards without an installed app. */
export interface ScheduledExchangeRunnerProps {
  /** Whether this page is an installed app runtime. Defaults to
   * {@link isInstalledRuntime}. */
  isInstalledRuntime?: () => boolean;
  /** Whether this is a console build. Defaults to
   * {@link isConsoleBuild}. */
  isConsoleBuild?: () => boolean;
  /** Starts the runner. Defaults to {@link startInstalledRuntimeRunner}. */
  start?: (options: ManagedScheduleRuntimeOptions) => void;
}

/** How the runner's chunk is fetched, injectable so the failure a real fetch can
 * land in is drivable. */
export type ManagedScheduleRuntimeLoader = () => Promise<{
  startManagedScheduleRuntime: (options: ManagedScheduleRuntimeOptions) => void;
}>;

/** What a chunk that never arrived is logged as, so the runner's silence has one
 * searchable line behind it. */
export const RUNNER_LOAD_FAILURE_NOTICE =
  "scheduled managed exchange runner could not load; it will not run in this app runtime:";

/**
 * Load the runner and start it. The import is dynamic because this component is
 * mounted by the app ROOT, on every route: the runtime pulls in the whole
 * exchange stack (the rendezvous, the transport, the PSI engine), and a static
 * import here would put all of it in the chunk every page load fetches, for a
 * capability only an installed runtime ever uses.
 *
 * A load that fails -- a first launch with no network and nothing precached, a
 * cached shell asking a deployment for a chunk it no longer serves -- takes the
 * runner out for this whole app runtime, so it is logged rather than left as a
 * rejection nobody handles. The retry unit is the MOUNT: the loop
 * that would retry on a later wake lives inside the very chunk that did not
 * arrive, so there is nothing here to retry from short of a second timer with
 * its own policy. The next launch of the installed runtime mounts again and
 * fetches again, which is the recovery this shape has.
 */
export function startInstalledRuntimeRunner(
  options: ManagedScheduleRuntimeOptions,
  load: ManagedScheduleRuntimeLoader = () =>
    import("@psi/managed/managedScheduleRuntime"),
): void {
  load()
    .then(({ startManagedScheduleRuntime }) => {
      // The mount can go while the chunk is still loading.
      if (options.signal.aborted) return;
      startManagedScheduleRuntime(options);
    })
    .catch((error: unknown) => {
      log.error(RUNNER_LOAD_FAILURE_NOTICE, error);
    });
}

/**
 * The runtime-wide mount of the unattended scheduled runner. It renders nothing:
 * showing a due window belongs to the exchange's own surfaces, and this
 * component exists only so the runner is bound to the app runtime's lifetime
 * rather than to whichever route happens to be open.
 *
 * THE GATE, in two halves. The runner starts only in an installed app runtime.
 * An unattended run needs a runtime that is open when the window opens -- an
 * installed copy launched at OS login -- and an ordinary tab is not that: the
 * operator opened it for something and will close it, so firing an exchange
 * under it would start a live two-party session the operator is about to
 * navigate away from, and would do it without their asking. In an ordinary tab
 * a run stays operator-initiated (docs/MANAGED_EXCHANGE.md, "The automation
 * goal and its platform envelope").
 *
 * The console shares this app's code but not that capability: it is a
 * single-exchange, author-and-run surface for one operator, whose recurring
 * production form is the CLI on the host's own scheduler (docs/DEPLOYMENT.md,
 * "The web application can run as a console appliance"). Recurrence there is
 * the host scheduler's, so a console build starts no unattended runner whatever
 * the runtime reports.
 *
 * The effect runs once, on the client only; the gate is read there rather than
 * during render so a server render never reaches the media query.
 */
export function ScheduledExchangeRunner({
  isInstalledRuntime = installedRuntime,
  isConsoleBuild = consoleBuild,
  start = startInstalledRuntimeRunner,
}: ScheduledExchangeRunnerProps) {
  useEffect(() => {
    if (isConsoleBuild() || !isInstalledRuntime()) return;
    const controller = new AbortController();
    start({ signal: controller.signal });
    return () => {
      controller.abort();
    };
    // Mount-scoped by design: the runner is bound to the runtime's lifetime, and
    // re-reading the gate cannot change its answer (see isInstalledRuntime).
  }, []);
  return null;
}
