import {
  ProcessState,
  getLogger,
  joinErrorCauseChain,
  parseBoundedJson,
} from "@psilink/core";

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  MAX_SFTP_CONNECTION_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";
import { jobRecordDownloads } from "@psi/jobClient/jobExchangeRecord";
import { whenDiagnostic } from "@utils/diagnostics";

import { ERROR_MESSAGE_CHAIN_FIELD } from "../relayErrorChain";

import type { ExchangeDriver, ExchangeDriverEvents } from "../exchangeDriver";
import type {
  ExchangeErrorCategory,
  StageDefinition,
} from "../exchangeLifecycle";
import type {
  JobCreateIntent,
  JobExchangeIntent,
  JobExchangeOptions,
  JobExchangeSide,
  JobZeroSetupIntent,
  JobZeroSetupLinkageStrategy,
} from "@jobs/intent";
import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";
import type { RelayEvent, RelayEventType } from "@jobs/cliDriver";
import type { ReceiptsIntentFields } from "../receiptsModel";
import type { RunDiagnosticsIntentFields } from "../runDiagnosticsModel";
import type { RunOutputs } from "../runOutputs";
import type { SftpConnectionProjection } from "@jobs/jobManager";

const log = getLogger("serverJobExchangeDriver");

/** The channel a server job runs over, mirroring the {@link JobExchangeIntent}
 * discriminant so the driver stays transport-blind past intent construction.
 * The sftp variant has no connection field at all: the console runs the one
 * authored SFTP connection (`GET /api/jobs/sftp`), so every host, port, path,
 * and credential reference lives on the console, never in the browser. */
export type ServerJobExchangeTransport =
  { channel: "filedrop" } | { channel: "sftp" };

/**
 * Where the console reads this party's input from. `inline` holds the CSV
 * content the browser has; the server writes it to the fixed workdir name.
 * `workFile` holds only a reference -- an opaque single-segment name -- to a
 * file in the operator-mounted work-input directory, so no content transits
 * the browser and the CLI reads the file in place. `intentFor` maps `inline`
 * to `inputCsv` and `workFile` to `inputFile` (exactly one is ever set). */
export type JobInputSource =
  { kind: "inline"; csv: string } | { kind: "workFile"; name: string };

/** The construction-time inputs a server-job driver needs: the browser
 * driver's config minus everything only a peer-to-peer run has (no `acquire`,
 * no PSI library, no `generateOutput`). These map onto the
 * {@link JobExchangeIntent} fields: `transport` picks the intent arm and the
 * driver stamps `eventStream: true` itself, so a caller supplies only the
 * exchange payload and the channel it rides. */
export interface ServerJobExchangeDriverConfig {
  transport: ServerJobExchangeTransport;
  /**
   * Which side of the partnership this run is. Required, not optional: it decides
   * whether the composed config holds an `outbound_payload_consent` record (only
   * an acceptance's outbound set is unauthored, so only an acceptance records
   * one), and a side omitted into a default would silently leave a later
   * unattended run of that config unheld to any set. Every caller states it.
   */
  side: JobExchangeSide;
  linkageTerms: LinkageTerms;
  sharedSecret: string;
  /** Where the console reads this party's input from: inline CSV content, or a
   * reference to a file in the operator-mounted work-input directory
   * ({@link JobInputSource}). Mapped to the intent's `inputCsv` / `inputFile` arm by
   * {@link intentFor}. */
  inputSource: JobInputSource;
  /** This party's authored column metadata (which columns are sent vs ignored,
   * their roles/types). Included in the intent so the console's CLI uses the
   * operator's edits instead of inferring metadata from the column names -- an
   * inferred column defaults to disclosed payload, so an omitted metadata would
   * silently disclose a column the operator marked ignored. Forwarded only when
   * present, mirroring how the browser path guards these. */
  metadata?: Metadata;
  /** This party's authored standardization pipeline, paired with {@link metadata}.
   * Forwarded only when present. */
  standardization?: Standardization;
  /** The acceptor's received-payload commitment (partner-namespace column
   * names), mirrored from the invitation's disclosed set. Included in the
   * intent so the CLI enforces it explicitly rather than falling back to the
   * lazy `payload.receive`, which fails open when the token discloses columns
   * but has no `payload.send`. Forwarded whenever present, including an empty
   * array (a strict "receive nothing"); an omitted field reconciles lazily. */
  expectedPayloadColumns?: Array<string>;
  /** The acceptor's terms-side commitment: the `deduplicate` the invitation
   * declared for the INVITER's own side. Included in the intent so the
   * composed config binds it and the CLI refuses a partner presenting any
   * other value at the terms exchange, before any key or payload moves. The
   * inviter path leaves it undefined -- the commitment is the acceptor's, and
   * an absent field binds nothing. */
  expectedPartnerDeduplicate?: boolean;
  options?: JobExchangeOptions;
  /** The operator's per-run diagnostic and recovery choices, forwarded to the
   * intent unchanged ({@link RunDiagnosticsIntentFields}). Absent for a run
   * that asked for neither. */
  runDiagnostics?: RunDiagnosticsIntentFields;
  /** The operator's receipt-signing and retention choices, forwarded to the
   * intent unchanged ({@link ReceiptsIntentFields}). Absent for an exchange
   * that signs no receipt and files no note. */
  receipts?: ReceiptsIntentFields;
  /** Invoked with the created job's id the moment `POST /api/jobs` resolves,
   * before the event stream opens. This is where the console's strand-recovery
   * record is written ({@link ../psi/consoleJobAttachment}): the job exists on
   * the console from this point, so persisting its id here lets a reload or a
   * hard tab close re-attach to the run. */
  onJobCreated?: (jobId: string) => void;
}

