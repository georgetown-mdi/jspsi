import { default as EventEmitter } from "eventemitter3";

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

export class PassthroughConnection extends EventEmitter<Events, never> {
  other: PassthroughConnection | undefined;
  private bufferedError: unknown;
  private closed = false;

  send(data: unknown) {
    if (this.closed) return;
    setImmediate(() => {
      this.other!.emit("data", data);
    });
  }

  constructor(other?: PassthroughConnection) {
    super();
    this.other = other;
  }

  setOther(other: PassthroughConnection) {
    this.other = other;
  }

  close() {
    this.closed = true;
  }

  // Mirrors DataConnectionAdapter's emit override so tests exercising the
  // protocol-layer takeBufferedError() path see the same buffering semantics
  // as the production transport. The closed guards on send() and emit() mirror
  // DataConnectionAdapter's behavior after close(): no outbound data is sent
  // and no inbound events reach listeners.
  emit<TEvent extends keyof Events>(
    event: TEvent,
    ...args: Parameters<Events[TEvent]>
  ): boolean {
    if (this.closed) return false;
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) {
      const incoming = args[0];
      if (
        this.bufferedError !== undefined &&
        incoming instanceof Error &&
        incoming.cause === undefined &&
        incoming !== this.bufferedError
      ) {
        try {
          incoming.cause = this.bufferedError;
        } catch {
          /* frozen object */
        }
      }
      this.bufferedError = incoming;
    }
    return hadListeners;
  }

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }
}
