import { HOST_KEY_FINGERPRINT_REGEX } from "@psilink/core";

import type { AuthoredSftpConnectionRequest } from "@psi/sftpAuthoringClient";

/**
 * The pure model behind the console's SFTP connection authoring form: the field
 * set, its validation (a required host and username, an optional port, a required
 * literal host-key fingerprint, and exactly one credential source), the
 * pasted-`sftp://`-URL split, and the single derivation that turns valid fields
 * into the `PUT /api/jobs/sftp` body. No React, no I/O -- the tested boundary for
 * "the form only submits a valid authoring request".
 *
 * The credential is a FILE by default -- one the operator picked from the secrets
 * mount (a locator the server resolves) or a typed `@path` reference -- with a
 * de-emphasized fallback to paste the value, which the server materializes to a
 * file on the appliance. The optional passphrase is always an `@path`, never a
 * pasted value.
 */

/** Which primary auth method the credential feeds; the radio enforces at-most-one
 * primary at the control level. */
export type SftpCredentialMethod = "password" | "private_key";

/**
 * Where the primary credential comes from:
 * - `mount`: a file the operator picked in the secrets browser (its path segments
 *   under the mount; the server resolves them to an absolute path).
 * - `path`: a typed `@path` for a credential outside any listable mount.
 * - `raw`: a pasted value (the de-emphasized fallback); the server materializes it
 *   to a file on the appliance. It is held in component state only, never
 *   persisted to browser storage or the query cache.
 */
export type SftpCredentialSource =
  | { kind: "mount"; subPath: Array<string> }
  | { kind: "path"; ref: string }
  | { kind: "raw"; value: string };

/** The authoring form's field values. */
export interface SftpConnectionFormValues {
  host: string;
  username: string;
  remoteDirectory: string;
  port: string;
  hostKeyFingerprint: string;
  method: SftpCredentialMethod;
  /** The chosen primary credential file, or undefined until one is picked/typed. */
  source: SftpCredentialSource | undefined;
  /** A typed `@path` to the private key's passphrase file (private_key only,
   * optional); it is also a file reference, never a pasted secret. */
  passphrasePath: string;
}

/** The form's initial state, before the operator authors anything. */
export const EMPTY_SFTP_FORM: SftpConnectionFormValues = {
  host: "",
  username: "",
  remoteDirectory: "",
  port: "",
  hostKeyFingerprint: "",
  method: "password",
  source: undefined,
  passphrasePath: "",
};

/** A partner-supplied SFTP locator: the credential-free host/port/path an accepted
 * invitation's endpoint carries. It names WHERE to connect and nothing else -- an
 * {@link SFTPEndpoint} structurally cannot carry a credential or a host-key
 * fingerprint. */
export interface SftpEndpointLocator {
  host: string;
  port?: number;
  path?: string;
}

/**
 * Seed the authoring form from a partner-supplied SFTP locator (an accepted
 * invitation's endpoint). ONLY the host, port, and remote directory pre-fill; the
 * fingerprint, credential, method, and passphrase stay EMPTY -- the operator
 * supplies every one of those. This is the accept-side pre-fill boundary: no
 * invitation field can populate a credential or the host-key fingerprint, because
 * the locator carries neither and this reads only its host/port/path. A form built
 * from this alone is unsubmittable ({@link buildAuthoringRequest} returns undefined)
 * until the operator adds the fingerprint and a credential.
 */
export function sftpFormFromLocator(
  locator: SftpEndpointLocator,
): SftpConnectionFormValues {
  return {
    ...EMPTY_SFTP_FORM,
    host: locator.host,
    port: locator.port !== undefined ? String(locator.port) : "",
    remoteDirectory: locator.path ?? "",
  };
}

/** The form fields an error can attach to. */
export type SftpFormField =
  | "host"
  | "username"
  | "port"
  | "hostKeyFingerprint"
  | "credential"
  | "passphrase";

