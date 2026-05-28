export class EventHandlerQueue<
  T extends (...args: Array<unknown>) => void | Promise<void>,
> {
  /** Functions to run sequentially as data are received. */
  private handlers: Array<T>;
  /** Invoked if a handler throws synchronously or rejects. */
  private onError: (err: unknown) => void;
  /** Invoked after the last handler resolves, if provided. */
  private onDone: (() => void) | undefined;

  constructor(
    handlers: Array<T>,
    onError: (err: unknown) => void,
    onDone?: () => void,
  ) {
    this.handlers = handlers;
    this.onError = onError;
    this.onDone = onDone;
  }

  get isEmpty(): boolean {
    return this.handlers.length === 0;
  }

  handleEvent = (...event: Parameters<T>) => {
    if (this.handlers.length === 0) return;
    const currentHandler = this.handlers.shift()!;
    const isLast = this.handlers.length === 0;
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
        (result as PromiseLike<unknown>).then(
          () => {
            if (isLast) this.onDone?.();
          },
          (err: unknown) => this.onError(err),
        );
      } else if (isLast) {
        this.onDone?.();
      }
    } catch (err) {
      this.onError(err);
    }
  };
}
