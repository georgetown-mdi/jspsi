/**
 * Render one server-sent-events frame: an `id:` line carrying the monotonic
 * event id (so a browser's EventSource echoes it as `Last-Event-ID` on
 * reconnect) and a `data:` line carrying the JSON event, terminated by the blank
 * line that ends a frame. The event is already sanitized upstream (every string
 * field passed through the display escaper at the trust boundary), so JSON
 * serialization here cannot carry a raw control byte.
 */
export function renderSseFrame(id: number, event: unknown): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Resolve the resume offset for an SSE connect: the `Last-Event-ID` header when
 * present and a non-negative integer, else a `?lastEventId=` query fallback (for
 * a client that cannot set the header), else 0 (replay from the start). A
 * malformed value is treated as 0 rather than rejected, so a bad reconnect simply
 * replays the full history instead of failing.
 */
export function resumeOffsetFrom(request: Request): number {
  const header = request.headers.get("last-event-id");
  const fromHeader = parseOffset(header);
  if (fromHeader !== null) return fromHeader;
  const url = new URL(request.url);
  const fromQuery = parseOffset(url.searchParams.get("lastEventId"));
  return fromQuery ?? 0;
}

/** Parse a non-negative integer offset, or null when absent/malformed. */
function parseOffset(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
