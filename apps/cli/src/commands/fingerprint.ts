import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import logLibrary from "loglevel";
import YAML from "yaml";

import {
  computeCertificateFingerprint,
  generateSigningIdentity,
  getLogger,
  serializeCertificate,
  UsageError,
} from "@psilink/core";
import type { SigningIdentity } from "@psilink/core";

import { DEFAULT_CONFIG_PATH } from "../config";
import {
  defaultSigningIdentityPath,
  loadSigningIdentity,
  saveSigningIdentity,
} from "../signingIdentityFile";
import { LOG_LEVELS } from "../util/cli";

// `psilink fingerprint` is the front door to the signing identity. Generation is
// LAZY and anchored here, not at exchange time: a party must display its
// fingerprint to share it before any signed exchange (the partner pins it
// out-of-band first), so the fingerprint command is the natural -- and earliest
// -- point at which the identity must exist. Creating it here (rather than via a
// separate keygen step) keeps the CLI surface minimal while respecting the
// pin-first ordering. Creation is announced, never silent; regeneration is a
// deliberate, gated action (`--force`) because it invalidates pins.

export function builder(cmd: Argv): Argv {
  return cmd
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
        "path to the signing identity file; overrides signing.identity_file " +
        "in the config (default: ~/.psilink/signing-identity.json)",
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
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    });
}

interface ConfigHints {
  identityFile?: string;
  identity?: string;
}

// Read identity-file and identity hints from the config without requiring a
// fully valid exchange spec: the fingerprint command may run before the rest of
// the config exists. A missing default config is silently ignored; a missing
// EXPLICIT --config-file, or malformed YAML, is a usage error.
/** @internal exported for testing */
export function readConfigHints(
  configFile: string | undefined,
  explicit: boolean,
): ConfigHints {
  const target = configFile ?? DEFAULT_CONFIG_PATH;
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
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err: unknown) {
    throw new UsageError(
      `config file ${target} is not valid YAML: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
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

/** The signing-identity action taken by {@link resolveSigningIdentity}. */
export type SigningIdentityAction = "Created" | "Regenerated" | "Loaded";

/** Inputs to {@link resolveSigningIdentity}, with paths/strings already
 * resolved from CLI flags and config hints. */
export interface ResolveSigningIdentityInput {
  identityPath: string;
  /** `--identity`; binds a new identity, or (with no existing file) names it. */
  identityArg?: string;
  /** `linkage_terms.identity` from the config, used when no `--identity`. */
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
 * identity unless `--identity` overrides. Returns the identity and the action
 * taken; never auto-creates at any path other than this one.
 *
 * @throws {UsageError} if no identity is available to bind a new key.
 * @internal exported for testing
 */
export function resolveSigningIdentity(input: ResolveSigningIdentityInput): {
  identity: SigningIdentity;
  action: SigningIdentityAction;
} {
  const existing = loadSigningIdentity(input.identityPath);
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
  const identity = generateSigningIdentity(identityString);
  saveSigningIdentity(input.identityPath, identity);
  return {
    identity,
    action: existing !== undefined ? "Regenerated" : "Created",
  };
}

function report(
  action: SigningIdentityAction,
  identityPath: string,
  identity: SigningIdentity,
  fingerprint: string,
): void {
  const cert = identity.certificate;
  console.log(
    `${action} signing identity (${cert.algorithm}) at ${identityPath}`,
  );
  console.log(`  Identity:    ${cert.identity}`);
  console.log(`  Fingerprint: ${fingerprint}`);
  console.log("");
  if (action === "Regenerated") {
    console.log(
      "WARNING: this is a NEW identity with a NEW fingerprint. Any partner who " +
        "pinned the previous fingerprint must re-pin the one above, or " +
        "verification of your receipts will fail.",
    );
    console.log("");
  }
  console.log(
    "Share the fingerprint with your partner over a trusted out-of-band " +
      "channel; they pin it as signing.partner_fingerprint. Keep the identity " +
      "file private (it holds your signing private key).",
  );
}

export async function handler(argv: Arguments): Promise<void> {
  const rawLogLevel = (
    (argv["log-level"] as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined) {
    console.error(`unrecognized log-level: ${argv["log-level"]}`);
    process.exit(64);
  }
  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger("fingerprint");

  const identityArg = argv["identity"] as string | undefined;
  const identityFileArg = argv["identity-file"] as string | undefined;
  const configFileArg = argv["config-file"] as string | undefined;
  const force = argv["force"] as boolean;
  const exportCertificate = argv["export-certificate"] as string | undefined;

  try {
    const hints = readConfigHints(configFileArg, configFileArg !== undefined);
    const identityPath =
      identityFileArg ?? hints.identityFile ?? defaultSigningIdentityPath();

    const { identity, action } = resolveSigningIdentity({
      identityPath,
      identityArg,
      configIdentity: hints.identity,
      force,
      log,
    });

    const fingerprint = await computeCertificateFingerprint(
      identity.certificate,
    );

    if (exportCertificate !== undefined)
      fs.writeFileSync(
        exportCertificate,
        serializeCertificate(identity.certificate),
      );

    report(action, identityPath, identity, fingerprint);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof UsageError ? 64 : 69);
  }
}
