export class EventHandlerQueue<T extends (...args: Array<any>) => void>  {
  /** Functions to run sequentially as data are received. */
  private handlers: Array<T>;

  constructor(
    handlers: Array<T>
  ) {
    this.handlers = handlers;
  }
  handleEvent = (...event: Parameters<T>) => {
    if (this.handlers.length > 0) {
      const currentHandler = this.handlers.shift()!;
      currentHandler(...event);
    }
  }
};
