import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  ConnectionConfigSchema,
  HOST_KEY_FINGERPRINT_REGEX,
  parseSensitiveYaml,
} from "@psilink/core";

import { isBareSftpHost } from "@psi/sftpHost";

import { JOB_DATA_ROOT_ENV, JobApiConfigError } from "./gate";
import {
  materializeSftpCredential,
  removeSftpCredentialFile,
} from "./sftpScratch";
import { resolveJobRendezvousDir } from "./jobRendezvous";
import { resolveMountFile } from "./mountBrowse";

/**
 * The environment variable naming the operator-provisioned SFTP server file (a
 * YAML document of shape `server: <server block>`). Loaded once at server
 * startup, fail-closed: a malformed block refuses to boot rather than surfacing
 * per-request.
 */
export const JOB_SFTP_SERVER_ENV = "JOB_SFTP_SERVER";

/**
 * The superseded environment variable that named a MULTI-remote table
 * (`remotes: { <name>: <server block> }`). The console conducts one exchange
 * and is not a store of named connections, so the table collapsed to the single
 * {@link JOB_SFTP_SERVER_ENV} block. A deployment that still sets this refuses
 * to boot with a migration message rather than silently ignoring it -- a
 * silently ignored variable would leave an operator believing SFTP is
 * provisioned.
 */
export const LEGACY_JOB_SFTP_REMOTES_ENV = "JOB_SFTP_REMOTES";

/**
 * The operator-provisioned SFTP server: the connection block the server -- never
 * the client -- contributes to a composed sftp job config. Credential fields
 * (`password`, `privateKey`, `privateKeyPassphrase`) hold only `@path` file
 * references; the loader rejects inline values, so no secret byte ever lives in
 * server memory -- the reference is resolved by the CLI child at exchange time.
 * `hostKeyFingerprint` is mandatory: an appliance-driven SFTP connection always
 * pins the server host key.
 */
export interface JobSftpServerEntry {
  host: string;
  port?: number;
  username?: string;
  path?: string;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  keyboardInteractive?: boolean;
  hostKeyFingerprint: string | Array<string>;
}

/**
 * The strict allowlist of fields the server block may carry. Deliberately
 * STRICTER than core's SFTP server schema, which is non-strict and admits
 * blocks the appliance must never see: `provision` (whose auth block carries
 * inline HTTP credentials), the split `inbound_path`/`outbound_path` pair, and
 * the detected-but-rejected `certificate`/`known_hosts`. Any key outside this
 * list fails the boot with an error naming the key, so an operator cannot
 * smuggle -- or typo -- a field into the composed connection.
 */
const jobSftpServerEntrySchema: z.ZodType<JobSftpServerEntry> = z.strictObject({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
  username: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  keyboardInteractive: z.boolean().optional(),
  hostKeyFingerprint: z.union([
    z.string(),
    z
      .array(z.string())
      .min(1, "host_key_fingerprint must list at least one fingerprint"),
  ]),
});

/** The credential fields whose values must be `@path` file references. */
const CREDENTIAL_REF_FIELDS = [
  "password",
  "privateKey",
  "privateKeyPassphrase",
] as const;

/**
 * The operator-facing next step appended to a credential-exclusion rejection on
 * the AUTHORING path only. The base message already names which directory the
 * `@path` resolved under; this says why that directory is refused and points at
 * the two working fixes -- a separate secrets mount, or the paste fallback. Paste
 * is scoped to "a password or private key" so the one string stays truthful for
 * `privateKeyPassphrase`, which has no paste form. The boot loader passes no
 * remediation, so a deploy-time file editor's fail-closed startup message is
 * unchanged.
 */
const AUTHORING_CREDENTIAL_REMEDIATION =
  "That directory is writable during the exchange, so a credential file there " +
  "could be replaced. Set JOB_SECRETS_DIR to a separate mounted secrets " +
  "directory and reference the file there, or paste the value directly for a " +
  "password or private key.";

/** Which SFTP primary auth method a credential feeds. */
export type SftpCredType = "password" | "private_key";

/**
 * A file-reference credential given as a typed `@path` (never an inline value):
 * the escape hatch for a credential that lives outside any listable mount. Tagged
 * with which primary auth method it feeds.
 */
