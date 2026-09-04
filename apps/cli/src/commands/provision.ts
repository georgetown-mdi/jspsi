import fs from "node:fs";
import path from "node:path";
import { causeChainSome, UsageError } from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

import { DEFAULT_CONFIG_PATH, saveConfig } from "../config";
import { detectFileConflicts } from "../fileUtils";
import { DEFAULT_KEY_PATH, saveKeyFile, type KeyFile } from "../keyFile";

/**
 * Target paths for {@link provisionConfigAndKey}. Each defaults to the path the
 * `exchange` command reads from, so a provisioned pair is found without explicit
 * flags.
 */
export interface ProvisionTargets {
  /** Where to write `psilink.yaml`; defaults to {@link DEFAULT_CONFIG_PATH}. */
  configPath?: string;
  /** Where to write `.psilink.key`; defaults to {@link DEFAULT_KEY_PATH}. */
  keyPath?: string;
}

function resolveTargets(targets: ProvisionTargets): {
  configPath: string;
  keyPath: string;
} {
  return {
    configPath: targets.configPath ?? DEFAULT_CONFIG_PATH,
    keyPath: targets.keyPath ?? DEFAULT_KEY_PATH,
  };
}

/**
 * Which target paths the conflict gate checks for a pre-existing file. The
 * accept path checks only `"key"` (it reconciles a pre-existing config rather
 * than aborting); the online invite path checks only `"config"` (a pre-existing
 * key is a warning there, not a conflict). The same-path guard always runs,
 * regardless of which targets are checked.
 */
export type ConflictTarget = "config" | "key";

function throwIfConflicts(
  configPath: string,
  keyPath: string,
  check: ConflictTarget[] = ["config", "key"],
): void {
  // Config and key paths must differ, or saveKeyFile's write would silently
  // overwrite saveConfig's. Resolve first so `./x` and `x` compare equal.
  // Always runs, even when only one target is checked: a narrowed caller still
  // writes both files.
  if (path.resolve(configPath) === path.resolve(keyPath))
    throw new UsageError(
      `config file and key file must be different paths; both resolve to ` +
        path.resolve(configPath),
    );
  const paths: string[] = [];
  if (check.includes("config")) paths.push(configPath);
  if (check.includes("key")) paths.push(keyPath);
  const conflicts = detectFileConflicts(paths);
  if (conflicts.length > 0) {
    const noun = conflicts.length === 1 ? "file" : "files";
    throw new UsageError(
      `refusing to overwrite existing ${noun}: ${conflicts.join(", ")}; ` +
        "move or remove it, or pass --config-file / --key-file to write " +
        "elsewhere",
    );
  }
}

/**
 * Throw a {@link UsageError} if a config or key file already exists at a
 * target path, naming the conflicting path(s). Writes nothing, so a command
 * can call this before any network activity to abort a bootstrap that would
 * otherwise clobber an existing configuration.
 *
 * A check, not a lock: a file created between this check and the subsequent
 * write is still overwritten. It catches a pre-existing config; it does not
 * serialize concurrent provisioners.
 */
export function assertNoProvisionConflicts(
  targets: ProvisionTargets = {},
  check: ConflictTarget[] = ["config", "key"],
): void {
  const { configPath, keyPath } = resolveTargets(targets);
  throwIfConflicts(configPath, keyPath, check);
}

/** Options for {@link provisionConfigAndKey}. */
export interface ProvisionOptions {
  /**
   * Keep a pre-existing config file at the target path instead of writing one:
   * the caller has already reconciled it against the invitation (and, online,
   * the URL) and confirmed it agrees, so only the key file is written. The key
   * path is still gated -- a pre-existing key remains a hard conflict -- while
   * the config write (and its failure rollback) are skipped, so the user's
   * config is never touched. Default `false`: write both files, gating both.
   */
  reuseExistingConfig?: boolean;
}

/**
 * The {@link provisionConfigAndKey} failures whose rollback left an
 * already-written config on disk. Keyed on the propagating error object
 * rather than a property on it: that error comes from the key writer or the
 * filesystem, not this module, and a non-extensible object would turn the
 * marking itself into the failure reported.
 */