/** The exchange-record pair's availability on the console, read off
 * `GET /api/jobs/:id`. Available only when the record and its verification keys
 * are both on disk and the record's `createdAt` parsed; the driver stamps the
 * download filenames from that `createdAt`. */
export type RecordAvailability =
  { available: false } | { available: true; createdAt: string };

/** The browser-side job-API surface a server-job driver reaches, injectable so
 * the fidelity tests feed a scripted event stream without a live server. The
 * defaults hit the real same-origin endpoints. */
export interface JobApiClient {
  /** `POST /api/jobs` with the intent body; resolves the created job's id, or
   * throws {@link JobApiRequestError} on a non-2xx, or a network error as-is.
   * Accepts either mode's intent -- an exchange intent from
   * {@link createServerJobExchangeDriver} or a zero-setup intent from
   * {@link createServerJobZeroSetupDriver} -- since the create route parses the
   * mode-discriminated union. */
  createJob: (intent: JobCreateIntent, signal: AbortSignal) => Promise<string>;
  /** `GET /api/jobs/:id/events` as an async iterable of already-validated
   * {@link RelayEvent}s; the iterator completes when the server closes the
   * stream after the terminal event (or when `signal` aborts). A stream dropped
   * before its terminal is re-opened from the last id delivered, so the caller
   * sees one continuous run across a cut connection. */
  openEventStream: (
    jobId: string,
    signal: AbortSignal,
  ) => AsyncIterable<RelayEvent>;
  /** `POST /api/jobs/:id/cancel`; best-effort, errors are swallowed by the
   * caller since a cancel races a naturally-terminating job. */
  cancelJob: (jobId: string) => Promise<void>;
  /** `DELETE /api/jobs/:id`; the one operation that removes the workdir. The
   * caller swallows errors (best-effort, like {@link cancelJob}): a discard
   * races a job the operator has already left, and a 404 for an already-gone id
   * is a no-op. */
  deleteJob: (jobId: string) => Promise<void>;
  /** `GET /api/jobs/:id`, resolving a {@link JobStatusProbe} the recovery probe
   * and the discard poll both read. See {@link JobStatusProbe} for how `gone`
   * is distinguished from `unreachable`. */
  fetchJobStatus: (
    jobId: string,
    signal: AbortSignal,
  ) => Promise<JobStatusProbe>;
  /** `GET /api/jobs/:id`, reading `recordAvailable`/`recordCreatedAt` off the
   * status body. A graceful-degrade metadata fetch: the driver delivers the
   * result without the record pair if this fails or aborts. */
  fetchRecordAvailability: (
    jobId: string,
    signal: AbortSignal,
  ) => Promise<RecordAvailability>;
}

/** The exchange's live run status, read off `GET /api/jobs/:id`. `running` is a
 * live child; the other three are terminal outcomes (the status flips from
 * `running` once the child's terminal is reconciled). The recovery panel reads it
 * to head the surface and the discard poll reads it to wait out a graceful
 * cancel. */
export type JobRunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** The status body a recovery probe or a discard poll needs off
 * `GET /api/jobs/:id`: only the run status. The endpoint returns more
 * (terminal, record availability), but re-attachment reconstructs the run from
 * the event stream, so the status view stays minimal. */
export interface JobStatusView {
  status: JobRunStatus;
}

/** The outcome of a `GET /api/jobs/:id` probe, distinguishing a CONFIRMED-gone
 * exchange from a transient failure so only the former drives a destructive
 * reclaim. `live` holds the run status from a 200; `gone` is a confirmed HTTP
 * 404 (deleted, or forgotten by a restart); `unreachable` is a network error or
 * any other non-2xx -- a transient blip the caller must not treat as removal. */
export type JobStatusProbe =
  | { kind: "live"; status: JobRunStatus }
  | { kind: "gone" }
  | { kind: "unreachable" };

/** A non-2xx response from the job API, holding the status so the driver can
 * pick the failure category (a 400 is a rejected/invalid intent -> `config`;
 * any other non-2xx is a transport/server fault -> `exchange`). A busy (409)
 * create includes {@link activeJobId}, the id of the exchange occupying the
 * console's single slot, parsed from the response body -- the browser
 * re-attaches to it rather than surfacing the "already running" alert (see
 * `exchange/reattachOnBusy`). Present only on a 409 whose body held one. */
export class JobApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly activeJobId?: string,
  ) {
    super(message);
    this.name = "JobApiRequestError";
  }
}

/** The failure a relayed terminal `error` event raises. Its `message` is a
 * RENDERED cause chain, not a raw one: every piece came off the relay's own
 * display pass -- the links {@link ERROR_MESSAGE_CHAIN_FIELD} held apart,
 * rejoined by the renderer's own framing, or the escaped flat field when the
 * relay derived no chain (see {@link errorMessageOf}). Anything else renders
 * through the escaping renderer instead (`sanitizedFailureMessage` in
 * `@exchange/useInviterExchange`). */
export class RelayedTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayedTerminalError";
  }
}

