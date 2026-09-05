// The bound on the one phase of an SFTP dial that ssh2's own connect deadline
// does not cover: the `subsystem sftp` request ssh2-sftp-client issues once ssh2
// reports the client ready. ssh2 clears the `readyTimeout` that
// `server_connect_timeout_ms` sets as soon as authentication succeeds, and the
// request that follows has no deadline of its own, so a server that
// authenticates the operator and then never answers it leaves the dial waiting
// with nothing to end it. Both halves of that -- where the phase begins, and
// that it does not end on its own -- are driven against the pinned stack in
// apps/cli/test/integration/sftpStackPremises.test.ts; the bound itself is
// driven through the adapter in
// apps/cli/test/integration/subsystemOpenBound.test.ts. Re-verify on any ssh2 /
// ssh2-sftp-client bump per docs/spec/DEPENDENCY_PINS.md ("Upgrading the SFTP
// Stack").

import { DEFAULT_SERVER_CONNECT_TIMEOUT_MS } from "@psilink/core";

import { subsystemOpenTimeoutError } from "./sftpAdapterWarnings";

/**
 * The two ssh2 `Client` members the bound reaches past ssh2-sftp-client's public
 * API: the subscription to `'ready'`, which is what arms it, and the unsubscribe
 * that drops the arming when a dial settles first. Both optional, on the same
 * terms as every member of
 * {@link ./sftpClientInternals.Ssh2SftpClientInternals}, whose `client` is what
 * a caller passes: a version that relocated the Client reads undefined here.
 */
export interface SubsystemOpenWatchTarget {
  once?(event: "ready", listener: () => void): void;
  removeListener?(event: "ready", listener: () => void): void;
}

/**
 * The bound applied to one dial's SFTP subsystem-open phase, in milliseconds:
 * the same per-attempt budget the operator already granted the phase before it.
 * Core sets that budget as ssh2's `readyTimeout` from
 * `connection.options.server_connect_timeout_ms`, so one operator-facing setting
 * governs both halves of an attempt rather than a second number to discover.
 *
 * A direct adapter caller that set no usable `readyTimeout` gets the same
 * default the connection schema would have applied.
 *
 * @param readyTimeoutMs - The dial's `readyTimeout`, as the connect options hold
 * it.
 */
export function subsystemOpenTimeoutMs(readyTimeoutMs: unknown): number {
  return typeof readyTimeoutMs === "number" &&
    Number.isFinite(readyTimeoutMs) &&
    readyTimeoutMs > 0
    ? readyTimeoutMs
    : DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
}

/**
 * A dial's armed subsystem-open bound, raced against the dial itself.
 */
export interface SubsystemOpenWatch {
  /**
   * Rejects with a {@link import("@psilink/core").TimeoutError} once the bound
   * has elapsed since authentication succeeded. It settles no other way, so a
   * caller races it against the dial and reads a rejection as this phase and
   * only this phase.
   */
  readonly expired: Promise<never>;
  /**
   * Drop the watch: cancel the timer and the subscription behind it. Idempotent,
   * and required on every path -- the ssh2 `Client` outlives any one dial, so a
   * listener left behind would accumulate across re-dials.
   */
  cancel(): void;
}

/**
 * Arm the subsystem-open bound on `client`, the ssh2 `Client` beneath
 * ssh2-sftp-client. The bound starts at ssh2's `'ready'`, which is the event
 * ssh2-sftp-client itself waits for before requesting the subsystem, so the
 * watch covers exactly the phase after authentication and nothing of the phase
 * before it.
 *
 * Returns `undefined` when this build cannot subscribe to that `Client` at all,
 * leaving the caller to decide what an unbounded phase is worth reporting;
 * nothing else here fails.
 *
 * @param client - The ssh2 `Client`, as ssh2-sftp-client exposes it.
 * @param timeoutMs - The bound, from {@link subsystemOpenTimeoutMs}.
 */
export function watchSubsystemOpen(
  client: SubsystemOpenWatchTarget | undefined,
  timeoutMs: number,
): SubsystemOpenWatch | undefined {
  if (typeof client?.once !== "function") return undefined;
  const removeListener = client.removeListener;
  if (typeof removeListener !== "function") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: ((error: Error) => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const armBound = (): void => {
    timer = setTimeout(
      () => fail?.(subsystemOpenTimeoutError(timeoutMs)),
      timeoutMs,
    );
    // The dial this bounds is parked on a live socket, which holds the process
    // open on its own; an unref'd timer keeps the bound from being the thing
    // that outlives a run.
    timer.unref();
  };
  client.once("ready", armBound);
  return {
    expired,
    cancel(): void {
      clearTimeout(timer);
      removeListener.call(client, "ready", armBound);
    },
  };
}
