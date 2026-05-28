import { default as EventEmitter } from "eventemitter3";

import { chainAsCause } from "./chainAsCause";

import type EventEmitterNS from "eventemitter3";

/**
 * EventEmitter subclass that retains the most recent unhandled `error` event so
 * the next protocol-layer receive can observe failures that arrived in the gap
 * between listener-registration cycles. Reading the buffer clears it; only the
 * most recent unhandled error is retained. When a second unhandled error
 * supersedes the first, the prior error is chained as `cause` via
 * {@link chainAsCause} so downstream diagnostics can still surface it.
 *
 * Subclasses that want to log supersession may override `emit`, read
 * `this.bufferedError` before calling `super.emit`, and log the prior value
 * when an unhandled error arrives. The buffering and chaining are handled by
 * this class's `emit`.
 */
export class BufferingEventEmitter<
  TEvents extends EventEmitterNS.ValidEventTypes,
> extends EventEmitter<TEvents, never> {
  protected bufferedError: unknown;

  emit<TEvent extends EventEmitterNS.EventNames<TEvents>>(
    event: TEvent,
    ...args: EventEmitterNS.EventArgs<TEvents, TEvent>
  ): boolean {
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) {
      const incoming = args[0] as unknown;
      if (this.bufferedError !== undefined) {
        chainAsCause(incoming, this.bufferedError);
      }
      this.bufferedError = incoming;
    }
    return hadListeners;
  }

  /**
   * Returns the most recent error buffered while no listener was registered,
   * clearing it; returns `undefined` if none is buffered.
   */
  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }
}