export interface AuthoredCredentialRef {
  kind: "ref";
  ref: string;
  credType: SftpCredType;
}

/**
 * A file-reference credential given as a locator the operator picked in the
 * secrets browser: the mount id and the path segments under it. The server -- not
 * the browser -- resolves it against `JOB_SECRETS_DIR` to an absolute `@path`, so
 * no container-absolute path ever transits the browser. Tagged with which primary
 * auth method it feeds.
 */
export interface AuthoredMountRefCredential {
  kind: "mountRef";
  mount: "secrets";
  subPath: Array<string>;
  credType: SftpCredType;
}

/**
 * A pasted credential value: the de-emphasized fallback for a credential that
 * exists nowhere on the appliance as a file. Under the single-party-appliance
 * trust model (a loopback-only browser on the operator's own machine) the value
 * crossing loopback is on-host, so this is acceptable -- but the server never
 * composes it as a value: it materializes it ONCE to a server-owned 0600 file at
 * the container-internal scratch path, rewrites it to an `@path`, and runs the
 * SAME containment chain the file-reference forms do. Tagged with which primary
 * auth method it feeds.
 */
export interface AuthoredRawCredential {
  kind: "raw";
  value: string;
  credType: SftpCredType;
}

/**
 * The credential an authoring request carries: a typed `@path` reference, a
 * secrets-mount locator, or a pasted value. All resolve to an `@path` reference
 * (the pasted value only after materialization to a server-owned file) validated
 * by the same containment chain the boot loader uses; no inline value ever
 * reaches a composed job file.
 */
export type AuthoredCredential =
  AuthoredCredentialRef | AuthoredMountRefCredential | AuthoredRawCredential;

/**
 * The `PUT /api/jobs/sftp` authoring body. It carries the same connection
 * material as a boot server block, but the credential arrives tagged -- a typed
 * `@path`, a secrets-mount locator, or a pasted value the server materializes to
 * a file -- rather than as a bare field, and the fingerprint is mandatory and
 * literal exactly as at boot. `private_key_passphrase` is always an `@path`
 * reference, never a pasted value.
 */
export interface AuthoredSftpServerRequest {
  host: string;
  port?: number;
  username?: string;
  path?: string;
  hostKeyFingerprint: string | Array<string>;
  credential: AuthoredCredential;
  privateKeyPassphrase?: string;
  keyboardInteractive?: boolean;
}

const credTypeSchema = z.enum(["password", "private_key"]);

const refCredentialSchema = z.strictObject({
  kind: z.literal("ref"),
  ref: z.string().min(1),
  credType: credTypeSchema,
});

// A single secrets mount only; a cross-mount locator is out of scope, so `mount`
// is the literal id and an unknown id fails the parse naming the field. Each
// subPath segment must be a non-empty string; resolveMountFile re-admits every
// segment's shape and re-confines the realpath to the mount.
const mountRefCredentialSchema = z.strictObject({
  kind: z.literal("mountRef"),
  mount: z.literal("secrets"),
  subPath: z.array(z.string().min(1)).min(1),
  credType: credTypeSchema,
});

// A pasted value. `value` is a non-empty string; a zod failure names the field
// shape (never the submitted value), so a malformed raw credential 400 does not
// echo the secret.
const rawCredentialSchema = z.strictObject({
  kind: z.literal("raw"),
  value: z.string().min(1),
  credType: credTypeSchema,
});

// The connection fields minus the credential. The credential is pulled aside and
// validated per-kind (ref vs mountRef) after a kind branch, so an unaccepted kind
// reaches a dedicated rejection rather than a generic union error.
const authoredConnectionFieldsSchema = z.strictObject({
  host: z.string().min(1),
  port: z.int().min(0).max(65535).optional(),
  username: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  hostKeyFingerprint: z.union([
    z.string(),
    z
      .array(z.string())
      .min(1, "host_key_fingerprint must list at least one fingerprint"),
  ]),
  privateKeyPassphrase: z.string().optional(),
  keyboardInteractive: z.boolean().optional(),
});

