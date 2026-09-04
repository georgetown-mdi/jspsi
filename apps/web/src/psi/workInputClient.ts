import { isRecord, readJsonOrNull } from "./jobApiBody";

import type {
  JobInputListing,
  JobInputProfile,
  JobInputProfileErrorCode,
} from "@jobs/workInputs";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";
import type { Standardization } from "@psilink/core";

/**
 * The browser-side client for the console's work-input API
 * ({@link ../jobs/workInputs}): the operator-mounted directory listing, the
 * per-file streaming profile, and the per-field coverage sweep. Every call is a
 * same-origin fetch to a `gateJobRoute`-protected endpoint; off the console
 * those endpoints answer 404, so a hosted build never reaches a configured
 * directory. Responses are validated defensively -- the console is trusted, but
 * a malformed body degrades to an honest error state rather than a crash.
 */

/** A committed mounted file: the opaque name the coverage sweep and the job intent
 * carry. The CLI reads the file in place, so no size/mtime snapshot travels. */
export interface WorkInputReference {
  name: string;
}

/** The `GET /api/jobs/inputs` outcome: the listing, a stable `disabled` state (the
 * job API is off -- `JOB_DATA_ROOT` unset -- so the gate 404s), or a transient
 * `error` (another non-2xx, a network fault, or a malformed body). The picker
 * renders these as three distinct states so an off-console signal reads as
 * configuration, not a fault to retry. */
export type JobInputsResult =
  | { kind: "listing"; listing: JobInputListing }
  | { kind: "disabled" }
  | { kind: "error" };

/** The validated console profile: the wire {@link JobInputProfile}'s fields with
 * `columnSamples` rebuilt as a `Map` keyed by column name. A prototype-member column
 * name (`__proto__`, `constructor`, `prototype`) is ordinary map data on this hop, so
 * no read resolves to an inherited member and no write drives a prototype setter. */
export type ProfiledJobInput = Omit<JobInputProfile, "columnSamples"> & {
  columnSamples: Map<string, Array<string>>;
};

/** Why a profile is unavailable, a closed set the picker turns into copy. `not_found`
 * is the 404 (the file is gone -- removed or replaced since the listing); the three
 * fault codes are the profile route's ({@link JobInputProfileErrorCode}); `unknown`
 * is the catch-all for a network error, an off-console 404, or a malformed body -- it
 * carries no free text, keeping the set closed. */
export type JobInputProfileUnavailableReason =
  "not_found" | JobInputProfileErrorCode | "unknown";

/** The `GET /api/jobs/inputs/profile` outcome: the profile, or unavailable with a
 * closed reason the picker renders. */
export type JobInputProfileResult =
  | { kind: "profile"; profile: ProfiledJobInput }
  | { kind: "unavailable"; reason: JobInputProfileUnavailableReason };

/** The closed profile-fault codes the route may carry in a 400 body, so a body whose
 * `error` is anything else degrades to `unknown` rather than passing free text
 * through. */
const PROFILE_ERROR_CODES: ReadonlyArray<JobInputProfileErrorCode> = [
  "too_large",
  "not_a_csv",
  "parse_failed",
];

/** Read the closed profile-fault code from a 400 body, or `unknown` for any other
 * shape (an empty body, or an unrecognized `error` value). */
function profileErrorReasonOf(body: unknown): JobInputProfileUnavailableReason {
  if (!isRecord(body)) return "unknown";
  const code = body.error;
  return PROFILE_ERROR_CODES.find((known) => known === code) ?? "unknown";
}

/** The console's rendezvous configuration read off `GET /api/jobs/rendezvous`: the
 * mounted directory (or directories) a filedrop exchange runs against.
 * `configured: false` (no mount resolved, the request failed, or the body named
 * no locator) leaves the filedrop transport unavailable; `locator` is the
 * advisory locator the inviter mints into the invitation, and `folderName` the
 * shared folder's own name -- present only where the console can name it, and
 * the only one of the two safe to show as that name.
 *
 * `split` reports a console provisioned with a separate outbound mount: every
 * filedrop exchange it runs reads the peer's files from the inbound folder
 * (`locator`/`folderName`) and writes its own into the outbound one
 * (`outboundLocator`/`outboundFolderName`), and requires retain mode. Both
 * locators are present whenever `split` is, since an invitation needs a name
 * for each leg.
 *
 * `sharesDataRoot` reports the single-mount layout: a rendezvous folder that
 * holds the mounted working directory, so what the partner syncs into is also
 * where this party's signing key lives. Absent reads as the shared layout, the
 * fail-safe direction for the surfaces that warn about the key's location.
 *
 * `sharesDataRootUncertain` reports whether that layout was positively
 * established -- a lexical or filesystem match -- rather than defaulted to;
 * meaningful only alongside `sharesDataRoot: true`, where an unconfirmed body
 * reads as uncertain, the same fail-safe direction.
 *
 * `problem` is why the console cannot run a filedrop exchange as provisioned,
 * in the operator's own terms; it accompanies `configured: false`, so the
 * unavailable state carries its own remedy. */
