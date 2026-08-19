import type { BufferedEvent, JobRecord } from "./jobManager";

/**
 * Render one server-sent-events frame: an `id:` line carrying the monotonic
 * event id (so a browser's EventSource echoes it as `Last-Event-ID` on
 * reconnect) and a `data:` line carrying the JSON event, terminated by the blank
 * line that ends a frame.
 *
 * A CLI-relayed event arrives with every string field already escaped at the
 * trust boundary, so it carries no raw control byte to begin with. A
 * manager-composed event does not: the rendezvous preflight names partner-chosen
 * directory entries and composes them RAW so the console seat stays the one
 * altitude that escapes them, and a filename is free to carry a newline, a
 * carriage return, and a whole forged `data:` line. What keeps that inside one
 * frame is `JSON.stringify` escaping every newline class within the serialized
 * string, leaving the `\n` here as the writer's own terminator. Pinned end to
 * end -- from a name on a real mount to what a seat renders -- rather than
 * claimed, by `apps/web/test/unit/jobWarningFraming.unit.test.ts`.
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

/**
 * The keepalive frame: an SSE comment, which carries no `data:` line and so is
 * no event at all -- an EventSource ignores it and the console's own client
 * parser drops it. Its only job is to put bytes on the wire.
 */
export const SSE_KEEPALIVE_FRAME = ": keepalive\n\n";

/**
 * The fixed cadence at which an event stream writes a keepalive frame,
 * indifferent to real traffic (a redundant comment frame beside real events is
 * free, and a fixed timer needs no reset bookkeeping). An exchange is
 * legitimately quiet for minutes at a time -- a party waiting on its partner
 * emits nothing -- while a reverse proxy or load balancer in front of the
 * console cuts an idle response far sooner (60 seconds is a common default, and
 * a hardened one is shorter). Sized well under that floor so the operator's view
 * of a waiting run survives, rather than raising an idle window the deployment
 * owns and psilink does not.
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 15000;

/**
 * The job-manager surface {@link createJobEventStream} reaches, narrowed to the
 * one subscription call so a test can drive the stream without a live manager.
 */
export interface JobEventSubscriber {
  subscribe: (
    record: JobRecord,
    afterId: number,
    onEntry: (entry: BufferedEvent) => void,
  ) => { replay: Array<BufferedEvent>; unsubscribe: () => void };
}

/** What {@link createJobEventStream} needs to stream one job's events. */
export interface JobEventStreamOptions {
  manager: JobEventSubscriber;
  record: JobRecord;
  /** The resume offset from {@link resumeOffsetFrom}: only events with a strictly
   * greater id are replayed. */
  afterId: number;
  /** The request's abort signal; a client disconnect releases the subscription
   * and the keepalive timer. */
  signal: AbortSignal;
  keepaliveIntervalMs?: number;
}

/**
 * Build the SSE body for one job: the replay from `afterId`, every later event
 * live, a keepalive frame every {@link SSE_KEEPALIVE_INTERVAL_MS}, and a
 * close once the terminal event has been delivered.
 *
 * The subscription and the keepalive timer are released on every exit -- the
 * terminal event, an already-terminal replay, a client abort, and a consumer
 * cancelling the body -- so neither outlives the response. The keepalive timer is
 * unref'd: a stream still open at shutdown must not hold the process up.
 */
export function createJobEventStream({
  manager,
  record,
  afterId,
  signal,
  keepaliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS,
}: JobEventStreamOptions): ReadableStream<Uint8Array> {
  let unsubscribe: (() => void) | null = null;
  let keepalive: NodeJS.Timeout | null = null;

  const release = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    if (keepalive !== null) {
      clearInterval(keepalive);
      keepalive = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Already aborted between the request and this callback: the later
      // addEventListener would never fire post-abort, so the subscription
      // would leak into the record. Close without subscribing.
      if (signal.aborted) {
        controller.close();
        return;
      }

      const encoder = new TextEncoder();
      const push = (id: number, event: unknown): void => {
        controller.enqueue(encoder.encode(renderSseFrame(id, event)));
      };
      const finish = (): void => {
        release();
        try {
          controller.close();
        } catch {
          // Already closed; nothing to do.
        }
      };

      const subscription = manager.subscribe(record, afterId, (entry) => {
        push(entry.id, entry.event);
        if (entry.event.type === "result" || entry.event.type === "error")
          finish();
      });
      unsubscribe = subscription.unsubscribe;

      for (const entry of subscription.replay) push(entry.id, entry.event);

      // When the terminal event is already in the replay, the job is done;
      // close the stream rather than hold an idle connection open.
      if (record.terminalEmitted) {
        finish();
        return;
      }

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(SSE_KEEPALIVE_FRAME));
        } catch {
          // The body was cancelled between ticks: stop rather than throw out of
          // a timer callback, where nothing is positioned to catch it.
          release();
        }
      }, keepaliveIntervalMs);
      keepalive.unref();

      // Release the subscription if the client disconnects mid-stream.
      signal.addEventListener("abort", finish);
    },
    cancel() {
      release();
    },
  });
}
