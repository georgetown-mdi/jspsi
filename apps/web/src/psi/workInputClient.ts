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

/** A snapshot of a mounted file: the opaque name plus the client's profiled
 * `sizeBytes`/`modifiedAt`, used for the coverage/create freshness checks and the
 * authoring-time drift signal. */
export interface WorkInputReference {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** The `GET /api/jobs/inputs` outcome: the listing, a busy gate (429, the
 * one-at-a-time parse gate is full), or an error (network / non-2xx / malformed). */
export type JobInputsResult =
  | { kind: "listing"; listing: JobInputListing }
  | { kind: "busy" }
  | { kind: "error" };

/** The `GET /api/jobs/inputs/profile` outcome: the profile, a busy gate (429), or
 * unavailable (the directory is unset, or the name is unknown/unreadable/gone --
 * all empty-bodied 4xx that never echo the name). */
export type JobInputProfileResult =
  | { kind: "profile"; profile: JobInputProfile }
  | { kind: "busy" }
  | { kind: "unavailable" };

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
  const { configured, totalEntries, truncated, files } = body;
  if (typeof configured !== "boolean") return null;
  if (typeof totalEntries !== "number" || !Number.isInteger(totalEntries))
    return null;
  if (typeof truncated !== "boolean") return null;
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
  return { configured, totalEntries, truncated, files: parsed };
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
    if (response.status === 429) return { kind: "busy" };
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
    if (response.status === 429) return { kind: "busy" };
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

/** Validate a coverage response body's `rates` into the coverage array, or null on
 * any malformed shape. */
function coverageRatesOf(body: unknown): Array<FieldValueCoverage> | null {
  if (!isRecord(body)) return null;
  const rates = body.rates;
  if (!Array.isArray(rates)) return null;
  for (const entry of rates) {
    if (!isRecord(entry) || typeof entry.output !== "string") return null;
  }
  return rates as Array<FieldValueCoverage>;
}

/**
 * Sweep per-field coverage for a mounted file under `standardization`, carrying the
 * client's profiled freshness pair so the appliance refuses a drifted file. Resolves
 * the coverage array on a clean sweep; resolves null on ANY non-2xx (429 busy, a
 * drift/schema 400, or a transient server error) so the caller can treat it like a
 * superseded response rather than surfacing a generic error.
 */
export async function postJobInputCoverage(
  reference: WorkInputReference,
  standardization: Standardization,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<FieldValueCoverage> | null> {
  const response = await fetchImpl("/api/jobs/inputs/coverage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: reference.name,
      sizeBytes: reference.sizeBytes,
      modifiedAt: reference.modifiedAt,
      standardization,
    }),
    signal,
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return coverageRatesOf(body);
}