/** One blocking error on the form: the field and the message. */
export interface SftpFormError {
  field: SftpFormField;
  message: string;
}

// The shape of a signing partner_fingerprint (43 base64url characters, no
// prefix): a UX heuristic used only to name the "you pasted a signing
// fingerprint" confusion. It is NOT the security control -- the authoritative
// host-key format check is HOST_KEY_FINGERPRINT_REGEX (imported from core, so it
// cannot drift), re-run server-side on every PUT.
const SIGNING_FINGERPRINT_SHAPE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * A savable host is a bare server address: no userinfo (`@`), no scheme or path
 * (`/`, which also rules out `://`), and no ASCII whitespace. A value carrying any
 * of these is a URL fragment or login string and must never be minted verbatim
 * into the partner-facing invitation endpoint; the server re-checks the same set.
 * A bare hostname, an IPv4, and a bracketed IPv6 literal carry none of them.
 */
const HOST_DISALLOWED_CHAR = /[@/\t\n\v\f\r ]/;

/** The connection fields a pasted `sftp://user@host:port/path` URL carries. */
export interface ParsedSftpUrl {
  host: string;
  username?: string;
  port?: number;
  path?: string;
}

/** Parse an `sftp://user@host:port/path` URL into its connection fields, or null
 * when the input is not a parseable sftp URL (so the caller keeps the raw text). */
export function parseSftpUrl(input: string): ParsedSftpUrl | null {
  const trimmed = input.trim();
  if (!/^sftp:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  const port = url.port === "" ? undefined : Number(url.port);
  const path =
    url.pathname === "" || url.pathname === "/" ? undefined : url.pathname;
  return {
    host: url.hostname,
    ...(url.username !== ""
      ? { username: decodeURIComponent(url.username) }
      : {}),
    ...(port !== undefined ? { port } : {}),
    ...(path !== undefined ? { path } : {}),
  };
}

/** Apply a host-field input: when it is a full `sftp://` URL, split it across the
 * host, username, port, and remote-directory fields; otherwise set the raw text as
 * the host so the operator can keep typing. */
export function applyHostInput(
  values: SftpConnectionFormValues,
  raw: string,
): SftpConnectionFormValues {
  const parsed = parseSftpUrl(raw);
  if (parsed === null) return { ...values, host: raw };
  return {
    ...values,
    host: parsed.host,
    ...(parsed.username !== undefined ? { username: parsed.username } : {}),
    port: parsed.port !== undefined ? String(parsed.port) : values.port,
    remoteDirectory: parsed.path ?? values.remoteDirectory,
  };
}

/** Whether a typed credential/passphrase reference is an `@`-prefixed path. */
function isAtPath(value: string): boolean {
  return value.startsWith("@") && value.length > 1;
}

/**
 * The first blocking error on the form, or undefined when the fields are savable.
 * Host, username, a literal fingerprint, and a credential source are required; the
 * port is optional but bounded; a typed credential/passphrase must be an `@path`.
 * The fingerprint is validated against core's `HOST_KEY_FINGERPRINT_REGEX`, and a
 * value shaped like a signing fingerprint gets the confusion message.
 */
export function sftpFormError(
  values: SftpConnectionFormValues,
): SftpFormError | undefined {
  if (values.host.trim() === "")
    return { field: "host", message: "Enter the SFTP server address." };
  if (HOST_DISALLOWED_CHAR.test(values.host.trim()))
    return {
      field: "host",
      message:
        "Enter just the server address (like sftp.example.org) -- not a " +
        "full URL or login details.",
    };
  if (values.username.trim() === "")
    return {
      field: "username",
      message: "Enter the username for the SFTP account.",
    };
  const port = values.port.trim();
  if (port !== "") {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535)
      return {
        field: "port",
        message: "Enter a port number between 0 and 65535.",
      };
  }
  const fingerprintError = fingerprintErrorFor(values.hostKeyFingerprint);
  if (fingerprintError !== undefined)
    return { field: "hostKeyFingerprint", message: fingerprintError };

  const source = values.source;
  if (source === undefined)
    return {
      field: "credential",
      message:
        "Choose the credential file, type a file reference, or paste " +
        "the value.",
    };
  if (source.kind === "mount" && source.subPath.length === 0)
    return {
      field: "credential",
      message:
        "Choose the credential file, type a file reference, or paste " +
        "the value.",
    };
  if (source.kind === "path" && !isAtPath(source.ref.trim()))
    return {
      field: "credential",
      message:
        "Enter the credential as an @-file reference to an absolute path, " +
        "e.g. @/run/secrets/key.",
    };
  // A pasted value must be non-empty; whitespace is significant in a secret, so
  // it is not trimmed. An opened paste with an empty value is a raw source with an
  // empty string (not an absent source), so this dedicated message is reachable
  // and renders at the paste field.
  if (source.kind === "raw" && source.value === "")
    return {
      field: "credential",
      message: "Enter the pasted credential value, or choose a file instead.",
    };

  if (values.method === "private_key" && values.passphrasePath.trim() !== "") {
    if (!isAtPath(values.passphrasePath.trim()))
      return {
        field: "passphrase",
        message:
          "Enter the passphrase as an @-file reference, e.g. " +
          "@/run/secrets/key.pass.",
      };
  }
  return undefined;
}

