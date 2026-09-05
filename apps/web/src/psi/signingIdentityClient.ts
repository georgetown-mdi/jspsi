import { FINGERPRINT_REGEX } from "@psilink/core";

import { isRecord, readJsonOrNull } from "./jobApiBody";

/**
 * The browser-side client for the console's signing-identity surface
 * (`POST /api/jobs/signing/fingerprint`). One same-origin fetch to a
 * `gateJobRoute`-protected endpoint; off the console it answers 404, so
 * a hosted build never reaches it.
 *
 * The response is validated defensively -- the console is trusted, but a
 * malformed body degrades to an accurate error state rather than filling a
 * shareable fingerprint with a bad value.
 */

/**
 * The outcome of a create-or-reuse fingerprint request:
 * - `ok`: the identity exists and its fingerprint was read (re-checked
 *   client-side, defense in depth over the server check). `created` says whether
 *   this call minted it, so the card can distinguish "here is your fingerprint"
 *   from "your signing identity was just created". The file names are the mount's,
 *   for copy that tells the operator what to look for and what to send.
 * - `refused`: the console's own `fingerprint` run refused the request (the
 *   CLI's exit 64). Every cause reachable through this endpoint lives in the
 *   operator's mounted folder and none is distinguishable from the console
 *   (`SigningFingerprintResult` states which and why), so it is named apart from a
 *   generic error to hold copy that points at that folder.
 * - `invalid`: a `400` -- the label was malformed; `message` is the server's
 *   field-path-only reason, safe to show.
 * - `busy`: a `409` -- a request is already running; the operator can retry.
 * - `timeout`: the console's own budget was exceeded.
 * - `disabled`: a `404` -- the job API is off (a hosted build).
 * - `error`: another non-2xx, a network fault, or a malformed body.
 */
export type SigningFingerprintOutcome =
  | {
      kind: "ok";
      fingerprint: string;
      created: boolean;
      identityFileName: string;
      certificateFileName?: string;
    }
  | { kind: "refused" }
  | { kind: "invalid"; message: string }
  | { kind: "busy" }
  | { kind: "timeout" }
  | { kind: "disabled" }
  | { kind: "error" };

/** Read the fingerprint body defensively: re-check the digest against the
 * canonical regex client-side, and require the file names to be non-empty single
 * segments -- they are rendered as names the operator goes looking for, so a
 * separator-bearing value is a malformed body rather than something to show. */
function fingerprintOutcomeOf(body: unknown): SigningFingerprintOutcome {
  if (!isRecord(body)) return { kind: "error" };
  const { status } = body;
  if (status === "refused") return { kind: "refused" };
  if (status === "timeout") return { kind: "timeout" };
  if (status !== "ok") return { kind: "error" };
  const { fingerprint, created, identityFileName, certificateFileName } = body;
  if (typeof fingerprint !== "string" || !FINGERPRINT_REGEX.test(fingerprint))
    return { kind: "error" };
  if (typeof created !== "boolean") return { kind: "error" };
  if (!isPlainFileName(identityFileName)) return { kind: "error" };
  if (
    certificateFileName !== undefined &&
    !isPlainFileName(certificateFileName)
  )
    return { kind: "error" };
  return {
    kind: "ok",
    fingerprint,
    created,
    identityFileName,
    ...(certificateFileName !== undefined ? { certificateFileName } : {}),
  };
}

/** Whether a value is a bare file name: a non-empty single segment containing no
 * separator and no `..`, so what is rendered names a file in one directory rather
 * than describing a location. */
function isPlainFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}

/** Read the field-path-only message off a `400` body, or a fixed fallback. The
 * message is generated from field paths and fixed reasons (never a value), so it
 * is safe to display. */
function validationMessage(body: unknown): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.length > 0)
    return body.error;
  return "Your identity could not be read. Check it and try again.";
}

/**
 * Create-or-reuse this party's signing identity on the console and read its
 * fingerprint, through `POST /api/jobs/signing/fingerprint`. Sends only the
 * operator's identity label and the export toggle.
 *
 * There is no regenerate call, here or on the server: re-keying invalidates every
 * fingerprint a partner has pinned, so it stays a command-line action.
 */
export async function resolveSigningFingerprint(
  identity: string,
  exportCertificate = false,
  fetchImpl: typeof fetch = fetch,
): Promise<SigningFingerprintOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/api/jobs/signing/fingerprint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        exportCertificate ? { identity, exportCertificate } : { identity },
      ),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 404) return { kind: "disabled" };
  if (response.status === 409) return { kind: "busy" };
  if (response.status === 400)
    return {
      kind: "invalid",
      message: validationMessage(await readJsonOrNull(response)),
    };
  if (!response.ok) return { kind: "error" };
  return fingerprintOutcomeOf(await readJsonOrNull(response));
}
