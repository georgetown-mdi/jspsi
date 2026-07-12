import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  ConnectionConfigSchema,
  HOST_KEY_FINGERPRINT_REGEX,
  parseSensitiveYaml,
} from "@psilink/core";

import { JOB_DATA_ROOT_ENV, JobApiConfigError } from "./gate";

/**
 * The environment variable naming the operator-provisioned SFTP remotes file (a
 * YAML document of shape `remotes: { <name>: <server block> }`). Loaded once at
 * server startup, fail-closed: a malformed table refuses to boot rather than
 * surfacing per-request.
 */
export const JOB_SFTP_REMOTES_ENV = "JOB_SFTP_REMOTES";

/**
 * The shape a remote NAME must have: 1-64 characters of `[A-Za-z0-9_-]`,
 * starting alphanumeric. Names are opaque handles a client selects by exact
 * string equality; the charset keeps them display-safe and unambiguous, and the
 * same regex gates the intent's `remote` field so a name that cannot exist in a
 * table is rejected before any lookup.
 */
export const SFTP_REMOTE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * One operator-provisioned SFTP remote: the connection block the server -- never
 * the client -- contributes to a composed sftp job config. Credential fields
 * (`password`, `privateKey`, `privateKeyPassphrase`) hold only `@path` file
 * references; the loader rejects inline values, so no secret byte ever lives in
 * server memory -- the reference is resolved by the CLI child at exchange time.
 * `hostKeyFingerprint` is mandatory: an appliance-driven SFTP connection always
 * pins the server host key.
 */
