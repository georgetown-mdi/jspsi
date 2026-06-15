import { Readable } from "node:stream";

import { vi } from "vitest";

/**
 * A binary readable emitting `content` (then EOF), as a piped or redirected stdin
 * would; an empty string yields an immediately-ending stream like an empty file.
 * `isTTY` is left `undefined`, modelling a non-interactive stdin (a pipe, a `<`
 * redirect, or `/dev/null`) -- the case the stdin-reading path must accept.
 * @internal test-only
 */
export function streamOf(content: string): Readable {
  const s = new Readable({ read() {} });
  if (content.length > 0) s.push(Buffer.from(content, "utf8"));
  s.push(null);
  return s;
}

/**
 * A stdin stub that reports as an interactive terminal (`isTTY === true`),
 * modelling `-` given at a prompt with nothing piped. The TTY guard rejects
 * before any read, so in the passing case the stream is never consumed. It still
 * pushes EOF (`null`): if the guard ever regressed, a consumer would read empty
 * and end rather than block on a never-ending stream, so the asserting test fails
 * fast instead of hanging until the runner's timeout.
 * @internal test-only
 */
export function ttyStream(): Readable {
  const s = new Readable({ read() {} });
  (s as Readable & { isTTY?: boolean }).isTTY = true;
  s.push(null);
  return s;
}

/**
 * Run `fn` with `process.stdin` replaced by `stub`, restoring it afterward.
 * Awaits `fn` so the swap outlives an async stdin read before it is undone.
 * @internal test-only
 */
export async function withStdin<T>(
  stub: Readable,
  fn: () => T | Promise<T>,
): Promise<T> {
  const spy = vi
    .spyOn(process, "stdin", "get")
    .mockReturnValue(stub as unknown as typeof process.stdin);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}