export interface JobRendezvousConfig {
  configured: boolean;
  split?: boolean;
  locator?: string;
  folderName?: string;
  outboundLocator?: string;
  outboundFolderName?: string;
  sharesDataRoot?: boolean;
  sharesDataRootUncertain?: boolean;
  problem?: string;
}

function isStringArray(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** Validate a listing response body, returning null when any field is malformed so
 * a bad body degrades to the error state rather than rendering a partial list. */
function jobInputListingOf(body: unknown): JobInputListing | null {
  if (!isRecord(body)) return null;
  const { configured, readable, files } = body;
  if (typeof configured !== "boolean") return null;
  // Absent `readable` reads as readable: true -- the non-alarming direction, so an
  // older/partial body shows its files rather than a false "unreadable mount".
  if (readable !== undefined && typeof readable !== "boolean") return null;
  if (!Array.isArray(files)) return null;
  const parsed: JobInputListing["files"] = [];
  for (const entry of files) {
    if (!isRecord(entry)) return null;
    const { name, sizeBytes, modifiedAt } = entry;
    if (typeof name !== "string" || name.length === 0) return null;
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes))
      return null;
    if (typeof modifiedAt !== "number" || !Number.isInteger(modifiedAt))
      return null;
    parsed.push({ name, sizeBytes, modifiedAt });
  }
  return { configured, readable: readable ?? true, files: parsed };
}

/** Validate a profile response body, returning null when any required field is
 * malformed. `columnSamples` arrives as an ordered array of `{ column, values }`
 * pairs and is validated into a `Map`, so a prototype-member column name stays plain
 * data (a `{ [column]: values }` object would drive the prototype setter on write and
 * resolve inherited members on read). A blank column name is admitted -- the console
 * raises its own unnamed-column alert -- and a repeated name keeps the last pair. */
function jobInputProfileOf(body: unknown): ProfiledJobInput | null {
  if (!isRecord(body)) return null;
  const { name, sizeBytes, modifiedAt, rowCount, columns, columnSamples } =
    body;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes))
    return null;
  if (typeof modifiedAt !== "number" || !Number.isInteger(modifiedAt))
    return null;
  if (typeof rowCount !== "number" || !Number.isInteger(rowCount)) return null;
  if (!isStringArray(columns)) return null;
  if (!Array.isArray(columnSamples)) return null;
  const samples = new Map<string, Array<string>>();
  for (const entry of columnSamples) {
    if (!isRecord(entry)) return null;
    const { column, values } = entry;
    if (typeof column !== "string") return null;
    if (!isStringArray(values)) return null;
    samples.set(column, values);
  }
  const dateInputFormat = body.dateInputFormat;
  if (dateInputFormat !== undefined && typeof dateInputFormat !== "string")
    return null;
  return {
    name,
    sizeBytes,
    modifiedAt,
    rowCount,
    columns,
    columnSamples: samples,
    ...(dateInputFormat !== undefined ? { dateInputFormat } : {}),
  };
}

/** List the operator-mounted input files. A 404 is the deliberate API-disabled
 * state (`JOB_DATA_ROOT` unset, so the route's gate answers 404): the route
 * exists in every build and the picker renders only on a console build, so a 404
 * here is unambiguous config, not a transient fault. Every other non-2xx, a
 * network error, and a malformed body stay the transient `error` state. */