/** The result CSV of a server-driven job lives on the console, retrievable
 * through this endpoint rather than as a browser object URL. */
function jobResultUrl(jobId: string): string {
  return `/api/jobs/${jobId}/result`;
}

/** The default {@link JobApiClient}, hitting the real same-origin job endpoints
 * with a streaming `fetch` (not `EventSource`, which is harder to drive from a
 * unit test). Every connect replays the job's full event history and the
 * server closes the stream after the terminal event, so one request spans a
 * whole run's lifecycle. */
export function createFetchJobApiClient(
  fetchImpl: typeof fetch = fetch,
): JobApiClient {
  return {
    createJob: async (intent, signal) => {
      const response = await fetchImpl("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intent),
        signal,
      });
      if (!response.ok)
        throw new JobApiRequestError(
          response.status,
          `POST /api/jobs failed with status ${response.status}`,
          // A busy (409) body holds `{ id }` -- the exchange occupying the
          // single slot -- so the caller can re-attach to it. Absent on every
          // other status (an empty-bodied 400/413/500 is treated as no id).
          response.status === 409 ? await readBodyJobId(response) : undefined,
        );
      const body: unknown = await readBoundedJson(
        response,
        MAX_JOB_STATUS_RESPONSE_BYTES,
      );
      const id = (body as { id?: unknown }).id;
      if (typeof id !== "string" || id.length === 0)
        throw new JobApiRequestError(
          response.status,
          "POST /api/jobs returned no job id",
        );
      return id;
    },
    openEventStream: (jobId, signal) =>
      streamJobEvents(fetchImpl, jobId, signal),
    cancelJob: async (jobId) => {
      await fetchImpl(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    },
    deleteJob: async (jobId) => {
      await fetchImpl(`/api/jobs/${jobId}`, { method: "DELETE" });
    },
    fetchJobStatus: async (jobId, signal) => {
      let response: Response;
      try {
        response = await fetchImpl(`/api/jobs/${jobId}`, {
          method: "GET",
          signal,
        });
      } catch {
        // A network error / unreachable server is transient, not a confirmed
        // removal: report it so the caller leaves the record intact.
        return { kind: "unreachable" };
      }
      // A confirmed 404 is the only "gone": the exchange is not on the console
      // (deleted, or a restart forgot it). Any other non-2xx is a transient fault.
      if (response.status === 404) return { kind: "gone" };
      if (!response.ok) return { kind: "unreachable" };
      try {
        return {
          kind: "live",
          status: jobStatusViewOf(
            await readBoundedJson(response, MAX_JOB_STATUS_RESPONSE_BYTES),
          ).status,
        };
      } catch {
        // A 200 proves the exchange is present; an unparseable body is
        // treated as running, never gone.
        return { kind: "live", status: "running" };
      }
    },
    fetchRecordAvailability: async (jobId, signal) => {
      const response = await fetchImpl(`/api/jobs/${jobId}`, {
        method: "GET",
        signal,
      });
      if (!response.ok) return { available: false };
      const body: unknown = await readBoundedJson(
        response,
        MAX_JOB_STATUS_RESPONSE_BYTES,
      );
      const available = (body as { recordAvailable?: unknown }).recordAvailable;
      const createdAt = (body as { recordCreatedAt?: unknown }).recordCreatedAt;
      if (available !== true || typeof createdAt !== "string")
        return { available: false };
      return { available: true, createdAt };
    },
  };
}

/** Read a `{ id }` string off a job-API response body, or undefined when the
 * body is absent, unparseable, or has no non-empty string id. Used to pull
 * the occupying exchange's id off a busy (409) create so the caller can
 * re-attach; a body without one (an older server, or an empty 409) is undefined,
 * and the caller falls back to its persisted id. */
