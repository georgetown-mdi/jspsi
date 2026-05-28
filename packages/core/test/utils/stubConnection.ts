import { BufferingEventEmitter } from "../../src/connection/bufferingEventEmitter";

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

// Records sends and lets a test drive failures. Its `send` neither delivers
// data nor (by default) throws, so a started exchange stalls awaiting a reply
// unless the test emits an error or advances the clock. Mirrors the buffering
// semantics of production transports.
/** @internal */
export class StubConnection extends BufferingEventEmitter<Events> {
  sentMessages: Array<unknown> = [];
  sendImpl: (data: unknown) => void | Promise<void> = () => {};

  send(data: unknown): void | Promise<void> {
    this.sentMessages.push(data);
    return this.sendImpl(data);
  }
  close() {}
}
