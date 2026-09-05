import fs from "node:fs";
import path from "node:path";

import { FINGERPRINT_REGEX } from "@psilink/core";

import { WORKDIR_MODE, jobFileExists, resolveWorkdirFile } from "./workdir";
import { runCapturedCliChild } from "./capturedCliChild";

/**
 * The console's signing-identity driver. It spawns the CLI's `fingerprint`
 * subcommand -- the same binary the exchange runs -- rather than
 * re-implementing key generation, certificate binding, or the fingerprint
 * digest.
 *
 * The command is create-or-reuse (`apps/cli/src/commands/fingerprint.ts`);
 * the console never passes `--force`.
 *
 * The child's stdout fingerprint is re-validated against core's canonical
 * regex; stderr is discarded (it can name filesystem paths), and the child
 * is watchdog-bounded.
 */

/**
 * The signing identity file's name inside the console's mounted data root.
 *
 * Dot-prefixed so the input listing's admissibility rule
 * ({@link isAdmissibleInputName}) excludes it from the operator's input
 * picker. Lives in the mount, not a job workdir, since the identity
 * outlives any one job.
 */
export const SIGNING_IDENTITY_FILE_NAME = ".psilink-signing-identity.json";

/**
 * The exported certificate's name in the same mount. The PUBLIC half only: the
 * CLI's `--export-certificate` writes the certificate without the private key,
 * and the export is not dot-prefixed because it is the artifact the operator is
 * meant to find and hand to their partner.
 */
export const SIGNING_CERTIFICATE_FILE_NAME = "psilink-certificate.json";

/**
 * A fixed-name file's absolute path in the console's mounted data root,
 * resolved through the same containment check a job artifact's path takes
 * ({@link resolveWorkdirFile}) rather than joined. Both names below are
 * server constants; a null resolution is a caller bug and throws here
 * rather than falling back to a path outside the mount.
 */
function mountFilePath(dataRoot: string, name: string): string {
  const filePath = resolveWorkdirFile(dataRoot, name);
  if (filePath === null)
    throw new Error(`${name} did not resolve inside the mounted data root`);
  return filePath;
}

/**
 * The signing identity file's absolute path under `dataRoot`, the console's
 * single mounted working directory.
 */
export function signingIdentityPath(dataRoot: string): string {
  return mountFilePath(dataRoot, SIGNING_IDENTITY_FILE_NAME);
}

/** The exported certificate's absolute path under the same mount. */
export function signingCertificatePath(dataRoot: string): string {
  return mountFilePath(dataRoot, SIGNING_CERTIFICATE_FILE_NAME);
}

/**
 * Refuse an export path that resolves to the identity file itself, matching
 * the CLI's own `--export-certificate` guard
 * (`apps/cli/src/commands/fingerprint.ts`): overwriting it would destroy the
 * private key and every partner pin.
 *
 * Comparison is lexical on resolved paths: the export's `rename()` replaces
 * a symlink rather than following it, so only a path naming the identity
 * file itself needs catching.
 */
export function assertExportPathDistinct(
  identityPath: string,
  exportPath: string,
): void {
  if (path.resolve(exportPath) === path.resolve(identityPath))
    throw new Error(
      "the certificate export path is the signing identity file itself; " +
        "exporting there would overwrite the private key with the public " +
        "certificate",
    );
}

/**
 * The server-side watchdog for a fingerprint child. Key generation and a file
 * write are fast and local -- there is no network leg at all -- so the budget is
 * generous rather than tuned, and its only job is to keep a wedged child from
 * holding the endpoint open. The SIGTERM-then-SIGKILL escalation it feeds belongs
 * to the shared spawn boundary ({@link runCapturedCliChild}); only the budget is
 * this driver's.
 */
const FINGERPRINT_SIGTERM_MS = 15_000;
/** The grace before the watchdog escalates SIGTERM to SIGKILL. */
const FINGERPRINT_SIGKILL_GRACE_MS = 5_000;

/**
 * The reconciled outcome of a fingerprint attempt:
 * - `ok`: identity created or loaded, fingerprint read. `created`
 *   distinguishes the two; `certificateExported` is true only when an
 *   export was requested and the child exited cleanly.
 * - `refused`: the CLI exited 64 (usage error). The request is schema-valid
 *   and every path is server-composed, so the cause is a condition in the
 *   console's mounted working directory (an unreadable or unparsable
 *   identity file, a create/delete race, a failed certificate-export
 *   write, or a malformed default `psilink.yaml`; see
 *   {@link runSigningFingerprint}) -- not distinguishable here since stderr
 *   is discarded, so all are reported as one category.
 * - `timeout`: the watchdog killed the child.
 * - `error`: any other non-zero exit, no valid fingerprint line, or the
 *   child could not be spawned.
 */
export type SigningFingerprintResult =
  | {
      kind: "ok";
      fingerprint: string;
      created: boolean;
      certificateExported: boolean;
    }
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "error" };

