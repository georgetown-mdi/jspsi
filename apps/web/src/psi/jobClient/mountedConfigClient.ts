import {
  MAX_JOB_LISTING_RESPONSE_BYTES,
  MAX_JOB_STATUS_RESPONSE_BYTES,
  isRecord,
  readBoundedJson,
  readJsonOrNull,
} from "./jobApiBody";

import type { DisclosedExchangeDocument } from "@jobs/configLoad";

/**
 * The browser's read of `GET /api/jobs/config`: the command-line configuration
 * the operator mounted, as the settings the console's authoring forms edit
 * (docs/spec/SERVER_JOB_API.md, "Loading a configuration from the mount").
 *
 * The console's own route decides every field of the answer; this narrows the
 * body before the authoring state is read off it, so a proxy's page or a console
 * at another version reaches the load control as "could not be read" rather than
 * as a document with fields missing.
 */

/** What one read of the mounted configuration answers. */
export type MountedConfigurationAnswer =
  /** The mount holds no configuration -- the ordinary first run. */
  | { kind: "absent" }
  /** The configuration, with the settings the console holds without an editor
   * and the credential fields it cannot pre-fill, both named as the file spells
   * them. */
  | {
      kind: "opened";
      document: DisclosedExchangeDocument;
      carriedThrough: Array<string>;
      warnings: Array<string>;
    }
  /** The console refused the file, in its own words: the route's text names the
   * settings to fix as the file spells them. */
  | { kind: "refused"; error: string }
  /** The read itself did not answer -- a network fault, a non-2xx that is not a
   * refusal, or a body this could not narrow. */
  | { kind: "unavailable" };

/** The refusal text a 400 carries, or the console's own wording when the body
 * held none: the operator is told the load stopped either way. */
const UNNAMED_REFUSAL =
  "The psilink.yaml in your working folder could not be opened. Check the " +
  "file, then open it again.";

/** A list of setting names off a body field, or null for anything else: both
 * lists reach the operator as copy, so a non-string entry is a body this cannot
 * read rather than one rendered as `[object Object]`. */
function namesOf(value: unknown): Array<string> | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string") ? value : null;
}

/** The disclosed document off a body, or null when it is not one this console
 * can read into authoring state. Checks the fields the mapping requires and
 * takes the rest as the route composed them: the answer is this console's own
 * route, narrowed here against a body that is not it. */
function documentOf(value: unknown): DisclosedExchangeDocument | null {
  if (!isRecord(value)) return null;
  if (
    value.channel !== "sftp" &&
    value.channel !== "filedrop" &&
    value.channel !== "webrtc"
  )
    return null;
  if (!isRecord(value.linkageTerms)) return null;
  return value as unknown as DisclosedExchangeDocument;
}

/**
 * Read the configuration mounted beside the console's working directory.
 *
 * Fails toward `unavailable`, which the load control renders as an offer the
 * operator can try again: nothing here pre-fills a form from a body it could not
 * narrow, so a half-read answer cannot reach the authoring steps.
 */
export async function fetchMountedConfiguration(
  fetchImpl: typeof fetch = fetch,
): Promise<MountedConfigurationAnswer> {
  try {
    const response = await fetchImpl("/api/jobs/config", { method: "GET" });
    if (response.status === 400) {
      const body: unknown = await readJsonOrNull(
        response,
        MAX_JOB_STATUS_RESPONSE_BYTES,
      );
      const error = isRecord(body) ? body.error : undefined;
      return {
        kind: "refused",
        error:
          typeof error === "string" && error.length > 0
            ? error
            : UNNAMED_REFUSAL,
      };
    }
    if (!response.ok) return { kind: "unavailable" };
    const body: unknown = await readBoundedJson(
      response,
      MAX_JOB_LISTING_RESPONSE_BYTES,
    );
    if (!isRecord(body) || typeof body.present !== "boolean")
      return { kind: "unavailable" };
    if (!body.present) return { kind: "absent" };
    const document = documentOf(body.document);
    const carriedThrough = namesOf(body.carriedThrough);
    const warnings = namesOf(body.warnings);
    if (document === null || carriedThrough === null || warnings === null)
      return { kind: "unavailable" };
    return { kind: "opened", document, carriedThrough, warnings };
  } catch {
    return { kind: "unavailable" };
  }
}
