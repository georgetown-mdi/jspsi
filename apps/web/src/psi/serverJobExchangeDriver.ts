import { ProcessState, getLogger } from "@psilink/core";

import { recordFileStamp } from "@bench/runOutputs";
import { whenDiagnostic } from "@utils/diagnostics";

import type { ExchangeDriver, ExchangeDriverEvents } from "./exchangeDriver";
import type {
  ExchangeErrorCategory,
  StageDefinition,
} from "./exchangeLifecycle";
import type { JobExchangeIntent, JobExchangeOptions } from "@jobs/intent";
import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";
import type { RelayEvent, RelayEventType } from "@jobs/cliDriver";
import type { RunOutputs } from "@bench/runOutputs";
import type { SftpConnectionProjection } from "@jobs/jobManager";

const log = getLogger("serverJobExchangeDriver");

/** The channel a server job runs over, mirroring the {@link JobExchangeIntent}
 * discriminant so the driver stays transport-blind past intent construction.
 * The sftp variant carries no connection field at all: the appliance is
 * provisioned with exactly one SFTP server (`GET /api/jobs/sftp`), so every
 * host, port, path, and credential reference lives on the appliance, never in
 * the browser. */
export type ServerJobExchangeTransport =
  { channel: "filedrop" } | { channel: "sftp" };

/**
 * Where the appliance reads this party's input from. `inline` carries the CSV
 * content the browser holds (the hosted-shaped path: the server writes it to the
 * fixed workdir name). `workFile` carries only a REFERENCE to a file in the
 * operator-mounted work-input directory -- an opaque single-segment name -- so no
 * content transits the browser and the CLI reads the file in place. `intentFor`
 * maps `inline` to the intent's `inputCsv` arm and `workFile` to its `inputFile`
 * arm (exactly one of the two is ever set). */
export type JobInputSource =
  { kind: "inline"; csv: string } | { kind: "workFile"; name: string };

/** The construction-time inputs a server-job driver needs: the analog of the
 * browser driver's config, minus everything that only a peer-to-peer run has (no
 * `acquire`, no PSI library, no `generateOutput`). These are exactly the
 * {@link JobExchangeIntent} fields the wiring agent draws from the prepared
 * exchange; `transport` picks the intent arm and the driver stamps
 * `eventStream: true` itself, so a caller supplies only the exchange payload
 * and the channel it rides. */
export interface ServerJobExchangeDriverConfig {
  transport: ServerJobExchangeTransport;
  linkageTerms: LinkageTerms;
  sharedSecret: string;
  /** Where the appliance reads this party's input from: inline CSV content, or a
   * reference to a file in the operator-mounted work-input directory
   * ({@link JobInputSource}). Mapped to the intent's `inputCsv` / `inputFile` arm by
   * {@link intentFor}. */
  inputSource: JobInputSource;
  /** This party's authored column metadata (which columns are sent vs ignored,
   * their roles/types). Carried into the intent so the appliance's CLI uses the
   * operator's edits instead of inferring metadata from the column names -- an
   * inferred column defaults to disclosed payload, so an omitted metadata would
   * silently disclose a column the operator marked ignored. Forwarded only when
   * present, mirroring how the browser path guards these. */
  metadata?: Metadata;
  /** This party's authored standardization pipeline, paired with {@link metadata}.
   * Forwarded only when present. */
  standardization?: Standardization;
  /** The acceptor's received-payload lock-in (partner-namespace column names),
   * mirrored from the invitation's disclosed set. Carried into the intent so the
   * CLI enforces it explicitly instead of relying on the lazy `payload.receive`
   * fallback, which fails open when the token discloses columns but carries no
   * `payload.send`. Forwarded whenever present, INCLUDING an empty array (a strict
   * "receive nothing"); only an omitted field reconciles lazily. The inviter path
   * leaves it undefined -- the lock-in is the acceptor's. */
  expectedPayloadColumns?: Array<string>;
  options?: JobExchangeOptions;
}

/** The exchange-record pair's availability on the appliance, read off
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
   * throws {@link JobApiRequestError} on a non-2xx, or a network error as-is. */
  createJob: (
    intent: JobExchangeIntent,
    signal: AbortSignal,
  ) => Promise<string>;
  /** `GET /api/jobs/:id/events` as an async iterable of already-validated
   * {@link RelayEvent}s; the iterator completes when the server closes the
   * stream after the terminal event (or when `signal` aborts). */
  openEventStream: (
    jobId: string,
    signal: AbortSignal,
  ) => AsyncIterable<RelayEvent>;
  /** `POST /api/jobs/:id/cancel`; best-effort, errors are swallowed by the
   * caller since a cancel races a naturally-terminating job. */
  cancelJob: (jobId: string) => Promise<void>;
  /** `GET /api/jobs/:id`, reading `recordAvailable`/`recordCreatedAt` off the
   * status body. A graceful-degrade metadata fetch: the driver delivers the
   * result without the record pair if this fails or aborts. */
  fetchRecordAvailability: (
    jobId: string,
    signal: AbortSignal,
  ) => Promise<RecordAvailability>;
}

