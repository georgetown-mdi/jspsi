/** @internal */
export function chainAsCause(error: unknown, cause: unknown): void {
  if (
    cause !== undefined &&
    error instanceof Error &&
    error.cause === undefined &&
    error !== cause
  ) {
    try {
      error.cause = cause;
    } catch {
      /* error object is frozen; chain is best-effort. */
    }
  }
}