export async function fetchJobInputs(
  fetchImpl: typeof fetch = fetch,
): Promise<JobInputsResult> {
  try {
    const response = await fetchImpl("/api/jobs/inputs", { method: "GET" });
    if (response.status === 404) return { kind: "disabled" };
    if (!response.ok) return { kind: "error" };
    const body: unknown = await response.json();
    const listing = jobInputListingOf(body);
    return listing === null ? { kind: "error" } : { kind: "listing", listing };
  } catch {
    return { kind: "error" };
  }
}

/** Profile one mounted input file by its admissible name. A 404 is `not_found` (the
 * file is gone since the listing); a 400 carries a closed profile-fault code the
 * picker names; anything else (another non-2xx, a malformed body, a network error) is
 * `unknown`. */
export async function fetchJobInputProfile(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobInputProfileResult> {
  try {
    const response = await fetchImpl(
      `/api/jobs/inputs/profile?name=${encodeURIComponent(name)}`,
      { method: "GET" },
    );
    if (!response.ok) {
      if (response.status === 404)
        return { kind: "unavailable", reason: "not_found" };
      if (response.status === 400)
        return {
          kind: "unavailable",
          reason: profileErrorReasonOf(await readJsonOrNull(response)),
        };
      return { kind: "unavailable", reason: "unknown" };
    }
    const body: unknown = await response.json();
    const profile = jobInputProfileOf(body);
    return profile === null
      ? { kind: "unavailable", reason: "unknown" }
      : { kind: "profile", profile };
  } catch {
    return { kind: "unavailable", reason: "unknown" };
  }
}

/** The default number of rendezvous-probe attempts and the delay between them. A
 * failed probe retries in-page rather than leaving the filedrop transport disabled
 * until a full page reload; a definitive answer (a clean 200) never retries. */
export const RENDEZVOUS_PROBE_ATTEMPTS = 3;
const RENDEZVOUS_PROBE_RETRY_MS = 400;

/** One rendezvous probe: the config on a definitive answer, or null when the probe
 * itself failed (a non-2xx, a network error, or a malformed body) and is worth
 * retrying. A clean 200 -- whether configured or not -- is definitive. */
async function probeJobRendezvous(
  fetchImpl: typeof fetch,
): Promise<JobRendezvousConfig | null> {
  try {
    const response = await fetchImpl("/api/jobs/rendezvous", { method: "GET" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.configured !== "boolean") return null;
    if (!body.configured) {
      const problem = body.problem;
      // An unavailable mount the console gave a reason for carries it through, so
      // the seat that reports the state names the variable to set rather than the
      // generic "nothing is mounted".
      return typeof problem === "string" && problem.length > 0
        ? { configured: false, problem }
        : { configured: false };
    }
    const locator = body.locator;
    // A configured mount the body names no locator for cannot mint an invitation,
    // so it reads as unavailable rather than as a filedrop card that refuses at
    // create time.
    if (typeof locator !== "string" || locator.length === 0)
      return { configured: false };
    const folderName = body.folderName;
    const split = body.split === true;
    const outboundLocator =
      typeof body.outboundLocator === "string" &&
      body.outboundLocator.length > 0
        ? body.outboundLocator
        : undefined;
    // A split console whose body names no outbound locator could mint only half
    // a pair, which core refuses at the mint; degrade to unavailable rather than
    // offering a card that fails there.
    if (split && outboundLocator === undefined) return { configured: false };
    const outboundFolderName = body.outboundFolderName;
    // Anything but an explicit `false` reads as the shared layout: a body that
    // does not answer leaves the identity-location warning raised rather than
    // silently withheld, which is the direction that warning is safe to fail in.
    const sharesDataRoot = body.sharesDataRoot !== false;
    return {
      configured: true,
      locator,
      sharesDataRoot,
      // Meaningful only alongside a shared layout, so carried only there.
      // Uncertain unless the body positively confirms both that the layout is
      // shared AND that the walk established it rather than defaulted to it:
      // the same fail-safe direction as sharesDataRoot itself, so a malformed
      // or absent field hedges rather than asserts the layout as fact.
      ...(sharesDataRoot
        ? {
            sharesDataRootUncertain: !(
              body.sharesDataRoot === true &&
              body.sharesDataRootUncertain === false
            ),
          }
        : {}),
      // A malformed name degrades to "the console cannot name the folder", which
      // is the direction the accept kit is safe to fail in.
      ...(typeof folderName === "string" && folderName.length > 0
        ? { folderName }
        : {}),
      ...(split && outboundLocator !== undefined
        ? {
            split: true,
            outboundLocator,
            ...(typeof outboundFolderName === "string" &&
            outboundFolderName.length > 0
              ? { outboundFolderName }
              : {}),
          }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Read the console's rendezvous configuration, retrying a failed probe in-page. A
 * transient probe failure (a non-2xx, a network error, or a malformed body) retries
 * up to `attempts` times before failing safe, so a momentary hiccup recovers without a
 * page reload rather than silently disabling the filedrop transport for the session.
 *
 * Fail-safe toward "unavailable": once the attempts are spent the result is
 * `{ configured: false }`, so filedrop is offered only when the console confirms a
 * mount. A definitive `200` (configured or not) returns at once without retrying.
 *
 * `attempts` and `delay` are injectable so a test drives the retry deterministically
 * without a real timer.
 */
export async function fetchJobRendezvous(
  fetchImpl: typeof fetch = fetch,
  attempts: number = RENDEZVOUS_PROBE_ATTEMPTS,
  delay: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<JobRendezvousConfig> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await probeJobRendezvous(fetchImpl);
    if (result !== null) return result;
    if (attempt < attempts - 1) await delay(RENDEZVOUS_PROBE_RETRY_MS);
  }
  return { configured: false };
}

/** Validate a coverage response body's `rates` into the coverage array, or null
 * on any malformed shape. A malformed numeric field must not flow into the
 * silent-empty create-gate and fail it OPEN, so a bad body degrades to the
 * honest error state rather than reporting a false coverage. `unavailable` is
 * accepted when absent -- reading as available, the same direction the alarm
 * fails toward. */
function coverageRatesOf(body: unknown): Array<FieldValueCoverage> | null {
  if (!isRecord(body)) return null;
  const rates = body.rates;
  if (!Array.isArray(rates)) return null;
  const parsed: Array<FieldValueCoverage> = [];
  for (const entry of rates) {
    if (!isRecord(entry)) return null;
    const { output, input, total, produced, rate, unavailable } = entry;
    if (typeof output !== "string" || output.length === 0) return null;
    if (typeof input !== "string") return null;
    if (typeof total !== "number" || !Number.isFinite(total)) return null;
    if (typeof produced !== "number" || !Number.isFinite(produced)) return null;
    if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
    if (unavailable !== undefined && typeof unavailable !== "boolean")
      return null;
    parsed.push({
      output,
      input,
      total,
      produced,
      rate,
      unavailable: unavailable ?? false,
    });
  }
  return parsed;
}

/**
 * The outcome of a coverage sweep, split so the caller settles a deterministic
 * failure but holds a transient one:
 * - `rates`: a clean sweep.
 * - `unavailable`: a deterministic failure (a `4xx` other than `429`, or a malformed
 *   body) -- the same input will not succeed on retry, so the readout should settle.
 * - `transient`: a retryable failure (`429`, a `5xx`, or a network error) -- a later
 *   sweep may recover, so the readout should stay pending.
 * - `aborted`: the sweep was aborted through its signal (superseded or disposed).
 */
export type CoverageSweepOutcome =
  | { kind: "rates"; rates: Array<FieldValueCoverage> }
  | { kind: "unavailable" }
  | { kind: "transient" }
  | { kind: "aborted" };

/**
 * Sweep per-field coverage for a mounted file under `standardization`. Classifies the
 * response so the caller can tell a deterministic failure (settle the readout) from a
 * transient one (hold it pending) and from an abort (superseded). No error body rides
 * back: only the outcome kind.
 */
export async function postJobInputCoverage(
  reference: WorkInputReference,
  standardization: Standardization,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CoverageSweepOutcome> {
  try {
    const response = await fetchImpl("/api/jobs/inputs/coverage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: reference.name,
        standardization,
      }),
      signal,
    });
    if (response.ok) {
      const rates = coverageRatesOf(await readJsonOrNull(response));
      return rates === null
        ? { kind: "unavailable" }
        : { kind: "rates", rates };
    }
    if (response.status === 429 || response.status >= 500)
      return { kind: "transient" };
    return { kind: "unavailable" };
  } catch {
    // A signal abort and a genuine network failure both reject here. An abort is a
    // supersede (drop it); a network failure is retryable (hold pending).
    return signal.aborted ? { kind: "aborted" } : { kind: "transient" };
  }
}