/** A non-2xx response from the job API, carrying the status so the driver can
 * pick the failure category (a 400 is a rejected/invalid intent -> `config`;
 * any other non-2xx is a transport/server fault -> `exchange`). */
export class JobApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JobApiRequestError";
  }
}

/** The result CSV of a server-driven job lives on the appliance, retrievable
 * through this endpoint rather than as a browser object URL. */
function jobResultUrl(jobId: string): string {
  return `/api/jobs/${jobId}/result`;
}

/** The self-attested exchange record, served from the appliance. */
function jobRecordUrl(jobId: string): string {
  return `/api/jobs/${jobId}/record`;
}

/** The private verification keys paired with the record, served from the
 * appliance. */
function jobKeysUrl(jobId: string): string {
  return `/api/jobs/${jobId}/keys`;
}

/** The default {@link JobApiClient}, hitting the real same-origin job endpoints
 * with a streaming `fetch` (not `EventSource`, which is harder to drive from a
 * unit test). Every connect replays the job's full event history and the
 * server closes the stream after the terminal event, so one request carries a
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
        );
      const body: unknown = await response.json();
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
    fetchRecordAvailability: async (jobId, signal) => {
      const response = await fetchImpl(`/api/jobs/${jobId}`, {
        method: "GET",
        signal,
      });
      if (!response.ok) return { available: false };
      const body: unknown = await response.json();
      const available = (body as { recordAvailable?: unknown }).recordAvailable;
      const createdAt = (body as { recordCreatedAt?: unknown }).recordCreatedAt;
      if (available !== true || typeof createdAt !== "string")
        return { available: false };
      return { available: true, createdAt };
    },
  };
}

/**
 * Fetch the appliance's operator-provisioned SFTP server
 * (`GET /api/jobs/sftp`) as the validated projection, or null when none is
 * provisioned. Fail-safe toward "none configured": a non-2xx, a network error,
 * a `{ configured: false }` body, or a malformed `{ configured: true, ... }`
 * body all resolve to null, so the bench falls back to the save-a-file surface
 * rather than arming a server-job run it has no connection for.
 */
