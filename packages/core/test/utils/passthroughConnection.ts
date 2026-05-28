import { BufferingEventEmitter } from "../../src/connection/bufferingEventEmitter";

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

export class PassthroughConnection extends BufferingEventEmitter<Events> {
  other: PassthroughConnection | undefined;

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
}
