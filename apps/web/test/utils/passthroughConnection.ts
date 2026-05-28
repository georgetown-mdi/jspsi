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
  // as the production transport. The closed guard mirrors DataConnectionAdapter
  // removing its forwarding handlers on close() so events from the peer no
  // longer reach this connection's listeners.
  emit<TEvent extends keyof Events>(
    event: TEvent,
    ...args: Parameters<Events[TEvent]>
  ): boolean {
    if (this.closed) return false;
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) this.bufferedError = args[0];
    return hadListeners;
  }

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }
}