/** The fingerprint field's error message, or undefined when it is a valid literal
 * OpenSSH SHA256 host-key fingerprint. */
function fingerprintErrorFor(value: string): string | undefined {
  const fingerprint = value.trim();
  if (fingerprint === "") return "Enter the server's identity fingerprint.";
  if (HOST_KEY_FINGERPRINT_REGEX.test(fingerprint)) return undefined;
  if (SIGNING_FINGERPRINT_SHAPE.test(fingerprint))
    return (
      "This looks like a signing fingerprint (43 characters, no prefix), not " +
      "the server's identity fingerprint. A server identity fingerprint starts " +
      "with SHA256: -- ask whoever runs the SFTP server for it."
    );
  return (
    "Enter the server's identity fingerprint in SHA256: form (SHA256: " +
    "followed by 43 characters)."
  );
}

/**
 * Build the `PUT /api/jobs/sftp` body from valid form values, or undefined when
 * the form still has a blocking error (so the caller never submits an invalid
 * request). The credential is a secrets-mount locator, a typed `@path`, or a
 * pasted value (`kind: "raw"`), the last of which the server materializes to a
 * file. A pasted value is sent verbatim (whitespace is significant in a secret),
 * never trimmed.
 */
export function buildAuthoringRequest(
  values: SftpConnectionFormValues,
): AuthoredSftpConnectionRequest | undefined {
  if (sftpFormError(values) !== undefined) return undefined;
  const source = values.source;
  // sftpFormError guarantees a defined source; narrow for the type system.
  if (source === undefined) return undefined;
  const port = values.port.trim();
  const remoteDirectory = values.remoteDirectory.trim();
  const passphrase = values.passphrasePath.trim();
  return {
    host: values.host.trim(),
    ...(port !== "" ? { port: Number(port) } : {}),
    username: values.username.trim(),
    ...(remoteDirectory !== "" ? { path: remoteDirectory } : {}),
    hostKeyFingerprint: values.hostKeyFingerprint.trim(),
    credential:
      source.kind === "mount"
        ? {
            kind: "mountRef",
            mount: "secrets",
            subPath: source.subPath,
            credType: values.method,
          }
        : source.kind === "path"
          ? { kind: "ref", ref: source.ref.trim(), credType: values.method }
          : { kind: "raw", value: source.value, credType: values.method },
    ...(values.method === "private_key" && passphrase !== ""
      ? { privateKeyPassphrase: passphrase }
      : {}),
  };
}