const failuresLeavingConfigOnDisk = new WeakSet<object>();

/**
 * Whether `error`, or any link in its `cause` chain, is a
 * {@link provisionConfigAndKey} failure whose already-written config is still on
 * disk because the rollback of that write also failed. A caller reporting what
 * did and did not persist reads this rather than probing the config path, where
 * a file is equally likely to be one this call never wrote.
 */
export function provisionLeftConfigOnDisk(error: unknown): boolean {
  return causeChainSome(error, (link) => failuresLeavingConfigOnDisk.has(link));
}

/**
 * Provision a config and key pair, refusing to clobber existing files.
 * Re-runs the conflict gate (safe to call even if the caller skipped
 * {@link assertNoProvisionConflicts}) and writes nothing if a gated target
 * exists. `keyData.expires` is written when set and omitted otherwise.
 *
 * With `options.reuseExistingConfig` (see {@link ProvisionOptions}), the
 * config write is skipped and only the key is written and gated. Before
 * writing the key, the config's presence is re-checked: if it was removed
 * since the caller reconciled it, this throws rather than orphaning a key
 * with no matching config.
 *
 * Both writers are atomic (temp file + rename; see
 * docs/spec/CREDENTIAL_STORAGE.md#posix-write-discipline) and clean up their
 * own temp file on failure. The config is written first, so a key-write
 * failure leaves it behind; this removes it before the error propagates,
 * except when reusing an existing config, which is the user's file. A failed
 * removal leaves the config on disk and marks the propagating error
 * ({@link provisionLeftConfigOnDisk}). The key path itself is never deleted
 * on failure, since saveKeyFile writes nothing there to remove. Parent
 * directories created for a nested target path are left in place.
 *
 * @returns the resolved paths (the key always written; the config only when
 *   not reusing an existing one).
 */
export function provisionConfigAndKey(
  spec: ExchangeSpec,
  keyData: KeyFile,
  targets: ProvisionTargets = {},
  options: ProvisionOptions = {},
): { configPath: string; keyPath: string } {
  const resolved = resolveTargets(targets);
  // Reusing an existing config gates only the key path; the config is
  // expected to be present. The same-path guard inside throwIfConflicts still
  // runs.
  throwIfConflicts(
    resolved.configPath,
    resolved.keyPath,
    options.reuseExistingConfig ? ["key"] : ["config", "key"],
  );
  // Outside the try: a saveConfig failure is atomic (nothing written), so it
  // propagates before the key is touched.
  if (options.reuseExistingConfig) {
    // Re-check the config's presence right before writing the key: if it was
    // removed since the caller reconciled it (the TOCTOU window between
    // reconcile and here), writing the key would orphan it. Nothing has been
    // written yet, so aborting here leaves no residue. Mirrors the online
    // hook's pre-write re-gate; the same-path guard already ran in
    // throwIfConflicts above.
    if (detectFileConflicts([resolved.configPath]).length === 0)
      throw new UsageError(
        `the configuration file at ${resolved.configPath} no longer exists; ` +
          "it was reconciled for reuse but has since been removed. Re-run the " +
          "command so a fresh configuration is written, or restore the file.",
      );
  } else {
    saveConfig(resolved.configPath, spec);
  }
  try {
    saveKeyFile(resolved.keyPath, keyData);
  } catch (err) {
    // Roll back only a config THIS call wrote; the key write left nothing, and a
    // reused config is the user's pre-existing file and must never be deleted.
    if (!options.reuseExistingConfig) {
      try {
        fs.rmSync(resolved.configPath, { force: true });
      } catch {
        // Best-effort rollback; the key-write error below is still the one
        // reported. Record the outcome on it: a caller that reported the
        // config as unsaved would misstate what the operator has to clean up
        // before re-provisioning.
        if (typeof err === "object" && err !== null)
          failuresLeavingConfigOnDisk.add(err);
      }
    }
    throw err;
  }
  return resolved;
}
