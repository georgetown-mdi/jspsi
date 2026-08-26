import fs from "node:fs";
import path from "node:path";

import { spawn } from "node:child_process";

import { FINGERPRINT_REGEX } from "@psilink/core";

import { WORKDIR_MODE, jobFileExists, resolveWorkdirFile } from "./workdir";
import { sanitizedChildEnv } from "./cliDriver";

import type { ChildProcess } from "node:child_process";

/**
 * The appliance's signing-identity driver. It spawns the CLI's `fingerprint`
 * subcommand -- the same binary the exchange runs -- so the console never
 * re-implements key generation, certificate binding, or the fingerprint digest:
 * the one authority on all three stays `psilink fingerprint`, and the console is
 * a caller of it.
 *
 * The command is create-or-reuse by design (see the header of
 * `apps/cli/src/commands/fingerprint.ts`): a party must be able to show its
 * fingerprint before any signed exchange, because the partner pins it
 * out-of-band first, so the identity is created at the moment the operator asks
 * to see the fingerprint rather than at run time. The console never passes
 * `--force`: regeneration invalidates every fingerprint a partner has pinned,
 * and a coordinated action of that weight belongs on the command line, where the
 * flag names what it does, rather than behind a button beside the pin it breaks.
 *
 * Every value crossing back is re-validated at this trust boundary: the
 * fingerprint against core's canonical regex, and nothing else is read at all --
 * stderr is discarded (it can name paths), and the child is watchdog-bounded so
 * the endpoint's latency stays bounded.
 */

/**
 * The signing identity file's name inside the appliance's mounted data root.
 *
 * Dot-prefixed for the same reason the CLI's key file is: it holds a private key,
 * and the work-input listing's own admissibility rule excludes a leading dot
 * ({@link isAdmissibleInputName}), so the file cannot turn up in the operator's
 * input picker as a selectable CSV. It lives in the MOUNT rather than in a job
 * workdir because the identity is long-lived -- one identity serves every
 * exchange and every partner, and a partner's pin must keep matching -- while a
 * job workdir is removed with its job.
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
 * A fixed-name file's absolute path in the appliance's mounted data root,
 * resolved through the same containment check a job artifact's path takes
 * ({@link resolveWorkdirFile}) rather than joined. Both names below are server
 * constants, so a null resolution is a caller bug -- a constant that stopped
 * resolving inside the mount -- refused here instead of naming a file somewhere
 * else on the host that the CLI would then read a private key from or write a
 * certificate over.
 */
function mountFilePath(dataRoot: string, name: string): string {
  const filePath = resolveWorkdirFile(dataRoot, name);
  if (filePath === null)
    throw new Error(`${name} did not resolve inside the mounted data root`);
  return filePath;
}

/**
 * The signing identity file's absolute path under `dataRoot`, the appliance's
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
 * Refuse an export path that resolves to the identity file itself.
 *
 * The CLI raises this refusal too, and it is the enforcement that matters -- the
 * console is a caller, and a caller cannot vouch for the callee. This is the
 * console's own statement of the same rule, held where the two paths are
 * composed: writing the public certificate over the identity file would destroy
 * the private key and every pin a partner holds, so "the console never composes
 * such a pair" is encoded as a check that fails rather than as a comment that
 * cannot.
 *
 * Lexical, exactly as the CLI's is, and lexical is enough for the reason the CLI
 * records beside its own copy (`apps/cli/src/commands/fingerprint.ts`, the
 * `--export-certificate` guard): the export is written with `writeFileAtomic`,
 * which finishes with `rename()`, and renaming onto a symlink's path replaces the
 * LINK rather than following it -- so the variant a lexical compare misses, an
 * export path that merely resolves to the identity file, leaves the private key
 * intact. What has to be caught is the path that names the identity file itself,
 * and comparing resolved paths catches every spelling of that.
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
 * holding the endpoint open. Mirrors the host-key probe's SIGTERM-then-SIGKILL
 * escalation.
 */
export const FINGERPRINT_SIGTERM_MS = 15_000;
/** The grace before the watchdog escalates SIGTERM to SIGKILL. */
export const FINGERPRINT_SIGKILL_GRACE_MS = 5_000;

/**
 * The cap on retained child stdout, in UTF-16 code units. The command emits ONE
 * short fingerprint line on stdout (every diagnostic goes to stderr), so anything
 * past a few KiB is a malformed or hostile child and the read is bounded rather
 * than left to grow.
 */
const FINGERPRINT_STDOUT_CAP = 4096;

