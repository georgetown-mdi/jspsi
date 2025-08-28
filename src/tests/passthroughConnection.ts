import { default as EventEmitter } from 'eventemitter3';

export class PassthroughConnection
extends EventEmitter<{data: (data: unknown) => void}, never> {
  other: PassthroughConnection | undefined;

  send(data: any) {
    setImmediate(() => { this.other!.emit('data', data); });
  }

  constructor(other?: PassthroughConnection) {
    super();
    this.other = other;
  }
  
  setOther(other: PassthroughConnection) {
    this.other = other;
  }
}
