import { Readable } from "node:stream";

import { vi } from "vitest";

/**
 * A binary readable emitting `content` (then EOF), as a file or stdin stream
 * would; an empty string yields an immediately-ending stream like an empty file.
 * @internal test-only
 */
export function streamOf(content: string): Readable {
  const s = new Readable({ read() {} });
  if (content.length > 0) s.push(Buffer.from(content, "utf8"));
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
