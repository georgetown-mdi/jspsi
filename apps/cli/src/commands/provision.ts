import fs from "node:fs";
import path from "node:path";
import { UsageError } from "@psilink/core";
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
  // Reject the same destination for both files. Without this, when neither
  // exists the conflict check passes and saveConfig's YAML is immediately
  // overwritten by saveKeyFile's JSON, silently producing a key file at the
  // config path. Resolve first so `./x` and `x` are recognized as the same path.
  // Always run this guard, even when only one target's existence is checked: the
  // accept/invite callers that narrow `check` still write both files.
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
 * Throw a {@link UsageError} if a config or key file already exists at a target
 * path, naming the conflicting path(s). Writes nothing and opens no connection,
 * so a command can call this up front -- before any network activity -- to abort
 * a bootstrap that would otherwise clobber an existing configuration partway
 * through an exchange.
 *
 * This is a check, not a lock: a file appearing between this check and the
 * subsequent write would still be overwritten. That race is immaterial for an
 * interactive single-user CLI bootstrap; the gate's purpose is to catch a
 * pre-existing config, not to serialize concurrent provisioners.
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
 * Provision a config and key pair, refusing to clobber existing files. Re-runs
 * the conflict gate (so it is safe to call even if the caller skipped the
 * up-front {@link assertNoProvisionConflicts}) and writes nothing if a gated
 * target exists. `keyData.expires` is written when set and omitted otherwise.
 *
 * With `options.reuseExistingConfig`, the config write is skipped and only the
 * key file is written and gated: for the accept path, where a pre-existing
 * config has already been reconciled against the invitation and is kept as-is.
 * The user's config is never written or deleted in that case.
 *
 * Both writers are atomic (temp file + rename) and clean up their own temp on
 * failure, so a failed write leaves nothing at its destination. The config is
 * written first; only if the key write then fails is there a residue -- the
 * already-written config -- which is removed before the error propagates (but
 * never when reusing an existing config: that file is the user's, not this
 * call's). The key path is never deleted on failure: saveKeyFile guarantees
 * nothing was written there, so removing it could only ever delete a file this
 * call did not write (e.g. one that appeared in the conflict gate's TOCTOU
 * window). Parent directories created for a nested target path are left in place.
 *
 * @returns the resolved paths (the key always written; the config written only
 *   when not reusing an existing one).
 */
export function provisionConfigAndKey(
  spec: ExchangeSpec,
  keyData: KeyFile,
  targets: ProvisionTargets = {},
  options: ProvisionOptions = {},
): { configPath: string; keyPath: string } {
  const resolved = resolveTargets(targets);
  // When reusing the existing config, gate only the key path: the config is
  // expected to be present (that is the whole point), so checking it would
  // wrongly abort. The same-path guard inside throwIfConflicts still runs.
  throwIfConflicts(
    resolved.configPath,
    resolved.keyPath,
    options.reuseExistingConfig ? ["key"] : ["config", "key"],
  );
  // Outside the try: a saveConfig failure is atomic, so nothing was written and
  // there is nothing to roll back -- let it propagate before the key is touched.
  if (!options.reuseExistingConfig) saveConfig(resolved.configPath, spec);
  try {
    saveKeyFile(resolved.keyPath, keyData);
  } catch (err) {
    // Roll back only a config THIS call wrote; the key write left nothing, and a
    // reused config is the user's pre-existing file and must never be deleted.
    if (!options.reuseExistingConfig) {
      try {
        fs.rmSync(resolved.configPath, { force: true });
      } catch {
        // Best-effort rollback; surface the original write error below.
      }
    }
    throw err;
  }
  return resolved;
}