export async function fetchSftpConnection(
  fetchImpl: typeof fetch = fetch,
): Promise<SftpConnectionProjection | null> {
  try {
    const response = await fetchImpl("/api/jobs/sftp", { method: "GET" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return sftpConnectionProjectionOf(body);
  } catch {
    return null;
  }
}

/** Validate the sftp response body into the projection, or null when it reports
 * `configured: false` or is malformed -- a partial or ill-formed body fails
 * closed to save-a-file rather than arming a run against a connection the
 * operator did not provision. */
function sftpConnectionProjectionOf(
  body: unknown,
): SftpConnectionProjection | null {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  const { configured, host, port, path } = body as Record<string, unknown>;
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
  const connection: SftpConnectionProjection = { host };
  if (port !== undefined) connection.port = port;
  if (path !== undefined) connection.path = path;
  return connection;
}

/** Open the SSE event stream and yield each parsed frame as a {@link RelayEvent}.
 * A frame that is not a JSON object with the relay-event shape is skipped rather
 * than yielded, mirroring the server's own fail-safe validation. */
async function* streamJobEvents(
  fetchImpl: typeof fetch,
  jobId: string,
  signal: AbortSignal,
): AsyncIterable<RelayEvent> {
  const response = await fetchImpl(`/api/jobs/${jobId}/events`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok)
    throw new JobApiRequestError(
      response.status,
      `GET /api/jobs/${jobId}/events failed with status ${response.status}`,
    );
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
        const event = parseSseFrame(frame);
        if (event !== null) yield event;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
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
    parsed = JSON.parse(dataLines.join("\n"));
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
 * a malformed frame cannot crash the run. The relay event carries only `id` and
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

/** The base bench {@link RunOutputs} for a `result` relay event, before the
 * record pair is attached. A server job writes its result on the appliance, so
 * there is no browser object URL: a received result points `resultsUrl` at the
 * job's appliance result endpoint (a real same-origin download href), and a
 * withheld result is the withheld variant exactly as the browser driver
 * produces it. */
function baseResultOutputs(event: RelayEvent, jobId: string): RunOutputs {
  return event.resultWritten === false
    ? { resultWithheld: true }
    : { resultsUrl: jobResultUrl(jobId) };
}

/** Attach the record-pair downloads to the base outputs, pointed at the
 * appliance's record/keys endpoints with filenames byte-identical to the
 * in-browser path's (the record's own `createdAt`, made filesystem-safe). The
 * record is written even for a withheld result, so it attaches in either
 * branch. */
function withRecordDownloads(
  outputs: RunOutputs,
  jobId: string,
  createdAt: string,
): RunOutputs {
  const stamp = recordFileStamp(createdAt);
  outputs.record = {
    recordUrl: jobRecordUrl(jobId),
    recordFileName: `psilink-record-${stamp}.json`,
    keysUrl: jobKeysUrl(jobId),
    keysFileName: `psilink-record-${stamp}.keys.json`,
  };
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

/** Read the display-safe message off an `error` relay event. */
function errorMessageOf(event: RelayEvent): string {
  const message = event.message;
  return typeof message === "string" && message.length > 0
    ? message
    : "the exchange failed";
}

/** Build the {@link JobExchangeIntent} a run POSTs from the driver config: the
 * `transport` picks the arm (neither adds a connection field -- the sftp arm
 * carries no `remote`, the appliance provisions the one server), and everything
 * after the discriminant is channel-independent. */
function intentFor(config: ServerJobExchangeDriverConfig): JobExchangeIntent {
  const {
    transport,
    linkageTerms,
    sharedSecret,
    inputSource,
    metadata,
    standardization,
    expectedPayloadColumns,
    options,
  } = config;
  const shared = {
    linkageTerms,
    sharedSecret,
    ...(inputSource.kind === "inline"
      ? { inputCsv: inputSource.csv }
      : { inputFile: { name: inputSource.name } }),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
    ...(options !== undefined ? { options } : {}),
    eventStream: true,
  };
  return transport.channel === "sftp"
    ? { channel: "sftp", ...shared }
    : { channel: "filedrop", ...shared };
}

/**
 * Build a server-job {@link ExchangeDriver}: `run` POSTs a
 * {@link JobExchangeIntent} for the config's transport (filedrop, or sftp over
 * the operator-provisioned server) to the job API and maps the server's
 * SSE event stream onto the typed lifecycle events, so it is a drop-in for the
 * in-browser WebRTC driver behind the same contract. It owns no peer
 * connection, PSI library, or exchange result -- the result is written on the
 * console appliance, not downloaded in the browser. Past intent construction
 * every step is channel-independent.
 *
 * Faithful mapping: `stages`/`stage` forward in order; `result` fires
 * `onResult` once; `error` fires `onError` once with the CLI-classified
 * category preserved verbatim (`security` stays `security`). Exactly one
 * terminal fires per run. A `warning` event's message forwards to the optional
 * `onWarning` (and keeps its dev-gated log either way); with no `onWarning`
 * it is logged and dropped.
 *
 * Cancellation stays on the run's signal: an already-aborted signal starts
 * nothing; an abort mid-run POSTs a cancel and stops consuming the stream
 * without emitting a spurious error, matching how the browser lifecycle treats a
 * caller-initiated abort as silent.
 */
export function createServerJobExchangeDriver(
  config: ServerJobExchangeDriverConfig,
  client: JobApiClient = createFetchJobApiClient(),
): ExchangeDriver<RunOutputs> {
  return {
    run: async ({
      signal,
      onStages,
      onStage,
      onResult,
      onError,
      onWarning,
    }: ExchangeDriverEvents<RunOutputs>) => {
      // Read the live abort state through a call so the re-checks across each
      // `await` below are not narrowed to a constant by the first guard.
      const aborted = () => signal.aborted;
      if (aborted()) return;

      const intent = intentFor(config);

      let jobId: string;
      try {
        jobId = await client.createJob(intent, signal);
      } catch (error) {
        if (aborted()) return;
        onError({ category: createJobFailureCategory(error), error });
        return;
      }

      // A caller-initiated abort is silent (no spurious error), matching the
      // browser lifecycle; it best-effort cancels the server job and stops
      // consuming the stream.
      const onAbort = () => {
        void client.cancelJob(jobId).catch((error) => {
          log.error("server job cancel failed:", error);
        });
      };
      if (aborted()) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

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
              // so a production console carries none of it. The consumer's
              // optional onWarning is the operator-facing slot; it renders
              // through its own display-boundary sanitization.
              whenDiagnostic(() =>
                log.warn("server job warning:", event.message),
              );
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
                error: new Error(errorMessageOf(event)),
              });
              return;
            default:
              // `stageEnd` and `metrics` are recognized progress/summary events
              // (in RELAY_EVENT_TYPES so the relay does not degrade them) that the
              // console does not yet surface; they carry no lifecycle mapping, so
              // consume and ignore them rather than treating them as an error.
              break;
          }
        }
        // The job API reconciles a terminal event for every job before it closes
        // the stream, so a terminal-less close is a truncated stream rather than
        // a completed run. Surface it so the contract's exactly-one-terminal
        // guarantee holds at the driver boundary instead of leaving the run hung.
        if (!aborted())
          onError({
            category: "exchange",
            error: new Error(
              "the exchange event stream ended without a result",
            ),
          });
      } catch (error) {
        if (aborted()) return;
        onError({ category: "exchange", error });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
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
