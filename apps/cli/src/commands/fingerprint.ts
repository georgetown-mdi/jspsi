import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import path from "node:path";

import {
  computeCertificateFingerprint,
  generateSigningIdentity,
  getLogger,
  MAX_TEXT_LENGTH,
  sanitizeErrorForDisplay,
  serializeCertificate,
  TEXT_CONTROL_CHAR_MESSAGE,
  TEXT_CONTROL_CHAR_PATTERN,
  UsageError,
} from "@psilink/core";
import type { SigningIdentity } from "@psilink/core";

import { DEFAULT_CONFIG_PATH } from "../config";
import { expandTilde, FileExistsError, writeFileAtomic } from "../fileUtils";
import { addLoggingOptions } from "../optionDefinitions";
import { parseSensitiveYaml } from "../sensitiveFile";
import { warnOnIdentityDivergence } from "../signingIdentityDivergence";
import {
  loadSigningIdentity,
  saveSigningIdentity,
} from "../signingIdentityFile";
import {
  configureLogging,
  exitCodeForError,
  exitWithError,
  logLevelFlag,
  parseOrExit,
  singleValue,
} from "../util/cli";

// `psilink fingerprint` is the front door to the signing identity: generation
// is lazy and anchored here, not at exchange time, since a party must display
// its fingerprint to share it before any signed exchange. Creation is
// announced, never silent; regeneration is a gated action (`--force`) because
// it invalidates pins.
//
// Where the identity is kept is the OPERATOR's decision, never this
// command's: the file is a credential, so a run given no path refuses and
// says how to name one, rather than creating the identity somewhere the
// operator did not choose.

/**
 * What a run that names no identity path is told, in place of creating one.
 *
 * A single line: it renders through the display-boundary sanitizer, which
 * escapes a newline and truncates past `COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH`.
 * Holds the whole remedy -- both spellings of the path, the directory's
 * requirements, and the reuse-vs-new-identity guidance -- because psilink has
 * no way to tell the operator whether an earlier identity exists elsewhere.
 */
const NO_IDENTITY_PATH_REFUSAL =
  "no signing identity path is configured. Name the path and re-run -- " +
  "'psilink fingerprint --identity-file " +
  "/run/signing/psilink-signing-identity.json', or signing.identity_file in " +
  "the configuration. Its directory must be writable for this creating run; " +
  "every run after it only reads the file, so a read-only mount of its own " +
  "is right from then on. Choose somewhere " +
  "durable, and never a directory your partner syncs into -- that would put " +
  "your private signing key in their hands. If you already hold an identity " +
  "from an earlier release, name THAT file rather than creating a second one: " +
  "a new identity has a new fingerprint, and every partner has to re-pin it " +
  "before your receipts verify again.";

