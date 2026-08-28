import { useEffect } from "react";

import { isInstalledRuntime as installedRuntime } from "@utils/installedRuntime";

import type { ManagedScheduleRuntimeOptions } from "@psi/managedScheduleRuntime";

/** The seams the mount reads its environment through, so a test can drive the
 * gate and the runtime it guards without an installed app. */
export interface ScheduledExchangeRunnerProps {
  /** Whether this page is an installed app runtime. Defaults to
   * {@link isInstalledRuntime}. */
  isInstalledRuntime?: () => boolean;
  /** Starts the runner. Defaults to {@link startInstalledRuntimeRunner}. */
  start?: (options: ManagedScheduleRuntimeOptions) => void;
}

/**
 * Load the runner and start it. The import is dynamic because this component is
 * mounted by the app ROOT, on every route: the runtime pulls in the whole
 * exchange stack (the rendezvous, the transport, the PSI engine), and a static
 * import here would put all of it in the chunk every page load fetches, for a
 * capability only an installed runtime ever uses.
 */
async function startInstalledRuntimeRunner(
  options: ManagedScheduleRuntimeOptions,
): Promise<void> {
  const { startManagedScheduleRuntime } =
    await import("@psi/managedScheduleRuntime");
  // The mount can go while the chunk is still loading.
  if (options.signal.aborted) return;
  startManagedScheduleRuntime(options);
}

/**
 * The runtime-wide mount of the unattended scheduled runner. It renders nothing:
 * a due window's surfacing belongs to the exchange's own surfaces, and this
 * component exists only so the runner is bound to the app runtime's lifetime
 * rather than to whichever route happens to be open.
 *
 * THE GATE. The runner starts only in an installed app runtime. An unattended
 * run needs a runtime that is open when the window opens -- an installed copy
 * launched at OS login -- and an ordinary tab is not that: the operator opened
 * it for something and will close it, so firing an exchange under it would start
 * a live two-party session the operator is about to navigate away from, and
 * would do it without their asking. In an ordinary tab a run stays
 * operator-initiated (docs/MANAGED_EXCHANGE.md, "The automation goal and its
 * platform envelope").
 *
 * The effect runs once, on the client only; the gate is read there rather than
 * during render so a server render never reaches the media query.
 */
export function ScheduledExchangeRunner({
  isInstalledRuntime = installedRuntime,
  start = startInstalledRuntimeRunner,
}: ScheduledExchangeRunnerProps) {
  useEffect(() => {
    if (!isInstalledRuntime()) return;
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
