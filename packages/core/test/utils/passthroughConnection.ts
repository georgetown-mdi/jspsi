import { BufferedErrorEmitter } from "../../src/connection/bufferedErrorEmitter";

export class PassthroughConnection extends BufferedErrorEmitter {
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
