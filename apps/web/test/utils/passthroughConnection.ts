import { default as EventEmitter } from "eventemitter3";

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

export class PassthroughConnection extends EventEmitter<Events, never> {
  other: PassthroughConnection | undefined;
  private bufferedError: unknown;

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

  close() {}

  // Mirrors FileSyncConnection's emit override so tests exercising the
  // protocol-layer takeBufferedError() path see the same buffering semantics
  // as the production transport.
  emit<TEvent extends keyof Events>(
    event: TEvent,
    ...args: Parameters<Events[TEvent]>
  ): boolean {
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
