/**
 * Run `body` with the process time zone pinned, restoring whatever was set
 * before. Node resolves the zone per Date operation, so the pin takes effect
 * inside the call and leaks nothing after it. Shared by the suites that assert a
 * stored instant is read the same way on every machine.
 */
export function withTimeZone<T>(zone: string, body: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = zone;
  try {
    return body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}