async function readBodyJobId(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await readBoundedJson(
      response,
      MAX_JOB_STATUS_RESPONSE_BYTES,
    );
    const id = (body as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Read the run status off a `GET /api/jobs/:id` body, defaulting a missing or
 * unrecognized value to `running`. Called only for a 200, which proves the
 * exchange is present; erring toward `running` keeps the discard poll waiting for
 * a graceful cancel rather than deleting under a live child. */
function jobStatusViewOf(body: unknown): JobStatusView {
  const status =
    body !== null && typeof body === "object"
      ? (body as { status?: unknown }).status
      : undefined;
  return {
    status:
      status === "succeeded" || status === "failed" || status === "cancelled"
        ? status
        : "running",
  };
}

/**
 * The console's single-slot occupancy as the browser reads it off
 * `GET /api/jobs/slot`: free, or occupied by a named job. The lobby's recovery
 * panel adopts `id` when it holds no stored attachment, so a browser that never
 * started the exchange still finds it.
 */
export type SlotOccupancy =
  { occupied: false } | { occupied: true; id: string };

/**
 * Probe the console's single exchange slot (`GET /api/jobs/slot`). Fail-safe
 * toward "not occupied": a non-2xx (a disabled API's 404 among them), a
 * network error, an aborted request, a `{ occupied: false }` body, or a
 * malformed `{ occupied: true }` body missing a usable id all resolve to
 * unoccupied, so the recovery panel renders nothing rather than adopting an
 * id it cannot re-attach to.
 */
export async function fetchSlotOccupancy(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SlotOccupancy> {
  try {
    const response = await fetchImpl("/api/jobs/slot", {
      method: "GET",
      signal,
    });
    if (!response.ok) return { occupied: false };
    return slotOccupancyOf(
      await readBoundedJson(response, MAX_JOB_STATUS_RESPONSE_BYTES),
    );
  } catch {
    return { occupied: false };
  }
}

/** Validate the slot response body into a {@link SlotOccupancy}, failing safe to
 * unoccupied for anything but an `{ occupied: true }` body holding a non-empty
 * string id. */
function slotOccupancyOf(body: unknown): SlotOccupancy {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { occupied: false };
  const { occupied, id } = body as Record<string, unknown>;
  if (occupied !== true || typeof id !== "string" || id.length === 0)
    return { occupied: false };
  return { occupied: true, id };
}

/**
 * The effective SFTP connection as the browser reads it off `GET /api/jobs/sftp`:
 * the credential-free locator (or null when none is authored).
 */
export interface SftpConnectionInfo {
  connection: SftpConnectionProjection | null;
}

/**
 * Fetch the console's authored SFTP connection (`GET /api/jobs/sftp`) as the
 * validated locator. Fail-safe toward "none configured": a non-2xx, a network
 * error, a `{ configured: false }` body, or a malformed `{ configured: true, ... }`
 * body all resolve to a null connection, so the console offers in-app
 * authoring (or the save-a-file alternative) rather than arming a
 * server-job run it has no connection for.
 */
export async function fetchSftpConnection(
  fetchImpl: typeof fetch = fetch,
): Promise<SftpConnectionInfo> {
  try {
    const response = await fetchImpl("/api/jobs/sftp", { method: "GET" });
    if (!response.ok) return { connection: null };
    const body: unknown = await readBoundedJson(
      response,
      MAX_SFTP_CONNECTION_RESPONSE_BYTES,
    );
    return { connection: sftpConnectionProjectionOf(body) };
  } catch {
    return { connection: null };
  }
}

/**
 * Validate the sftp response body into the credential-free projection, or
 * null when it reports `configured: false` or is malformed -- a partial or
 * ill-formed body fails closed rather than arming a run against a connection
 * the operator did not provision. The non-blocking `credentialWarnings`
 * default to an empty array: a missing or malformed field is treated as "no
 * warnings" rather than dropping the connection (a warning is advisory, not
 * critical).
 *
 * The remote directory is admitted in exactly one of its two forms: the
 * single shared `path`, or a COMPLETE `inboundPath`/`outboundPath` pair. A
 * half pair, or a pair alongside `path`, is a shape the console cannot have
 * authored, so it drops the connection rather than arming a run against a
 * directory layout the browser would then misreport in the invitation it
 * mints.
 *
 * @internal exported for the authoring client, which parses the same projection
 * off a `PUT /api/jobs/sftp` success body.
 */
export function sftpConnectionProjectionOf(
  body: unknown,
): SftpConnectionProjection | null {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  const {
    configured,
    host,
    port,
    path,
    inboundPath,
    outboundPath,
    credentialWarnings,
  } = body as Record<string, unknown>;
  if (configured !== true) return null;
  if (typeof host !== "string" || host.length === 0) return null;
  if (
    port !== undefined &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  )
    return null;
  if (path !== undefined && (typeof path !== "string" || path.length === 0))
    return null;
  if (
    inboundPath !== undefined &&
    (typeof inboundPath !== "string" || inboundPath.length === 0)
  )
    return null;
  if (
    outboundPath !== undefined &&
    (typeof outboundPath !== "string" || outboundPath.length === 0)
  )
    return null;
  if ((inboundPath === undefined) !== (outboundPath === undefined)) return null;
  if (path !== undefined && inboundPath !== undefined) return null;
  const connection: SftpConnectionProjection = { host };
  if (port !== undefined) connection.port = port;
  if (path !== undefined) connection.path = path;
  if (inboundPath !== undefined && outboundPath !== undefined) {
    connection.inboundPath = inboundPath;
    connection.outboundPath = outboundPath;
  }
  connection.credentialWarnings = Array.isArray(credentialWarnings)
    ? credentialWarnings.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return connection;
}

/**
 * The waits before each successive reconnect attempt, and by its length the
 * attempt budget. The budget resets whenever a connection advances the
 * stream (a frame with an id past the last one delivered), so a long run
 * survives repeated drops while a server that answers but never progresses is
 * still bounded.
 */
const EVENT_STREAM_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

/** What the operator is told when the reconnects are exhausted: the console's
 * run is not known to have failed, only unobservable from here. */
const EVENT_STREAM_LOST_MESSAGE =
  "the connection to the exchange event stream was lost; the run may still be in progress on the console -- reload to re-attach";

/** One connection's frames: the SSE id attached to each (null for a keepalive
 * or any frame without an `id:` line) alongside the parsed event (null for a
 * frame that is not a relay event). */
interface SseFrame {
  id: number | null;
  event: RelayEvent | null;
}

/** Open the SSE event stream and yield each parsed frame as a {@link RelayEvent}.
 * A frame that is not a JSON object with the relay-event shape is skipped rather
 * than yielded, mirroring the server's own fail-safe validation.
 *
 * A stream that ends before its terminal event is a drop, not a completion:
 * the connection re-opens from the last id delivered so the run continues
 * where it left off, and the resume loses and restarts nothing since the
 * server retains full history. A failure on the FIRST connect is not
 * retried (nothing exists yet to resume), and a confirmed 404 (the job is
 * gone from the console) stops retries immediately. */
async function* streamJobEvents(
  fetchImpl: typeof fetch,
  jobId: string,
  signal: AbortSignal,
): AsyncIterable<RelayEvent> {
  let lastEventId = 0;
  let attempt = 0;
  let established = false;

  for (;;) {
    let response: Response;
    try {
      response = await requestEventStream(
        fetchImpl,
        jobId,
        signal,
        lastEventId,
      );
    } catch (error) {
      if (signal.aborted) return;
      const fatal =
        !established ||
        (error instanceof JobApiRequestError && error.status === 404);
      if (fatal) throw error;
      if (!(await waitBeforeReconnect(attempt++, signal)))
        throw new Error(EVENT_STREAM_LOST_MESSAGE);
      continue;
    }
    established = true;

    const idBefore = lastEventId;
    try {
      for await (const frame of readEventStreamFrames(response)) {
        if (frame.id !== null) lastEventId = frame.id;
        if (frame.event === null) continue;
        yield frame.event;
        // The server closes the stream once the terminal event is delivered, so
        // this close is the run ending rather than a drop to reconnect from.
        if (frame.event.type === "result" || frame.event.type === "error")
          return;
      }
    } catch {
      // A fault mid-body is a drop like a premature end: fall through and
      // reconnect from the last id delivered.
    }

    if (signal.aborted) return;
    if (lastEventId > idBefore) attempt = 0;
    if (!(await waitBeforeReconnect(attempt++, signal)))
      throw new Error(EVENT_STREAM_LOST_MESSAGE);
  }
}

/** Request the job's event stream, resuming from `lastEventId` when the client
 * has already been delivered events. `Last-Event-ID` is the SSE-native resume
 * header the route reads; it is omitted on a first connect, whose offset is 0
 * (replay from the start) either way. */
async function requestEventStream(
  fetchImpl: typeof fetch,
  jobId: string,
  signal: AbortSignal,
  lastEventId: number,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId > 0) headers["Last-Event-ID"] = String(lastEventId);
  const response = await fetchImpl(`/api/jobs/${jobId}/events`, {
    method: "GET",
    headers,
    signal,
  });
  if (!response.ok)
    throw new JobApiRequestError(
      response.status,
      `GET /api/jobs/${jobId}/events failed with status ${response.status}`,
    );
  return response;
}

/** Split one response body into SSE frames, yielding each frame's id and parsed
 * event. Returns when the body ends -- whether that is the server closing after
 * the terminal event or the connection being cut. */
async function* readEventStreamFrames(
  response: Response,
): AsyncGenerator<SseFrame> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield { id: sseFrameId(frame), event: parseSseFrame(frame) };
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Wait out this attempt's backoff, resolving true when another reconnect is
 * left in the budget and false when it is spent. The wait ends early on abort so
 * an unmounting consumer is not held for the remaining delay. */
function waitBeforeReconnect(
  attempt: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (attempt >= EVENT_STREAM_RECONNECT_DELAYS_MS.length)
    return Promise.resolve(false);
  const delay = EVENT_STREAM_RECONNECT_DELAYS_MS[attempt];
  // An already-aborted signal fires no abort listener, so return straight to the
  // caller's own abort check rather than arming a wait nothing would end.
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read the monotonic event id off an SSE frame's `id:` line, or null when the
 * frame has none (a keepalive comment) or has an unparseable one. */
function sseFrameId(frame: string): number | null {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("id:")) continue;
    const parsed = Number.parseInt(line.slice(3).trim(), 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

const RELAY_EVENT_TYPES = new Set<RelayEventType>([
  "stages",
  "stage",
  "stageEnd",
  "warning",
  "metrics",
  "result",
  "error",
]);

/** Extract the JSON event from one SSE frame's `data:` line and confirm it has
 * the relay-event shape (`v === 1`, a known `type`). Returns null for a comment,
 * a keep-alive, or a malformed frame. */
function parseSseFrame(frame: string): RelayEvent | null {
  const dataLines: Array<string> = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(dataLines.join("\n"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  const type = record.type;
  if (
    typeof type !== "string" ||
    !RELAY_EVENT_TYPES.has(type as RelayEventType)
  )
    return null;
  return record as RelayEvent;
}

/** Read a stage tree off a `stages` relay event, defaulting to an empty tree so
 * a malformed frame cannot crash the run. The relay event has only `id` and
 * `label` (the CLI's stage vocabulary); each stage opens in
 * {@link ProcessState.BeforeStart}, and a later `stage` event activates it, so
 * the tree lands in the progress UI exactly as the browser lifecycle's does. */
function stagesOf(event: RelayEvent): Array<StageDefinition> {
  const stages = event.stages;
  if (!Array.isArray(stages)) return [];
  return stages.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    const label = (entry as { label?: unknown }).label;
    return typeof id === "string" && typeof label === "string"
      ? [{ id, label, state: ProcessState.BeforeStart }]
      : [];
  });
}

/** The intersection size a count-only (`psi-c`) `result` event reports, or
 * undefined when the run reported none. The field's PRESENCE is the discriminant
 * the CLI's contract defines (docs/spec/CLI_EVENTS.md, `result`), so a zero count
 * is a count and a missing one is not; a value outside the non-negative safe
 * integers is treated as absent, keeping a malformed frame off the counted shape
 * rather than rendering a nonsense figure. */
function countOnlyResultCount(event: RelayEvent): number | undefined {
  const count = event.intersectionCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : undefined;
}

/** The base console {@link RunOutputs} for a `result` relay event, before the
 * record pair is attached. A server job writes its result on the console, so
 * `resultsUrl` points at the job's console result endpoint rather than a
 * browser object URL; a withheld result is the withheld variant exactly as
 * the browser driver produces it.
 *
 * `resultWritten` is checked before the count (docs/spec/CLI_EVENTS.md,
 * `result`): a written result always wins, and only its `false` arm has a
 * count. A present count means a count-only outcome (no result file for
 * either party); its absence means withheld. `countReportedByPartner` caveats
 * the count only on a literal `true`; anything else -- omitted, or a
 * non-boolean -- is treated as this party's own count, per the contract. */
function baseResultOutputs(event: RelayEvent, jobId: string): RunOutputs {
  if (event.resultWritten !== false)
    return { kind: "matched", resultsUrl: jobResultUrl(jobId) };
  const intersectionCount = countOnlyResultCount(event);
  return intersectionCount !== undefined
    ? {
        kind: "counted",
        intersectionCount,
        countReportedByPartner: event.countReportedByPartner === true,
      }
    : { kind: "withheld" };
}

/** Attach the record-pair downloads to the base outputs, pointed at the
 * console's record/keys endpoints with filenames byte-identical to the
 * in-browser path's (the record's own `createdAt`, made filesystem-safe). The
 * record is written even for a withheld result, so it attaches in either
 * branch. */
function withRecordDownloads(
  outputs: RunOutputs,
  jobId: string,
  createdAt: string,
): RunOutputs {
  outputs.record = jobRecordDownloads(jobId, createdAt);
  return outputs;
}

/** Read the category off an `error` relay event, preserving it verbatim -- a
 * CLI-classified `security` terminal must reach the consumer as `security`,
 * never be downgraded to the retryable `exchange`. An event whose category is
 * not one of the four known values falls back to `exchange`. */
function errorCategoryOf(event: RelayEvent): ExchangeErrorCategory {
  const category = event.category;
  return category === "exchange" ||
    category === "output" ||
    category === "security" ||
    category === "config"
    ? category
    : "exchange";
}

/** Stands in for a relayed link holding no text of its own. The renderer frames
 * such a link like any other -- a cause thrown as an empty string is one, and
 * reaches the relay from a real failure -- so the rebuild below shows the
 * stand-in rather than closing the gap: a chain rendered one link shorter than
 * the one the CLI composed displays as a different failure, with its links
 * naming the wrong causes for each other. */
export const EMPTY_CHAIN_LINK = "[no message]";

/** Read the display-safe message off an `error` relay event, rebuilding the
 * cause chain from the links the relay held apart
 * ({@link ERROR_MESSAGE_CHAIN_FIELD}) so a terminal error arrives whole
 * rather than cut at the flat `message` field's per-value cap. A link with
 * no text renders as {@link EMPTY_CHAIN_LINK}, keeping the rebuilt chain the
 * length the relay sent. The flat field is the fallback, used when the relay
 * derived no chain at all. */
function errorMessageOf(event: RelayEvent): string {
  const chain = event[ERROR_MESSAGE_CHAIN_FIELD];
  if (
    Array.isArray(chain) &&
    chain.some((link) => typeof link === "string" && link.length > 0)
  )
    return joinErrorCauseChain(
      chain.map((link) =>
        typeof link === "string" && link.length > 0 ? link : EMPTY_CHAIN_LINK,
      ),
    );
  const message = event.message;
  return typeof message === "string" && message.length > 0
    ? message
    : "the exchange failed";
}

/** Build the {@link JobExchangeIntent} a run POSTs from the driver config: the
 * `transport` picks the arm (neither adds a connection field -- the sftp arm
 * has no `remote`, the console runs the one authored connection), and
 * everything after the discriminant is channel-independent. */
function intentFor(config: ServerJobExchangeDriverConfig): JobExchangeIntent {
  const {
    transport,
    side,
    linkageTerms,
    sharedSecret,
    inputSource,
    metadata,
    standardization,
    expectedPayloadColumns,
    expectedPartnerDeduplicate,
    options,
    runDiagnostics,
    receipts,
  } = config;
  const shared = {
    side,
    linkageTerms,
    sharedSecret,
    ...(inputSource.kind === "inline"
      ? { inputCsv: inputSource.csv }
      : { inputFile: { name: inputSource.name } }),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
    ...(expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate }
      : {}),
    ...(options !== undefined ? { options } : {}),
    ...runDiagnostics,
    ...receipts,
    eventStream: true,
  };
  return transport.channel === "sftp"
    ? { channel: "sftp", ...shared }
    : { channel: "filedrop", ...shared };
}

/** The construction-time inputs a zero-setup server-job driver needs. The
 * analog of {@link ServerJobExchangeDriverConfig} for the CLI's positional
 * `$0`/zero-setup command: it has none of the exchange mode's credential or
 * terms material (no `sharedSecret`, `linkageTerms`, `metadata`,
 * `standardization`, `expectedPayloadColumns`, or
 * `expectedPartnerDeduplicate`), because both parties infer terms from their
 * own files and there is no application-layer encryption to key. It supplies
 * only the channel, input source, tuning subset, and the zero-setup intent's
 * two optional bounded selectors. */
export interface ServerJobZeroSetupDriverConfig {
  transport: ServerJobExchangeTransport;
  /** Where the console reads this party's input from ({@link JobInputSource}):
   * inline CSV content, or a reference to a file in the operator-mounted
   * work-input directory. Mapped to the intent's `inputCsv` / `inputFile` arm. */
  inputSource: JobInputSource;
  options?: JobExchangeOptions;
  /** The operator's per-run diagnostic and recovery choices, exactly as the
   * exchange mode's ({@link RunDiagnosticsIntentFields}). */
  runDiagnostics?: RunDiagnosticsIntentFields;
  /** The optional operator label forwarded to the CLI's `--identity`: what the
   * partner sees as this party's name, and what attributes the disclosure record.
   * Omitted when blank -- the run then names no party, which every surface shows
   * as an absence rather than filling in. */
  identity?: string;
  /** The optional linkage strategy forwarded to the CLI's `--linkage-strategy`
   * (a closed enum); omitted for the cascade default. */
  linkageStrategy?: JobZeroSetupLinkageStrategy;
  /** Invoked with the created job's id the moment `POST /api/jobs` resolves,
   * before the event stream opens -- the same strand-recovery call site the
   * exchange driver exposes. */
  onJobCreated?: (jobId: string) => void;
}

/** Build the {@link JobZeroSetupIntent} a zero-setup run POSTs from the driver
 * config: the `transport` picks the arm (neither adds a connection field -- the
 * sftp arm has none, the console composes the connection from its own
 * effective server; the filedrop arm from the rendezvous mount), and everything
 * after the discriminant is channel-independent. Mirrors {@link intentFor} but
 * has no shared secret or linkage terms -- the zero-setup mode's whole
 * point. */
function zeroSetupIntentFor(
  config: ServerJobZeroSetupDriverConfig,
): JobZeroSetupIntent {
  const { transport, inputSource, options, identity, linkageStrategy } = config;
  const shared = {
    mode: "zeroSetup" as const,
    ...(inputSource.kind === "inline"
      ? { inputCsv: inputSource.csv }
      : { inputFile: { name: inputSource.name } }),
    ...(options !== undefined ? { options } : {}),
    ...config.runDiagnostics,
    ...(identity !== undefined ? { identity } : {}),
    ...(linkageStrategy !== undefined ? { linkageStrategy } : {}),
    eventStream: true,
  };
  return transport.channel === "sftp"
    ? { channel: "sftp", ...shared }
    : { channel: "filedrop", ...shared };
}

/**
 * Create the job, fire `onJobCreated`, then fold its SSE event stream onto the
 * lifecycle events -- the run body shared by both server-job drivers, differing
 * only in the {@link JobCreateIntent} the caller composed.
 *
 * Cancellation stays on the run's signal: an already-aborted signal starts
 * nothing, and an abort mid-run stops consuming the stream silently. The
 * driver sends no cancel intent -- an unmount, reload, or tab close leaves
 * the console's exchange running; only an explicit discard (start over, try
 * again, run another, or the recovery panel's Stop/Discard) cancels or
 * deletes it.
 */
async function runCreatedJob(
  intent: JobCreateIntent,
  onJobCreated: ((jobId: string) => void) | undefined,
  client: JobApiClient,
  events: ExchangeDriverEvents<RunOutputs>,
): Promise<void> {
  const { signal } = events;
  // Read the live abort state through a call so the re-check after the await
  // is not narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  if (aborted()) return;

  let jobId: string;
  try {
    jobId = await client.createJob(intent, signal);
  } catch (error) {
    if (aborted()) return;
    events.onError({ category: createJobFailureCategory(error), error });
    return;
  }

  // The job now exists on the console; persist its id here (the
  // strand-recovery call site) before opening the stream, so a hard tab
  // close between here and the terminal can still re-attach.
  onJobCreated?.(jobId);

  await consumeJobStream(client, jobId, events);
}

/**
 * Build a server-job {@link ExchangeDriver}: `run` POSTs a
 * {@link JobExchangeIntent} for the config's transport (filedrop, or sftp
 * over the operator-authored connection) to the job API and maps the
 * server's SSE event stream onto the typed lifecycle events -- a drop-in for
 * the in-browser WebRTC driver behind the same contract. It owns no peer
 * connection, PSI library, or exchange result: the result is written on the
 * console, not downloaded in the browser.
 *
 * Faithful mapping: `stages`/`stage` forward in order; `result` fires
 * `onResult` once; `error` fires `onError` once with the CLI-classified
 * category preserved verbatim (`security` stays `security`). Exactly one
 * terminal fires per run. A `warning` event's message forwards to the optional
 * `onWarning` (and keeps its dev-gated log either way); with no `onWarning`
 * it is logged and dropped.
 */
export function createServerJobExchangeDriver(
  config: ServerJobExchangeDriverConfig,
  client: JobApiClient = createFetchJobApiClient(),
): ExchangeDriver<RunOutputs> {
  return {
    run: (events: ExchangeDriverEvents<RunOutputs>) =>
      runCreatedJob(intentFor(config), config.onJobCreated, client, events),
  };
}

/**
 * Build a zero-setup server-job {@link ExchangeDriver}: `run` POSTs a
 * {@link JobZeroSetupIntent} (the console "Direct exchange" flow) to the job
 * API and folds its event stream onto the same lifecycle events the exchange
 * driver does. It has no shared secret and no linkage terms -- both parties
 * run the CLI's positional `$0` form against the same server, terms inferred
 * from each file -- only the input source, tuning subset, and optional
 * identity / linkage-strategy selectors. The event mapping and cancellation
 * posture are exactly the exchange driver's, since both share
 * {@link runCreatedJob}.
 */
export function createServerJobZeroSetupDriver(
  config: ServerJobZeroSetupDriverConfig,
  client: JobApiClient = createFetchJobApiClient(),
): ExchangeDriver<RunOutputs> {
  return {
    run: (events: ExchangeDriverEvents<RunOutputs>) =>
      runCreatedJob(
        zeroSetupIntentFor(config),
        config.onJobCreated,
        client,
        events,
      ),
  };
}

/**
 * Re-attach to an already-created job by id: `run` skips creation and
 * consumes `GET /api/jobs/:id/events` from offset 0. The SSE full-history
 * replay reconstructs the whole lifecycle -- stages, warnings, and the
 * terminal -- for a finished run in one request, and continues live for a
 * running one, so the same event fold the hooks use drives the recovery
 * surface unchanged. A 404 from the events route (the job was deleted, or a
 * restart forgot it) shows as the existing terminal error the recovery panel
 * maps to "stale". Sends no intent and no cancel: it only reads the stream.
 */
export function createServerJobReattachDriver(
  jobId: string,
  client: JobApiClient = createFetchJobApiClient(),
): ExchangeDriver<RunOutputs> {
  return {
    run: async (events: ExchangeDriverEvents<RunOutputs>) => {
      if (events.signal.aborted) return;
      await consumeJobStream(client, jobId, events);
    },
  };
}

/**
 * Consume a job's SSE event stream and fold each frame onto the typed lifecycle
 * events, shared by the create-then-run and the re-attach drivers. An aborted
 * signal stops consumption silently (no terminal, no cancel), matching the
 * browser lifecycle's treatment of a caller-initiated abort.
 */
async function consumeJobStream(
  client: JobApiClient,
  jobId: string,
  {
    signal,
    onStages,
    onStage,
    onResult,
    onError,
    onWarning,
  }: ExchangeDriverEvents<RunOutputs>,
): Promise<void> {
  // Read the live abort state through a call so the re-checks across each
  // `await` below are not narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  try {
    for await (const event of client.openEventStream(jobId, signal)) {
      if (aborted()) return;
      switch (event.type) {
        case "stages":
          onStages(stagesOf(event));
          break;
        case "stage": {
          const id = event.id;
          if (typeof id === "string") onStage(id);
          break;
        }
        case "warning": {
          // Dev-gated like onError: event.message is server/CLI-controlled,
          // so a production console has none of it. The consumer's optional
          // onWarning is the operator-facing slot; it renders through its
          // own display-boundary sanitization.
          whenDiagnostic(() => log.warn("server job warning:", event.message));
          const message = event.message;
          if (
            onWarning !== undefined &&
            typeof message === "string" &&
            message.length > 0
          )
            onWarning(message);
          break;
        }
        case "result": {
          const outputs = baseResultOutputs(event, jobId);
          const availability = await queryRecordAvailability(
            client,
            jobId,
            signal,
          );
          // Re-check after the await: a caller-initiated abort mid-query
          // stays silent, matching the browser lifecycle.
          if (aborted()) return;
          if (availability.available)
            withRecordDownloads(outputs, jobId, availability.createdAt);
          onResult(outputs);
          return;
        }
        case "error":
          onError({
            category: errorCategoryOf(event),
            error: new RelayedTerminalError(errorMessageOf(event)),
          });
          return;
        default:
          // `stageEnd` and `metrics` are recognized progress/summary events
          // (in RELAY_EVENT_TYPES so the relay does not degrade them) that the
          // console does not yet expose; they have no lifecycle mapping, so
          // consume and ignore them rather than treating them as an error.
          break;
      }
    }
    // The job API reconciles a terminal event for every job before it closes
    // the stream, so a terminal-less close is a truncated stream rather than
    // a completed run. Report it so the contract's exactly-one-terminal
    // guarantee holds at the driver boundary instead of leaving the run hung.
    if (!aborted())
      onError({
        category: "exchange",
        error: new Error("the exchange event stream ended without a result"),
      });
  } catch (error) {
    if (aborted()) return;
    onError({ category: "exchange", error });
  }
}

/** Query the job's record availability as a graceful-degrade step: any failure
 * or abort resolves to unavailable so the run still delivers its primary
 * artifact (the result CSV) rather than failing on a metadata fetch. The
 * diagnostic is dev-gated like the driver's other server-influenced logs. */
async function queryRecordAvailability(
  client: JobApiClient,
  jobId: string,
  signal: AbortSignal,
): Promise<RecordAvailability> {
  try {
    return await client.fetchRecordAvailability(jobId, signal);
  } catch (error) {
    whenDiagnostic(() =>
      log.warn("server job record availability query failed:", error),
    );
    return { available: false };
  }
}

/** Categorize a `createJob` failure: a 400 is a rejected/invalid intent, which
 * is a local-configuration fault (`config`); every other non-2xx and every
 * network error is a transport/server fault (`exchange`). */
function createJobFailureCategory(error: unknown): ExchangeErrorCategory {
  return error instanceof JobApiRequestError && error.status === 400
    ? "config"
    : "exchange";
}