export function builder(cmd: Argv): Argv {
  const beforeLogging = cmd
    .usage("Usage: $0 fingerprint [options]")
    .option("identity", {
      type: "string",
      describe:
        "identity string to bind to a NEW signing identity (name, org, " +
        "contact); defaults to linkage_terms.identity from the config. Ignored " +
        "when an identity already exists unless --force is given",
    })
    .option("identity-file", {
      type: "string",
      describe:
        "path to the signing identity file, created there if absent; " +
        "overrides signing.identity_file in the config. Required unless the " +
        "config sets that field (example: " +
        "/run/signing/psilink-signing-identity.json)",
    })
    .option("config-file", {
      type: "string",
      describe: `exchange configuration file (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("force", {
      type: "boolean",
      default: false,
      describe:
        "regenerate the signing identity even if one exists. This creates a " +
        "NEW key with a NEW fingerprint and INVALIDATES any fingerprint a " +
        "partner has already pinned -- they must re-pin the new one",
    })
    .option("export-certificate", {
      type: "string",
      describe:
        "also write this party's public certificate (no private key) to the " +
        "given path, for sharing with a partner",
    });
  return addLoggingOptions(beforeLogging);
}

interface ConfigHints {
  identityFile?: string;
  identity?: string;
}

// Read identity-file and identity hints from the config without requiring a
// fully valid exchange spec: the fingerprint command may run before the rest of
// the config exists. A missing default config is silently ignored; a missing
// EXPLICIT --config-file, or malformed YAML, is a usage error.
//
// Tilde handling is split by design: the config-file path READ here is
// tilde-expanded, but the returned `identityFile`/`identity` hints are NOT --
// the handler expands the resolved identity path itself (it may instead come
// from --identity-file or the default). Keep that contract if refactoring.
/** @internal exported for testing */
export function readConfigHints(
  configFile: string | undefined,
  explicit: boolean,
): ConfigHints {
  const target = expandTilde(configFile ?? DEFAULT_CONFIG_PATH);
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (explicit)
        throw new UsageError(`config file ${target} does not exist`);
      return {};
    }
    throw new UsageError(
      `config file ${target} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  // The YAML parse can echo source bytes (an inline connection credential), so it
  // routes through the sensitive-file chokepoint, which reports path-only (see
  // sensitiveFile.ts).
  const raw = parseSensitiveYaml(text, `config file ${target}`);
  const root = (raw ?? {}) as Record<string, unknown>;
  const signing = (root["signing"] ?? {}) as Record<string, unknown>;
  const linkageTerms = (root["linkage_terms"] ??
    root["linkageTerms"] ??
    {}) as Record<string, unknown>;
  const identityFile = signing["identity_file"] ?? signing["identityFile"];
  const identity = linkageTerms["identity"];
  return {
    identityFile: typeof identityFile === "string" ? identityFile : undefined,
    identity: typeof identity === "string" ? identity : undefined,
  };
}

/**
 * Hold an identity label to the shape a linkage-terms document holds its
 * `identity` to, before it is bound into a certificate.
 *
 * The label reaches this command from `--identity` or `linkage_terms.identity`
 * without passing through `LinkageTermsSchema`, which is where every other
 * route into that field is bounded and refused a control character
 * ({@link TEXT_CONTROL_CHAR_PATTERN}); the console's fingerprint route applies
 * the same two rules at its own boundary. Unchecked here, the CLI would mint
 * certificates holding labels the terms document itself refuses -- and this one
 * is not a transient: it is bound into a long-lived certificate, read back and
 * DISPLAYED by whoever pinned the fingerprint, long after the run that chose it.
 *
 * Applied to the value actually being bound, whichever source supplied it, the
 * binding continued by a `--force` re-key included: what a new certificate
 * holds is what the check is about.
 *
 * Neither message echoes the label. The offending value is the operator's own
 * text and naming it back adds nothing to a rule about its shape, which is the
 * discipline the terms document's own refusals keep.
 */
function assertBindableIdentity(identity: string): void {
  if (TEXT_CONTROL_CHAR_PATTERN.test(identity))
    throw new UsageError(
      "the identity to bind into the signing certificate cannot be used: " +
        `${TEXT_CONTROL_CHAR_MESSAGE}. Supply one that has none, through ` +
        "--identity or linkage_terms.identity.",
    );
  if (identity.length > MAX_TEXT_LENGTH)
    throw new UsageError(
      "the identity to bind into the signing certificate is too long: it must " +
        `be at most ${MAX_TEXT_LENGTH} characters, the bound the linkage ` +
        "terms hold the same value to.",
    );
}

/** The signing-identity action taken by {@link resolveSigningIdentity}. */
export type SigningIdentityAction = "Created" | "Regenerated" | "Loaded";

/** Inputs to {@link resolveSigningIdentity}, with paths/strings already
 * resolved from CLI flags and config hints. */
export interface ResolveSigningIdentityInput {
  identityPath: string;
  /** `--identity`; binds a new identity, or (with no existing file) names it. */
  identityArg?: string;
  /** `linkage_terms.identity` from the config, used when no `--identity`, and
   * the value the resolved identity is checked for divergence against. */
  configIdentity?: string;
  /** `--force`: regenerate even if an identity already exists. */
  force: boolean;
  log: { warn: (message: string) => void };
}

/**
 * The lazy load-or-create decision behind `psilink fingerprint`, factored out so
 * it is unit-testable without the CLI plumbing. Loads the identity at
 * `identityPath`; if absent (or `force`), generates and persists a new one. A
 * `--force` regeneration of an existing identity re-keys it under the same bound
 * identity unless `--identity` overrides. Every path warns and proceeds when the
 * identity it resolves differs from `configIdentity`, a created binding and a
 * loaded one alike (see {@link warnOnIdentityDivergence}). Returns the identity
 * and the action taken; never auto-creates at any path other than this one.
 *
 * @throws {UsageError} if no identity is available to bind a new key, or if the
 *   one available fails {@link assertBindableIdentity}.
 * @internal exported for testing
 */
export async function resolveSigningIdentity(
  input: ResolveSigningIdentityInput,
): Promise<{
  identity: SigningIdentity;
  action: SigningIdentityAction;
}> {
  const warnIfDivergent = (identity: SigningIdentity): void => {
    warnOnIdentityDivergence(
      identity.certificate,
      input.configIdentity,
      input.log,
    );
  };

  // A file that exists but is unreadable (malformed/inconsistent) normally
  // shows up as an error. With --force the user has explicitly asked to
  // regenerate, so an unreadable existing file is treated as a file to replace
  // rather than a blocker -- this makes --force a genuine recovery path.
  let existing: SigningIdentity | undefined;
  let replacingUnreadable = false;
  try {
    existing = await loadSigningIdentity(input.identityPath);
  } catch (err) {
    if (!input.force) throw err;
    input.log.warn(
      `the existing signing identity at ${input.identityPath} could not be ` +
        `read (${sanitizeErrorForDisplay(err)}); --force ` +
        "regenerates it.",
    );
    replacingUnreadable = true;
  }

  if (existing !== undefined && !input.force) {
    if (
      input.identityArg !== undefined &&
      input.identityArg !== existing.certificate.identity
    )
      input.log.warn(
        `--identity is ignored: the existing identity is bound to ` +
          `"${existing.certificate.identity}". Use --force to regenerate ` +
          "(this invalidates any fingerprint your partner has pinned).",
      );
    warnIfDivergent(existing);
    return { identity: existing, action: "Loaded" };
  }
  // Create (no existing file) or regenerate (--force). For a re-key the identity
  // string defaults to the one already bound, so --force alone rotates the key
  // without changing the identity.
  const identityString =
    input.identityArg ??
    (existing !== undefined
      ? existing.certificate.identity
      : input.configIdentity);
  if (identityString === undefined || identityString.length === 0)
    throw new UsageError(
      "no identity available to create a signing identity; pass " +
        '--identity "Name, Organization, contact" or set ' +
        "linkage_terms.identity in the config",
    );
  assertBindableIdentity(identityString);
  const identity = await generateSigningIdentity(identityString);

  // A genuine first creation (no file on disk at all) is exclusive, so two
  // concurrent invocations cannot both generate and silently overwrite each
  // other. A --force regenerate (over a valid OR an unreadable file) is an
  // overwrite by design.
  if (existing === undefined && !replacingUnreadable) {
    // First-time creation is an atomic create-if-absent so two concurrent
    // first-time creators cannot both win. Under a race three things can happen:
    // we win (Created); we lose and the winner's file is present (adopt it,
    // Loaded); or we lose but the winner's file vanishes again before we can read
    // it (a create/delete flap). In that last case the path is free once more, so
    // retrying the exclusive create is exactly the right response -- bound the
    // retries so a pathological flap cannot spin forever, and report it as a
    // usage error rather than re-throwing a stale "already exists" for a file
    // that no longer exists.
    const MAX_CREATE_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        saveSigningIdentity(input.identityPath, identity, { exclusive: true });
        warnIfDivergent(identity);
        return { identity, action: "Created" };
      } catch (err) {
        if (!(err instanceof FileExistsError)) throw err;
        const winner = await loadSigningIdentity(input.identityPath);
        if (winner !== undefined) {
          input.log.warn(
            "another process created the signing identity concurrently; " +
              "using the existing file rather than overwriting it.",
          );
          // The winner's binding is the one in effect, so it -- not this
          // invocation's discarded intent -- is what the config is compared
          // against.
          warnIfDivergent(winner);
          return { identity: winner, action: "Loaded" };
        }
        // The winner's file disappeared between our failed create and our read,
        // so the path is free again; retry unless the flap persists.
        if (attempt >= MAX_CREATE_ATTEMPTS)
          throw new UsageError(
            `the signing identity file at ${input.identityPath} is being ` +
              "created and removed concurrently; re-run the command once the " +
              "conflicting process has finished.",
          );
      }
    }
  }

  saveSigningIdentity(input.identityPath, identity);
  warnIfDivergent(identity);
  return { identity, action: "Regenerated" };
}

