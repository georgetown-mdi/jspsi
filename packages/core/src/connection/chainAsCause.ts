/**
 * Mutates `error.cause` to `cause` when `error` is an `Error` with no existing
 * `cause` and `error !== cause`, so the superseded error is not lost. The
 * mutation is best-effort: if the object is frozen it is silently skipped.
 */
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