export interface JobSftpRemoteEntry {
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
 * The operator-provisioned remotes table, keyed by the VERBATIM name from the
 * file. Names are never case-folded or camelized -- `prod_east` and `prodEast`
 * are distinct keys -- so the exact-string `Map.get` lookup is the whole
 * resolution semantics.
 */
export type JobSftpRemotesTable = Map<string, JobSftpRemoteEntry>;

/**
 * The strict allowlist of fields a remote entry may carry. Deliberately
 * STRICTER than core's SFTP server schema, which is non-strict and admits
 * blocks the appliance must never see: `provision` (whose auth block carries
 * inline HTTP credentials), the split `inbound_path`/`outbound_path` pair, and
 * the detected-but-rejected `certificate`/`known_hosts`. Any key outside this
 * list fails the boot with an error naming the key, so an operator cannot
 * smuggle -- or typo -- a field into the composed connection.
 */
const jobSftpRemoteEntrySchema: z.ZodType<JobSftpRemoteEntry> = z.strictObject({
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
 * Load and validate the remotes file at `filePath`. Every failure is a
 * {@link JobApiConfigError} whose message names the offending field path (never
 * a field value), matching the fail-closed startup posture of
 * `assertJobApiStartupSafe`. `dataRoot` is the job data root the `@path`
 * credential references are checked against: a reference resolving under it
 * would let a job's own workdir feed the next job's credentials.
 */
export function loadSftpRemotesTable(
  filePath: string,
  dataRoot: string,
): JobSftpRemotesTable {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "unreadable";
    throw new JobApiConfigError(
      `${JOB_SFTP_REMOTES_ENV} names a remotes file that cannot be read ` +
        `(${filePath}: ${code})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseSensitiveYaml(
      source,
      `the ${JOB_SFTP_REMOTES_ENV} remotes file`,
    );
  } catch (error) {
    throw new JobApiConfigError(
      error instanceof Error
        ? error.message
        : `the ${JOB_SFTP_REMOTES_ENV} remotes file could not be parsed`,
    );
  }

  const remotesRaw = remotesMappingOf(parsed);
  const resolvedDataRoot = path.resolve(dataRoot);
  const table: JobSftpRemotesTable = new Map();

  for (const [name, rawEntry] of Object.entries(remotesRaw)) {
    if (!SFTP_REMOTE_NAME_REGEX.test(name))
      throw new JobApiConfigError(
        `remotes: the remote name "${name}" must be 1-64 characters of ` +
          "[A-Za-z0-9_-] starting with an alphanumeric",
      );
    const entry = validateRemoteEntry(name, rawEntry, resolvedDataRoot);
    table.set(name, entry);
  }

  return table;
}

/**
 * Read {@link JOB_SFTP_REMOTES_ENV} and load the table it names, or undefined
 * when it is unset. Setting it without {@link JOB_DATA_ROOT_ENV} is itself a
 * configuration error: the remotes table exists only for the job API, which the
 * data root enables, so a table on a disabled API is an operator mistake to
 * surface at boot, not silently ignore.
 */
export function loadSftpRemotesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JobSftpRemotesTable | undefined {
  const remotesPath = (env[JOB_SFTP_REMOTES_ENV] ?? "").trim();
  if (remotesPath.length === 0) return undefined;
  const dataRoot = (env[JOB_DATA_ROOT_ENV] ?? "").trim();
  if (dataRoot.length === 0)
    throw new JobApiConfigError(
      `${JOB_SFTP_REMOTES_ENV} is set but ${JOB_DATA_ROOT_ENV} is not; the ` +
        "SFTP remotes table serves only the job API, which the data root " +
        "enables. Set both or neither.",
    );
  return loadSftpRemotesTable(remotesPath, dataRoot);
}

/** Extract the top-level `remotes` mapping, rejecting any other document shape. */
function remotesMappingOf(parsed: unknown): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new JobApiConfigError(
      "the remotes file must be a YAML mapping with a single top-level " +
        "remotes key",
    );
  for (const key of Object.keys(parsed))
    if (key !== "remotes")
      throw new JobApiConfigError(
        `the remotes file carries an unrecognized top-level key "${key}"; ` +
          "only remotes is accepted",
      );
  const remotes = (parsed as { remotes?: unknown }).remotes;
  if (remotes === null || remotes === undefined)
    throw new JobApiConfigError(
      "the remotes file must define a top-level remotes mapping",
    );
  if (typeof remotes !== "object" || Array.isArray(remotes))
    throw new JobApiConfigError(
      "remotes must be a mapping of remote name to server block",
    );
  return remotes as Record<string, unknown>;
}

/** Validate one raw entry into a {@link JobSftpRemoteEntry}. */
function validateRemoteEntry(
  name: string,
  rawEntry: unknown,
  resolvedDataRoot: string,
): JobSftpRemoteEntry {
  if (
    rawEntry === null ||
    typeof rawEntry !== "object" ||
    Array.isArray(rawEntry)
  )
    throw new JobApiConfigError(
      `remotes.${name} must be a mapping of server fields`,
    );

  const camelized = camelizeEntryKeys(
    name,
    rawEntry as Record<string, unknown>,
  );
  const result = jobSftpRemoteEntrySchema.safeParse(camelized);
  if (!result.success)
    throw new JobApiConfigError(formatIssues(name, result.error.issues));
  const entry = result.data;

  assertLiteralFingerprints(name, entry.hostKeyFingerprint);
  for (const field of CREDENTIAL_REF_FIELDS)
    assertCredentialRef(name, field, entry[field], resolvedDataRoot);
  assertComposesThroughCoreSchema(name, entry);

  return entry;
}

/**
 * Camelize an entry's OWN keys (`host_key_fingerprint` ->
 * `hostKeyFingerprint`); values are never touched, and the entry NAMES one
 * level up are never camelized (a snake_case name must not alias a camelCase
 * one). A pair of keys that collide after camelization is rejected rather than
 * letting one silently overwrite the other.
 */
function camelizeEntryKeys(
  name: string,
  rawEntry: Record<string, unknown>,
): Record<string, unknown> {
  const camelized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawEntry)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_match, char: string) =>
      char.toUpperCase(),
    );
    if (camelKey in camelized)
      throw new JobApiConfigError(
        `remotes.${name} sets the key "${camelKey}" twice (a snake_case and ` +
          "a camelCase spelling of the same field)",
      );
    camelized[camelKey] = value;
  }
  return camelized;
}

/** Format zod issues into one message of `remotes.<name>[.<path>]: <reason>`. */
function formatIssues(
  name: string,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  return issues
    .map((issue) => {
      const fieldPath = ["remotes", name, ...issue.path.map(String)].join(".");
      return `${fieldPath}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Every fingerprint entry must be a LITERAL in canonical OpenSSH SHA256 form.
 * An `@path` reference -- which the CLI's own loader would accept and resolve
 * -- is rejected here: the appliance pins host keys with values audited at
 * boot, not indirected through a file a later process resolves.
 */
function assertLiteralFingerprints(
  name: string,
  fingerprint: string | Array<string>,
): void {
  const entries = Array.isArray(fingerprint) ? fingerprint : [fingerprint];
  entries.forEach((entry, index) => {
    const fieldPath = Array.isArray(fingerprint)
      ? `remotes.${name}.hostKeyFingerprint.${index}`
      : `remotes.${name}.hostKeyFingerprint`;
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
 * the job data root, and the referenced file must exist at load time. The
 * existence check is `statSync` only -- the secret bytes are never read into
 * the server; the CLI child resolves the reference at exchange time. The
 * data-root exclusion closes a laundering path: a job's workdir is
 * client-written, so a reference under the data root would let one job plant
 * the next job's credential file. Error messages name the field path only,
 * never the value.
 */
function assertCredentialRef(
  name: string,
  field: (typeof CREDENTIAL_REF_FIELDS)[number],
  value: string | undefined,
  resolvedDataRoot: string,
): void {
  if (value === undefined) return;
  const fieldPath = `remotes.${name}.${field}`;
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
  const relative = path.relative(resolvedDataRoot, resolvedRef);
  const escapesDataRoot =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (!escapesDataRoot)
    throw new JobApiConfigError(
      `${fieldPath} must not reference a file under the job data root`,
    );
  try {
    fs.statSync(resolvedRef);
  } catch {
    throw new JobApiConfigError(
      `${fieldPath} references a file that does not exist`,
    );
  }
}

/**
 * Run the entry through core's connection schema as `{channel: "sftp", server}`
 * so core's cross-field refines (one primary auth method, passphrase requires
 * a key, keyboard-interactive requires a password, fingerprint canonical form)
 * hold at boot, not first at exchange time inside the CLI child.
 */
function assertComposesThroughCoreSchema(
  name: string,
  entry: JobSftpRemoteEntry,
): void {
  const composed = ConnectionConfigSchema.safeParse({
    channel: "sftp",
    server: entry,
  });
  if (!composed.success)
    throw new JobApiConfigError(formatIssues(name, composed.error.issues));
}