// The fingerprint value is the command's sole result, so it goes to stdout (via
// console.log, regardless of log level) as a bare line so `FP=$(psilink
// fingerprint)` captures a clean value; all diagnostics route through the logger.
function report(
  log: ReturnType<typeof getLogger>,
  action: SigningIdentityAction,
  identityPath: string,
  identity: SigningIdentity,
  fingerprint: string,
): void {
  const cert = identity.certificate;
  log.info(`${action} signing identity (${cert.algorithm}) at ${identityPath}`);
  log.info(`  Identity: ${cert.identity}`);
  // The regeneration warning is a diagnostic, so it goes to stderr via log.warn
  // (not an ungated write): it obeys --log-level like every other warning, so a
  // re-key at --log-level error/silent shows only the new value with no warning.
  // This is by design -- --force is itself the explicit destructive gesture, and
  // the resolveSigningIdentity re-key/adopt warnings are likewise log.warn;
  // singling this one out as un-silenceable would be inconsistent, and an ungated
  // stderr write would also escape --log-file capture. The stdout-purity contract
  // requires only that the warning leave stdout (so a captured value stays clean),
  // which routing it through the logger satisfies at every level.
  if (action === "Regenerated")
    log.warn(
      "this is a NEW identity with a NEW fingerprint. Any partner who pinned " +
        "the previous fingerprint must re-pin the new one, or verification of " +
        "your receipts will fail.",
    );
  log.info(
    "Share the fingerprint with your partner over a trusted out-of-band " +
      "channel; they pin it as signing.partner_fingerprint. Keep the identity " +
      "file private (it holds your signing private key).",
  );
  // The result line: the bare fingerprint value on stdout, nothing else, so a
  // capture or pipe gets exactly the value. Printed last so on an interactive
  // terminal it follows the "Share the fingerprint" instruction pointing at it.
  console.log(fingerprint);
}

