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

function throwIfConflicts(configPath: string, keyPath: string): void {
  // Reject the same destination for both files. Without this, when neither
  // exists the conflict check passes and saveConfig's YAML is immediately
  // overwritten by saveKeyFile's JSON, silently producing a key file at the
  // config path. Resolve first so `./x` and `x` are recognized as the same path.
  if (path.resolve(configPath) === path.resolve(keyPath))
    throw new UsageError(
      `config file and key file must be different paths; both resolve to ` +
        path.resolve(configPath),
    );
  const conflicts = detectFileConflicts([configPath, keyPath]);
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
): void {
  const { configPath, keyPath } = resolveTargets(targets);
  throwIfConflicts(configPath, keyPath);
}

/**
 * Provision a config and key pair, refusing to clobber existing files. Re-runs
 * the conflict gate (so it is safe to call even if the caller skipped the
 * up-front {@link assertNoProvisionConflicts}) and writes nothing if either
 * target exists. `keyData.expires` is written when set and omitted otherwise.
 *
 * Both writers are atomic (temp file + rename) and clean up their own temp on
 * failure, so a failed write leaves nothing at its destination. The config is
 * written first; only if the key write then fails is there a residue -- the
 * already-written config -- which is removed before the error propagates. The
 * key path is never deleted on failure: saveKeyFile guarantees nothing was
 * written there, so removing it could only ever delete a file this call did not
 * write (e.g. one that appeared in the conflict gate's TOCTOU window). Parent
 * directories created for a nested target path are left in place.
 *
 * @returns the resolved paths actually written.
 */
export function provisionConfigAndKey(
  spec: ExchangeSpec,
  keyData: KeyFile,
  targets: ProvisionTargets = {},
): { configPath: string; keyPath: string } {
  const resolved = resolveTargets(targets);
  throwIfConflicts(resolved.configPath, resolved.keyPath);
  // Outside the try: a saveConfig failure is atomic, so nothing was written and
  // there is nothing to roll back -- let it propagate before the key is touched.
  saveConfig(resolved.configPath, spec);
  try {
    saveKeyFile(resolved.keyPath, keyData);
  } catch (err) {
    // Roll back only the config this call just wrote; the key write left nothing.
    try {
      fs.rmSync(resolved.configPath, { force: true });
    } catch {
      // Best-effort rollback; surface the original write error below.
    }
    throw err;
  }
  return resolved;
}
