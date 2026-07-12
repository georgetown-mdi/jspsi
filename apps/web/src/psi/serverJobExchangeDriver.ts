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

const log = getLogger("serverJobExchangeDriver");

/** The construction-time inputs a server-job driver needs: the analog of the
 * browser driver's config, minus everything that only a peer-to-peer run has (no
 * `acquire`, no PSI library, no `generateOutput`). These are exactly the
 * {@link JobExchangeIntent} fields the wiring agent draws from the prepared
 * exchange; the driver stamps `channel: "filedrop"` and `eventStream: true`
 * itself, so a caller supplies only the exchange payload. */
export interface ServerJobExchangeDriverConfig {
  linkageTerms: LinkageTerms;
  sharedSecret: string;
  inputCsv: string;
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
 * with a streaming `fetch` (not `EventSource`, which cannot carry an
 * `Authorization` header the appliance API may require and is harder to drive
 * from a unit test). Every connect replays the job's full event history and the
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
  "warning",
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

/**
 * Build a server-job {@link ExchangeDriver} for a filedrop exchange: `run` POSTs
 * a {@link JobExchangeIntent} to the job API and maps the server's SSE event
 * stream onto the typed lifecycle events, so it is a drop-in for the in-browser
 * WebRTC driver behind the same contract. It owns no peer connection, PSI
 * library, or exchange result -- the result is written on the console appliance,
 * not downloaded in the browser.
 *
 * Faithful mapping: `stages`/`stage` forward in order; `result` fires
 * `onResult` once; `error` fires `onError` once with the CLI-classified
 * category preserved verbatim (`security` stays `security`). Exactly one
 * terminal fires per run. A `warning` event has no slot in the contract, so it
 * is logged and dropped rather than invented into an `onWarning`.
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
  const {
    linkageTerms,
    sharedSecret,
    inputCsv,
    metadata,
    standardization,
    options,
  } = config;
  return {
    run: async ({
      signal,
      onStages,
      onStage,
      onResult,
      onError,
    }: ExchangeDriverEvents<RunOutputs>) => {
      // Read the live abort state through a call so the re-checks across each
      // `await` below are not narrowed to a constant by the first guard.
      const aborted = () => signal.aborted;
      if (aborted()) return;

      const intent: JobExchangeIntent = {
        channel: "filedrop",
        linkageTerms,
        sharedSecret,
        inputCsv,
        ...(metadata !== undefined ? { metadata } : {}),
        ...(standardization !== undefined ? { standardization } : {}),
        ...(options !== undefined ? { options } : {}),
        eventStream: true,
      };

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
            case "warning":
              // Dev-gated like onError: event.message is server/CLI-controlled,
              // so a production console carries none of it.
              whenDiagnostic(() =>
                log.warn("server job warning:", event.message),
              );
              break;
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
