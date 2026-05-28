import { default as EventEmitter } from "eventemitter3";

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

// Records sends and lets a test drive failures. Its `send` neither delivers
// data nor (by default) throws, so a started exchange stalls awaiting a reply
// unless the test emits an error or advances the clock. Mirrors the buffering
// semantics of production transports.
/** @internal */
export class StubConnection extends EventEmitter<Events, never> {
  sentMessages: Array<unknown> = [];
  sendImpl: (data: unknown) => void | Promise<void> = () => {};
  private bufferedError: unknown;

  send(data: unknown): void | Promise<void> {
    this.sentMessages.push(data);
    return this.sendImpl(data);
  }
  close() {}
  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
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