/**
 * The reconciled outcome of a fingerprint attempt:
 * - `ok`: the identity exists (created now or loaded) and its fingerprint was
 *   read; `created` distinguishes the two, so the console can say which happened.
 *   `certificateExported` is true when an export was asked for and the child
 *   exited cleanly, so the copy names a file that is actually there.
 * - `refused`: the CLI exited 64, its usage-error code. The request cannot be the
 *   cause -- the endpoint's schema requires a non-empty identity label, and every
 *   path is server-composed -- so what is left are conditions in the appliance's
 *   mounted working directory: an identity file that cannot be read or parsed, a
 *   first-time exclusive create that kept losing a create/delete race, a failed
 *   certificate-export write, or a malformed `psilink.yaml` sitting in that same
 *   folder (the child reads its default config there for hints; see
 *   {@link runSigningFingerprint}). Which of them it was is NOT observable here
 *   (stderr names container paths and is discarded), so the whole class is
 *   reported as one category the operator can act on in their own folder, apart
 *   from a generic failure.
 * - `timeout`: the watchdog killed the child.
 * - `error`: the child exited non-zero for another reason, emitted no valid
 *   fingerprint line, or could not be spawned.
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
 * The argv a fingerprint run drives. A fixed template plus two server-composed
 * absolute paths and the operator's identity label, every value-bearing flag
 * emitted as a single `--flag=value` token so a `-`-leading label cannot be
 * misparsed by yargs as its own flag. There is no `--config-file`: the console
 * composes a config per job, and no job exists at the moment the operator asks
 * for their fingerprint. Omitting it does not mean nothing is read off disk --
 * the CLI falls back to its default `./psilink.yaml` for identity hints, relative
 * to the CHILD's working directory -- so what bounds the search is the explicit
 * `cwd` the spawn pins ({@link runSigningFingerprint}), not this argv. There is
 * no `--force`.
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
 * Spawn the CLI's `fingerprint` subcommand against the appliance's mounted
 * identity file and reconcile its outcome. The argv is an array with no shell --
 * the same allowlisted-argv discipline `runCliChild` and the host-key probe use
 * -- so no value is ever an interpretable token. stdout is capped and parsed;
 * stderr is DISCARDED (drained so the pipe never blocks the child, but never read
 * or forwarded: it names filesystem paths inside the container).
 *
 * Whether the identity already existed is read HERE, before the child runs,
 * rather than from the child's own "Created"/"Loaded" banner: the banner is on
 * the stderr this boundary discards, and the file's presence is a fact the server
 * owns either way.
 *
 * The child's working directory is pinned to the directory holding the identity
 * file -- the appliance's mounted data root -- rather than inherited from the
 * server. With `--config-file` omitted the CLI reads its default `./psilink.yaml`
 * for identity hints, resolved against whatever directory the child runs in, so
 * an inherited cwd would let a document the operator never mounted decide the
 * outcome (a malformed one exits 64, which this boundary reports as a condition
 * in the operator's own folder). Pinning it makes the mount the only place that
 * config can come from, matching where the identity itself lives. The directory
 * is created if missing on the same owner-only terms a workdir is, because a
 * spawn cannot start in a directory that does not exist yet while the CLI would
 * have created the mount for its own write.
 *
 * @throws {Error} SYNCHRONOUSLY, before any child is spawned, when the export
 *   path names the identity file ({@link assertExportPathDistinct}). Not a
 *   rejection, because it is a caller bug rather than a run outcome, and failing
 *   before the spawn is what keeps a bugged call from touching the file at all;
 *   the manager's `async` wrapper turns it into a rejection for its own callers.
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
  const argv = fingerprintArgv(args);
  const childCwd = path.dirname(path.resolve(args.identityPath));

  return new Promise<SigningFingerprintResult>((resolve) => {
    let child: ChildProcess;
    try {
      fs.mkdirSync(childCwd, { recursive: true, mode: WORKDIR_MODE });
      child = spawn(process.execPath, argv, {
        cwd: childCwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { ...sanitizedChildEnv(), ...args.childEnv },
      });
    } catch {
      resolve({ kind: "error" });
      return;
    }

    let stdout = "";
    let stdoutOverflow = false;
    const out = child.stdout;
    if (out !== null) {
      out.setEncoding("utf8");
      out.on("data", (chunk: string) => {
        if (stdoutOverflow) return;
        stdout += chunk;
        if (stdout.length > FINGERPRINT_STDOUT_CAP) {
          stdoutOverflow = true;
          stdout = "";
        }
      });
    }
    child.stderr?.resume();

    let timedOut = false;
    let settled = false;
    const timers: Array<NodeJS.Timeout> = [];
    const settle = (result: SigningFingerprintResult): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(result);
    };

    const toSigterm = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const toSigkill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, args.sigkillGraceMs ?? FINGERPRINT_SIGKILL_GRACE_MS);
      toSigkill.unref();
      timers.push(toSigkill);
    }, args.sigtermMs ?? FINGERPRINT_SIGTERM_MS);
    toSigterm.unref();
    timers.push(toSigterm);

    child.on("error", () => settle({ kind: "error" }));
    child.on("close", (code) => {
      if (timedOut) {
        settle({ kind: "timeout" });
        return;
      }
      settle(
        reconcileFingerprintExit(code, stdoutOverflow ? undefined : stdout, {
          created,
          exportRequested: args.exportPath !== undefined,
        }),
      );
    });
  });
}