/**
 * Parse and re-validate the child's single stdout line. The command prints the
 * bare fingerprint value and nothing else there, so a line that is not a
 * canonical digest is an error rather than a value to show.
 *
 * @internal exported for testing
 */
export function parseFingerprintStdout(stdout: string): string | undefined {
  const line = stdout.trim();
  return FINGERPRINT_REGEX.test(line) ? line : undefined;
}

/**
 * Reconcile the fingerprint child's exit. Exit 64 is the CLI's usage-error code,
 * reported as the actionable `refused` rather than a generic failure -- what that
 * category covers, and why its causes are not told apart, is on
 * {@link SigningFingerprintResult}. `stdout` is undefined when the read overflowed
 * the cap.
 *
 * @internal exported for testing
 */
export function reconcileFingerprintExit(
  code: number | null,
  stdout: string | undefined,
  context: { created: boolean; exportRequested: boolean },
): SigningFingerprintResult {
  if (code === 64) return { kind: "refused" };
  if (code !== 0 || stdout === undefined) return { kind: "error" };
  const fingerprint = parseFingerprintStdout(stdout);
  if (fingerprint === undefined) return { kind: "error" };
  return {
    kind: "ok",
    fingerprint,
    created: context.created,
    certificateExported: context.exportRequested,
  };
}

/**
 * The argv a fingerprint run drives: a fixed template plus two
 * server-composed absolute paths and the operator's identity label. Each
 * value-bearing flag is a single `--flag=value` token so a `-`-leading
 * label cannot be misparsed by yargs as its own flag.
 *
 * No `--config-file`: the CLI falls back to `./psilink.yaml` relative to
 * the child's cwd, bounded by the pinned `cwd` ({@link runSigningFingerprint}).
 * No `--force`.
 *
 * @internal exported for testing
 */
export function fingerprintArgv(args: {
  binaryPath: string;
  identityPath: string;
  identityLabel: string;
  exportPath?: string;
}): Array<string> {
  return [
    args.binaryPath,
    "fingerprint",
    `--identity-file=${args.identityPath}`,
    `--identity=${args.identityLabel}`,
    ...(args.exportPath !== undefined
      ? [`--export-certificate=${args.exportPath}`]
      : []),
  ];
}

/**
 * Spawn the CLI's `fingerprint` subcommand against the console's mounted
 * identity file and reconcile its outcome via the shared spawn boundary
 * ({@link runCapturedCliChild}): array argv with no shell, capped stdout,
 * discarded stderr, and the watchdog. This driver owns the argv, the two
 * budgets, and the exit-to-result mapping.
 *
 * `created` is read from the identity file's presence before the child
 * runs, not from its stderr banner, which this boundary discards.
 *
 * The child's cwd is pinned to the identity file's directory rather than
 * inherited, since an inherited cwd would let an unmounted `psilink.yaml`
 * decide the CLI's default config lookup. The directory is created if
 * missing, owner-only.
 *
 * @throws {Error} synchronously, before any child spawns, when the export
 *   path names the identity file ({@link assertExportPathDistinct}) -- a
 *   caller bug, not a run outcome; the manager's `async` wrapper turns it
 *   into a rejection for its own callers.
 */
export function runSigningFingerprint(args: {
  binaryPath: string;
  identityPath: string;
  identityLabel: string;
  exportPath?: string;
  childEnv?: NodeJS.ProcessEnv;
  sigtermMs?: number;
  sigkillGraceMs?: number;
}): Promise<SigningFingerprintResult> {
  if (args.exportPath !== undefined)
    assertExportPathDistinct(args.identityPath, args.exportPath);
  const created = !jobFileExists(args.identityPath);
  const childCwd = path.dirname(path.resolve(args.identityPath));
  try {
    fs.mkdirSync(childCwd, { recursive: true, mode: WORKDIR_MODE });
  } catch {
    // A mount path occupied by a regular file returns a result kind rather
    // than rejecting: the endpoint reconciles kinds, and the one rejection this
    // driver raises is the export-path caller bug above.
    return Promise.resolve({ kind: "error" });
  }

  return runCapturedCliChild({
    argv: fingerprintArgv(args),
    cwd: childCwd,
    ...(args.childEnv !== undefined ? { childEnv: args.childEnv } : {}),
    sigtermMs: args.sigtermMs ?? FINGERPRINT_SIGTERM_MS,
    sigkillGraceMs: args.sigkillGraceMs ?? FINGERPRINT_SIGKILL_GRACE_MS,
  }).then((outcome): SigningFingerprintResult => {
    if (outcome.kind === "spawnFailed") return { kind: "error" };
    if (outcome.kind === "timedOut") return { kind: "timeout" };
    return reconcileFingerprintExit(outcome.code, outcome.stdout, {
      created,
      exportRequested: args.exportPath !== undefined,
    });
  });
}
