import type { JobInputListing, JobInputProfile } from "@jobs/workInputs";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";
import type { Standardization } from "@psilink/core";

/**
 * The browser-side client for the console appliance's work-input API
 * ({@link ../jobs/workInputs}): the operator-mounted directory listing, the
 * per-file streaming profile, and the per-field coverage sweep. Every call is a
 * same-origin fetch to a `gateJobRoute`-protected endpoint; off the console
 * appliance those endpoints answer 404, so a hosted build never reaches a
 * configured directory. Responses are validated defensively -- the appliance is
 * trusted, but a malformed body degrades to an honest error state rather than a
 * crash.
 */

/** A committed mounted file: the opaque name the coverage sweep and the job intent
 * carry. The CLI reads the file in place, so no size/mtime snapshot travels. */
export interface WorkInputReference {
  name: string;
}

/** The `GET /api/jobs/inputs` outcome: the listing, or an error (network / non-2xx
 * / malformed). */
export type JobInputsResult =
  { kind: "listing"; listing: JobInputListing } | { kind: "error" };

/** The `GET /api/jobs/inputs/profile` outcome: the profile, or unavailable (the
 * directory is unset, or the name resolves to no readable file). */
export type JobInputProfileResult =
  { kind: "profile"; profile: JobInputProfile } | { kind: "unavailable" };

/** The console's rendezvous configuration read off `GET /api/jobs/rendezvous`: the
 * mounted directory a filedrop exchange runs against. `configured: false` (the env
 * var is unset, or the request failed) leaves the filedrop transport unavailable;
 * `path` is the advisory locator the inviter mints into the invitation. */
export interface JobRendezvousConfig {
  configured: boolean;
  path?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const { configured, files } = body;
  if (typeof configured !== "boolean") return null;
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
  return { configured, files: parsed };
}

/** Validate a profile response body, returning null when any required field is
 * malformed. `columnSamples` is coerced to a `{ [column]: string[] }` map. */
function jobInputProfileOf(body: unknown): JobInputProfile | null {
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
  if (!isRecord(columnSamples)) return null;
  const samples: Record<string, Array<string>> = {};
  for (const [column, values] of Object.entries(columnSamples)) {
    if (!isStringArray(values)) return null;
    samples[column] = values;
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

/** List the operator-mounted input files. */
export async function fetchJobInputs(
  fetchImpl: typeof fetch = fetch,
): Promise<JobInputsResult> {
  try {
    const response = await fetchImpl("/api/jobs/inputs", { method: "GET" });
    if (!response.ok) return { kind: "error" };
    const body: unknown = await response.json();
    const listing = jobInputListingOf(body);
    return listing === null ? { kind: "error" } : { kind: "listing", listing };
  } catch {
    return { kind: "error" };
  }
}

/** Profile one mounted input file by its admissible name. */
export async function fetchJobInputProfile(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobInputProfileResult> {
  try {
    const response = await fetchImpl(
      `/api/jobs/inputs/profile?name=${encodeURIComponent(name)}`,
      { method: "GET" },
    );
    if (!response.ok) return { kind: "unavailable" };
    const body: unknown = await response.json();
    const profile = jobInputProfileOf(body);
    return profile === null
      ? { kind: "unavailable" }
      : { kind: "profile", profile };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Read the console's rendezvous configuration. Fail-safe toward "unavailable": a
 * non-2xx, a network error, or a malformed body resolves to `{ configured: false }`,
 * so the filedrop transport is offered only when the appliance confirms a mount. */
export async function fetchJobRendezvous(
  fetchImpl: typeof fetch = fetch,
): Promise<JobRendezvousConfig> {
  try {
    const response = await fetchImpl("/api/jobs/rendezvous", { method: "GET" });
    if (!response.ok) return { configured: false };
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.configured !== "boolean")
      return { configured: false };
    const path = body.path;
    if (!body.configured) return { configured: false };
    if (typeof path !== "string" || path.length === 0)
      return { configured: false };
    return { configured: true, path };
  } catch {
    return { configured: false };
  }
}

/** Validate a coverage response body's `rates` into the coverage array, or null on
 * any malformed shape. Every {@link FieldValueCoverage} field is checked: a
 * malformed numeric field that slipped through as `NaN`/`undefined` would flow into
 * the silent-empty create-gate and fail it OPEN for that field, so a bad body
 * degrades to the honest error state (the caller holds its pending "Checking..."
 * until the next edit supersedes it) rather than reporting a false coverage.
 * `unavailable` is accepted when absent -- an absent flag reads as "available", the
 * same direction the alarm fails toward. */
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
 * Sweep per-field coverage for a mounted file under `standardization`. Resolves the
 * coverage array on a clean sweep; resolves null on ANY non-2xx (a schema/not-found
 * response, or a transient server error) or a rejected fetch (offline, abort), so
 * the caller can treat it like a superseded response rather than surfacing a generic
 * error.
 */
export async function postJobInputCoverage(
  reference: WorkInputReference,
  standardization: Standardization,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<FieldValueCoverage> | null> {
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
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return coverageRatesOf(body);
  } catch {
    return null;
  }
}