/**
 * Load and validate the SFTP server file at `filePath`. Every failure is a
 * {@link JobApiConfigError} whose message names the offending field path (never
 * a field value), fail-closed at startup. `dataRoot` is the job data root the
 * `@path` credential references are checked against: a reference resolving under
 * it would let a job's own workdir feed the next job's credentials. `rendezvousDir`,
 * when supplied, is excluded the same way -- a partner with sync write access to
 * the rendezvous mount could otherwise plant a credential file there.
 */
export function loadSftpServer(
  filePath: string,
  dataRoot: string,
  rendezvousDir?: string,
): JobSftpServerEntry {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "unreadable";
    throw new JobApiConfigError(
      `${JOB_SFTP_SERVER_ENV} names an sftp server file that cannot be read ` +
        `(${filePath}: ${code})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseSensitiveYaml(
      source,
      `the ${JOB_SFTP_SERVER_ENV} sftp server file`,
    );
  } catch (error) {
    throw new JobApiConfigError(
      error instanceof Error
        ? error.message
        : `the ${JOB_SFTP_SERVER_ENV} sftp server file could not be parsed`,
    );
  }

  const rawEntry = serverBlockOf(parsed);
  return validateServerEntry(
    rawEntry,
    credentialRefExclusions(dataRoot, rendezvousDir),
  );
}

/**
 * Read {@link JOB_SFTP_SERVER_ENV} and load the server block it names, or
 * undefined when it is unset. Setting it without {@link JOB_DATA_ROOT_ENV} is
 * itself a configuration error: the server block exists only for the job API,
 * which the data root enables, so a block on a disabled API is an operator
 * mistake to surface at boot, not silently ignore. The superseded multi-remote
 * variable {@link LEGACY_JOB_SFTP_REMOTES_ENV}, if set, refuses the boot with a
 * migration message rather than being ignored.
 */
export function loadSftpServerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JobSftpServerEntry | undefined {
  if ((env[LEGACY_JOB_SFTP_REMOTES_ENV] ?? "").trim().length > 0)
    throw new JobApiConfigError(
      `${LEGACY_JOB_SFTP_REMOTES_ENV} is no longer supported; the console ` +
        `provisions a single SFTP server. Set ${JOB_SFTP_SERVER_ENV} to a ` +
        "YAML file of shape `server: <server block>` (one server, the same " +
        "fields a table entry carried) instead.",
    );
  const serverPath = (env[JOB_SFTP_SERVER_ENV] ?? "").trim();
  if (serverPath.length === 0) return undefined;
  const dataRoot = (env[JOB_DATA_ROOT_ENV] ?? "").trim();
  if (dataRoot.length === 0)
    throw new JobApiConfigError(
      `${JOB_SFTP_SERVER_ENV} is set but ${JOB_DATA_ROOT_ENV} is not; the ` +
        "provisioned SFTP server serves only the job API, which the data " +
        "root enables. Set both or neither.",
    );
  return loadSftpServer(serverPath, dataRoot, resolveJobRendezvousDir(env));
}

/** Extract the top-level `server` block, rejecting any other document shape. */
function serverBlockOf(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new JobApiConfigError(
      "the sftp server file must be a YAML mapping with a single top-level " +
        "server key",
    );
  for (const key of Object.keys(parsed))
    if (key !== "server")
      throw new JobApiConfigError(
        `the sftp server file carries an unrecognized top-level key "${key}"; ` +
          "only server is accepted",
      );
  const server = (parsed as { server?: unknown }).server;
  if (server === null || server === undefined)
    throw new JobApiConfigError(
      "the sftp server file must define a top-level server block",
    );
  return server;
}

/**
 * A resolved directory a credential `@path` reference must stay OUTSIDE, paired
 * with the human label the rejection names.
 */
interface CredentialRefExclusion {
  dir: string;
  label: string;
}

/**
 * The directories a credential `@path` reference must not resolve under: the job
 * data root (client-written per job) and, when configured distinctly, the
 * rendezvous mount (partner-reachable through folder sync). Each is added both as
 * its lexical resolve and -- when it exists -- its realpath, so a symlinked
 * exclusion dir is caught too. Duplicates are dropped.
 */
function credentialRefExclusions(
  dataRoot: string,
  rendezvousDir: string | undefined,
): Array<CredentialRefExclusion> {
  const exclusions: Array<CredentialRefExclusion> = [];
  const seen = new Set<string>();
  const add = (dir: string, label: string): void => {
    for (const form of [dir, canonicalizeIfPresent(dir)]) {
      if (seen.has(form)) continue;
      seen.add(form);
      exclusions.push({ dir: form, label });
    }
  };
  add(path.resolve(dataRoot), "the job data root");
  if (rendezvousDir !== undefined)
    add(path.resolve(rendezvousDir), "the rendezvous directory");
  return exclusions;
}

/** Canonicalize `dir` to its realpath, or return it unchanged when it does not
 * yet exist (the data root is created lazily on the first job). */
function canonicalizeIfPresent(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Validate a raw SFTP server block into a {@link JobSftpServerEntry} against the
 * appliance's rules -- strict field allowlist, mandatory literal fingerprint,
 * credential-must-be-an-`@path`-outside-`exclusions`, core-schema compose. Shared
 * by the boot-time file loader and the request-sourced authoring path so the two
 * cannot diverge. An optional `credentialRemediation` is appended to a
 * credential-exclusion rejection: the authoring path supplies an operator next
 * step, the boot loader passes none so its startup message stays unchanged.
 */
function validateServerEntry(
  rawEntry: unknown,
  exclusions: Array<CredentialRefExclusion>,
  credentialRemediation?: string,
): JobSftpServerEntry {
  if (
    rawEntry === null ||
    typeof rawEntry !== "object" ||
    Array.isArray(rawEntry)
  )
    throw new JobApiConfigError("server must be a mapping of server fields");

  const camelized = camelizeEntryKeys(rawEntry as Record<string, unknown>);
  const result = jobSftpServerEntrySchema.safeParse(camelized);
  if (!result.success)
    throw new JobApiConfigError(formatIssues(result.error.issues));
  const entry = result.data;

  assertBareHost(entry.host);
  assertLiteralFingerprints(entry.hostKeyFingerprint);
  for (const field of CREDENTIAL_REF_FIELDS)
    assertCredentialRef(field, entry[field], exclusions, credentialRemediation);
  assertComposesThroughCoreSchema(entry);

  return entry;
}

/**
 * The outcome of validating a request-sourced authoring body: the resolved server
 * entry and, when the credential was a PASTED value, the server-owned scratch file
 * it was materialized to. The manager tracks that path to delete the file on
 * clear, delete, or a re-author that replaces it -- a pasted secret must not
 * outlive the connection it belongs to. Absent for a file-reference credential
 * (`ref`/`mountRef`), whose file is the operator's own and is never touched.
 */
export interface ValidatedAuthoredSftpServer {
  entry: JobSftpServerEntry;
  materializedCredentialPath?: string;
}

/**
 * Validate a request-sourced authoring body ({@link AuthoredSftpServerRequest})
 * into a {@link JobSftpServerEntry}, applying the SAME rules the boot loader does
 * -- the strict field allowlist, mandatory literal fingerprint,
 * credential-must-be-an-`@path`-outside the data root and rendezvous mount, and
 * core-schema compose -- by folding the resolved credential into a server block
 * and running it through {@link validateServerEntry}. The credential is a typed
 * `@path` reference, a secrets-mount locator resolved server-side against
 * `secretsDir`, or a pasted value materialized to a server-owned 0600 file under
 * `scratchDir`; all land as an `@path` that runs the same containment chain, so
 * even a materialized secret is confirmed outside the data root and rendezvous
 * mount on its realpath. A validation failure AFTER materialization deletes the
 * just-written file before it throws, so a rejected paste leaves nothing at rest.
 * Every failure is a {@link JobApiConfigError} whose message names a field path,
 * never a submitted value, a resolved path, or a secret.
 */
export function validateAuthoredSftpServer(
  rawBody: unknown,
  dataRoot: string,
  rendezvousDir: string | undefined,
  secretsDir?: string,
  scratchDir?: string,
): ValidatedAuthoredSftpServer {
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody))
    throw new JobApiConfigError(
      "connection must be a mapping of connection fields",
    );
  const { credential: rawCredential, ...rawConnection } = rawBody as Record<
    string,
    unknown
  >;

  const parsed = authoredConnectionFieldsSchema.safeParse(rawConnection);
  if (!parsed.success)
    throw new JobApiConfigError(
      formatIssues(parsed.error.issues, "connection"),
    );
  const body = parsed.data;

  const resolved = resolveAuthoredCredential(
    rawCredential,
    secretsDir,
    scratchDir,
  );
  const credentialField =
    resolved.credential.credType === "password" ? "password" : "privateKey";
  const rawEntry: Record<string, unknown> = {
    host: body.host,
    ...(body.port !== undefined ? { port: body.port } : {}),
    ...(body.username !== undefined ? { username: body.username } : {}),
    ...(body.path !== undefined ? { path: body.path } : {}),
    [credentialField]: resolved.credential.ref,
    ...(body.privateKeyPassphrase !== undefined
      ? { privateKeyPassphrase: body.privateKeyPassphrase }
      : {}),
    ...(body.keyboardInteractive !== undefined
      ? { keyboardInteractive: body.keyboardInteractive }
      : {}),
    hostKeyFingerprint: body.hostKeyFingerprint,
  };
  try {
    const entry = validateServerEntry(
      rawEntry,
      credentialRefExclusions(dataRoot, rendezvousDir),
      AUTHORING_CREDENTIAL_REMEDIATION,
    );
    return resolved.materializedPath !== undefined
      ? { entry, materializedCredentialPath: resolved.materializedPath }
      : { entry };
  } catch (error) {
    if (resolved.materializedPath !== undefined)
      removeSftpCredentialFile(resolved.materializedPath);
    throw error;
  }
}

/**
 * A credential resolved to an `@path` reference, paired with the server-owned
 * scratch file it was materialized to when (and only when) it arrived as a pasted
 * value. The path lets the caller delete the file if a later validation step
 * rejects the entry, and lets the manager delete it when the connection is
 * cleared or replaced.
 */
interface ResolvedAuthoredCredential {
  credential: AuthoredCredentialRef;
  materializedPath?: string;
}

/**
 * Resolve an authoring body's credential to an `@path` file reference, whichever
 * form it arrived in:
 * - `kind: "ref"` -- a typed `@path`, passed through verbatim (the escape hatch
 *   for a credential outside any listable mount).
 * - `kind: "mountRef"` -- a locator the operator picked in the secrets browser,
 *   resolved server-side against `secretsDir` and rewritten to `@<realpath>`.
 * - `kind: "raw"` -- a pasted value, materialized ONCE to a server-owned 0600 file
 *   under `scratchDir` and rewritten to `@<that file>`; the value is written and
 *   dropped, never returned, logged, or placed in argv/env.
 * The rewritten reference then runs the SAME `assertCredentialRef` containment the
 * typed form does (outside-data-root/rendezvous plus realpath re-confinement), so
 * a materialized secret is confined identically. Every failure names the credential
 * field only -- never a subPath value, a resolved absolute path, or a secret.
 */
function resolveAuthoredCredential(
  rawCredential: unknown,
  secretsDir: string | undefined,
  scratchDir: string | undefined,
): ResolvedAuthoredCredential {
  const kind =
    rawCredential !== null &&
    typeof rawCredential === "object" &&
    !Array.isArray(rawCredential)
      ? (rawCredential as { kind?: unknown }).kind
      : undefined;

  if (kind === "ref") {
    const parsed = refCredentialSchema.safeParse(rawCredential);
    if (!parsed.success)
      throw new JobApiConfigError(
        formatIssues(parsed.error.issues, "connection.credential"),
      );
    return { credential: parsed.data };
  }
  if (kind === "mountRef") {
    const parsed = mountRefCredentialSchema.safeParse(rawCredential);
    if (!parsed.success)
      throw new JobApiConfigError(
        formatIssues(parsed.error.issues, "connection.credential"),
      );
    return { credential: resolveMountRefCredential(parsed.data, secretsDir) };
  }
  if (kind === "raw") {
    const parsed = rawCredentialSchema.safeParse(rawCredential);
    if (!parsed.success)
      throw new JobApiConfigError(
        formatIssues(parsed.error.issues, "connection.credential"),
      );
    return materializeRawCredential(parsed.data, scratchDir);
  }
  throw new JobApiConfigError(
    'connection.credential.kind must be "ref", "mountRef", or "raw"',
  );
}

/**
 * Materialize a pasted credential to a server-owned 0600 file under the scratch
 * directory and rewrite it to an `@path`. The scratch directory is required: an
 * appliance without it (the API disabled, or boot setup skipped) refuses a paste
 * rather than composing an inline value. A write failure is swallowed into a
 * generic error carrying neither the value nor the path.
 */
function materializeRawCredential(
  credential: z.infer<typeof rawCredentialSchema>,
  scratchDir: string | undefined,
): ResolvedAuthoredCredential {
  if (scratchDir === undefined)
    throw new JobApiConfigError(
      "connection.credential is a pasted value, which this appliance is not " +
        "configured to accept",
    );
  let filePath: string;
  try {
    filePath = materializeSftpCredential(scratchDir, credential.value);
  } catch {
    throw new JobApiConfigError(
      "connection.credential could not be written to the appliance",
    );
  }
  return {
    credential: {
      kind: "ref",
      ref: `@${filePath}`,
      credType: credential.credType,
    },
    materializedPath: filePath,
  };
}

/**
 * Turn a secrets-mount locator into an `@path` reference: resolve `subPath` under
 * the configured secrets mount to a confined regular file's realpath (never
 * reading its bytes) and tag it with the credential's auth method. The mount is
 * server-side config (`JOB_SECRETS_DIR`) with no data-root fallback; an unset
 * mount, or a subPath naming no readable regular file (or escaping the mount), is
 * a {@link JobApiConfigError} naming the field only -- never a path.
 */
function resolveMountRefCredential(
  credential: AuthoredMountRefCredential,
  secretsDir: string | undefined,
): AuthoredCredentialRef {
  if (secretsDir === undefined)
    throw new JobApiConfigError(
      "connection.credential names the secrets mount, which is not " +
        "configured on this appliance",
    );
  const resolved = resolveMountFile(secretsDir, credential.subPath);
  if (resolved === null)
    throw new JobApiConfigError(
      "connection.credential.subPath does not name a readable file in the " +
        "secrets mount",
    );
  return {
    kind: "ref",
    ref: `@${resolved.absolutePath}`,
    credType: credential.credType,
  };
}

/**
 * Camelize the block's keys (`host_key_fingerprint` -> `hostKeyFingerprint`);
 * values are never touched. A pair of keys that collide after camelization is
 * rejected rather than letting one silently overwrite the other.
 */
function camelizeEntryKeys(
  rawEntry: Record<string, unknown>,
): Record<string, unknown> {
  const camelized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawEntry)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_match, char: string) =>
      char.toUpperCase(),
    );
    if (camelKey in camelized)
      throw new JobApiConfigError(
        `server sets the key "${camelKey}" twice (a snake_case and ` +
          "a camelCase spelling of the same field)",
      );
    camelized[camelKey] = value;
  }
  return camelized;
}

/** Format zod issues into one message of `<root>[.<path>]: <reason>`. The zod
 * messages are field-shape reasons, never a submitted value. */
function formatIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  root = "server",
): string {
  return issues
    .map((issue) => {
      const fieldPath = [root, ...issue.path.map(String)].join(".");
      return `${fieldPath}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * The host must be a bare server address: no userinfo (`@`), no scheme or path
 * (`/`, which also rules out `://`), and no ASCII whitespace. It backstops the
 * client form so a crafted request cannot smuggle a userinfo- or path-bearing
 * value into the partner-facing invitation endpoint, which mints the host
 * verbatim. Names the field only, never the submitted value.
 */
function assertBareHost(host: string): void {
  if (!isBareSftpHost(host))
    throw new JobApiConfigError(
      "server.host must be a bare server address, without a scheme, a path, " +
        "an @, or whitespace",
    );
}

/**
 * Every fingerprint entry must be a LITERAL in canonical OpenSSH SHA256 form.
 * An `@path` reference -- which the CLI's own loader would accept and resolve
 * -- is rejected here: the appliance pins host keys with values audited at
 * boot, not indirected through a file a later process resolves.
 */
function assertLiteralFingerprints(fingerprint: string | Array<string>): void {
  const entries = Array.isArray(fingerprint) ? fingerprint : [fingerprint];
  entries.forEach((entry, index) => {
    const fieldPath = Array.isArray(fingerprint)
      ? `server.hostKeyFingerprint.${index}`
      : "server.hostKeyFingerprint";
    if (entry.startsWith("@"))
      throw new JobApiConfigError(
        `${fieldPath} must be a literal fingerprint, not an @-file reference`,
      );
    if (!HOST_KEY_FINGERPRINT_REGEX.test(entry))
      throw new JobApiConfigError(
        `${fieldPath} must be an OpenSSH SHA256 host-key fingerprint ` +
          "(the SHA256: prefix followed by 43 standard base64 characters)",
      );
  });
}

/**
 * A credential field must be an `@path` reference to an ABSOLUTE path OUTSIDE
 * every {@link CredentialRefExclusion}, and the referenced file must exist at
 * validation time. Existence and canonicalization go through `realpathSync`
 * only -- the secret bytes are never read into the server; the CLI child resolves
 * the reference at exchange time. The exclusions (the client-written data root
 * and the partner-reachable rendezvous mount) close a laundering path: a
 * reference under one would let planted content become a transmitted credential.
 * The reference is checked BOTH lexically (so an absent file under an excluded
 * dir is still named as such) and by its realpath (so a symlink cannot resolve
 * out of an excluded dir undetected). Error messages name the field path only,
 * never the value; an optional `credentialRemediation` is threaded to the
 * exclusion rejection so the authoring path can append an operator next step.
 */
function assertCredentialRef(
  field: (typeof CREDENTIAL_REF_FIELDS)[number],
  value: string | undefined,
  exclusions: Array<CredentialRefExclusion>,
  credentialRemediation?: string,
): void {
  if (value === undefined) return;
  const fieldPath = `server.${field}`;
  if (!value.startsWith("@"))
    throw new JobApiConfigError(
      `${fieldPath} must be an @-file reference (@/absolute/path); an inline ` +
        "credential value is not accepted",
    );
  const refPath = value.slice(1);
  if (!path.isAbsolute(refPath))
    throw new JobApiConfigError(
      `${fieldPath} must reference an absolute path after the @`,
    );
  const resolvedRef = path.resolve(refPath);
  assertOutsideExclusions(
    fieldPath,
    resolvedRef,
    exclusions,
    credentialRemediation,
  );
  let realRef: string;
  try {
    realRef = fs.realpathSync(resolvedRef);
  } catch {
    throw new JobApiConfigError(
      `${fieldPath} references a file that does not exist`,
    );
  }
  assertOutsideExclusions(
    fieldPath,
    realRef,
    exclusions,
    credentialRemediation,
  );
}

/** Reject `candidate` when it is or is under any excluded directory (segment-aware
 * over resolved absolute paths, so a `..`-prefixed sibling is not confused as
 * inside). Names the offending directory's label, never the reference value; an
 * optional `credentialRemediation` is appended as an operator next step (the
 * authoring path supplies one, the boot path does not). */
function assertOutsideExclusions(
  fieldPath: string,
  candidate: string,
  exclusions: Array<CredentialRefExclusion>,
  credentialRemediation?: string,
): void {
  for (const { dir, label } of exclusions) {
    const relative = path.relative(dir, candidate);
    const outside =
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative);
    if (!outside)
      throw new JobApiConfigError(
        credentialRemediation === undefined
          ? `${fieldPath} must not reference a file under ${label}`
          : `${fieldPath} must not reference a file under ${label}. ` +
              credentialRemediation,
      );
  }
}

/**
 * Run the entry through core's connection schema as `{channel: "sftp", server}`
 * so core's cross-field refines (one primary auth method, passphrase requires
 * a key, keyboard-interactive requires a password, fingerprint canonical form)
 * hold at boot, not first at exchange time inside the CLI child.
 */
function assertComposesThroughCoreSchema(entry: JobSftpServerEntry): void {
  const composed = ConnectionConfigSchema.safeParse({
    channel: "sftp",
    server: entry,
  });
  if (!composed.success)
    throw new JobApiConfigError(formatIssues(composed.error.issues));
}
