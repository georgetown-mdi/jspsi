export class EventHandlerQueue<
  T extends (...args: Array<unknown>) => void | Promise<void>,
> {
  /** Functions to run sequentially as data are received. */
  private handlers: Array<T>;
  /** Invoked if a handler throws synchronously or rejects. */
  private onError?: (err: unknown) => void;

  constructor(handlers: Array<T>, onError?: (err: unknown) => void) {
    this.handlers = handlers;
    this.onError = onError;
  }
  handleEvent = (...event: Parameters<T>) => {
    if (this.handlers.length === 0) return;
    const currentHandler = this.handlers.shift()!;
    // A handler may be async; a synchronous throw is caught here while an
    // asynchronous rejection is routed through the returned promise. Without
    // this, a rejected handler would surface as an unhandled rejection and the
    // surrounding receive phase would hang waiting for data that never comes.
    try {
      const result = currentHandler(...event) as unknown;
      if (
        result != null &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        (result as PromiseLike<unknown>).then(undefined, (err: unknown) =>
          this.onError?.(err),
        );
      }
    } catch (err) {
      this.onError?.(err);
    }
  };
}