export async function handler(argv: Arguments): Promise<void> {
  // This command resolves and applies the log level before the logger exists, so
  // a bad --log-level is reported on stderr and exited 64 here (via the shared
  // parseOrExit boundary, the same one exchange/zeroSetup use) rather than
  // through the logger-based catch below. Both usage errors -- a repeated flag
  // and an unrecognized value -- reach that boundary as UsageErrors out of
  // logLevelFlag; the command reads only the log-level flag through it rather
  // than the shared bootstrap parser, which a fingerprint run does not need.
  const logLevel = parseOrExit(() => logLevelFlag(argv));
  // Install the sink, apply the level, and build getLogger("fingerprint") through
  // the shared configureLogging helper (in that order, so the logger inherits the
  // sink): the file sink when --log-file is given, otherwise the default stderr
  // sink, so the command's logged diagnostics (the preflight warnings and the
  // report's banner, bound identity, regeneration warning, and sharing
  // instructions) stay off stdout. report() prints only the bare fingerprint value
  // through console.log; everything else it emits routes through this logger.
  // singleValue rejects a repeated --log-file and configureLogFile rejects an
  // unopenable path; both are UsageErrors mapped to stderr + exit 64 by the
  // surrounding parseOrExit.
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: "fingerprint",
    }),
  );

  try {
    // Read the single-value flags through singleValue inside the try so a
    // repeated flag raises a UsageError mapped to exit 64 by the catch below.
    // `force` is a boolean (last-one-wins on repeat), so it keeps a plain cast.
    const identityArg = singleValue(argv, "identity") as string | undefined;
    const identityFileArg = singleValue(argv, "identity-file") as
      string | undefined;
    const configFileArg = singleValue(argv, "config-file") as
      string | undefined;
    const force = argv["force"] as boolean;
    const exportCertificate = singleValue(argv, "export-certificate") as
      string | undefined;
    const hints = readConfigHints(configFileArg, configFileArg !== undefined);
    const namedIdentityFile = identityFileArg ?? hints.identityFile;
    if (namedIdentityFile === undefined)
      throw new UsageError(NO_IDENTITY_PATH_REFUSAL);
    const identityPath = expandTilde(namedIdentityFile);

    const { identity, action } = await resolveSigningIdentity({
      identityPath,
      identityArg,
      configIdentity: hints.identity,
      force,
      log,
    });

    const fingerprint = await computeCertificateFingerprint(
      identity.certificate,
    );

    if (exportCertificate !== undefined) {
      const exportPath = expandTilde(exportCertificate);
      // Guard against the destructive fat-finger of pointing --export-certificate
      // at the identity file itself: that would overwrite the private-key-bearing
      // file with the public certificate alone, irrecoverably destroying the key
      // (and every fingerprint a partner has pinned). Compare resolved paths so a
      // relative or ~-form argument that names the same file is still caught. This
      // is a lexical compare, not a realpath one, so it does not catch a symlink
      // whose name differs but resolves to the identity file -- which is fine:
      // writeFileAtomic finishes with rename(), and renaming onto a symlink path
      // replaces the link itself, leaving the real target intact, so that variant
      // is non-destructive even when the lexical check misses it.
      if (path.resolve(exportPath) === path.resolve(identityPath))
        throw new UsageError(
          `--export-certificate path ${exportPath} is the signing identity ` +
            "file itself; refusing to overwrite the private key with the " +
            "public certificate. Choose a different path for the export.",
        );
      try {
        // Public, shareable artifact: world-readable and atomic, NOT owner-only.
        writeFileAtomic(exportPath, serializeCertificate(identity.certificate));
      } catch (err) {
        throw new UsageError(
          `could not write certificate to ${exportPath}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    report(log, action, identityPath, identity, fingerprint);
  } catch (err) {
    exitWithError(log, err, exitCodeForError(err));
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path. Writes are synchronous and already
    // durable, so exitWithError's process.exit (which bypasses this finally)
    // loses nothing -- this is only factory/descriptor cleanup.
    closeLogging();
  }
}
