import fs from "node:fs";
import { UsageError } from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

import { DEFAULT_CONFIG_PATH, saveConfig } from "../config";
import {
  DEFAULT_KEY_PATH,
  detectFileConflicts,
  saveKeyFile,
  type KeyFile,
} from "../keyFile";

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
 * Throw a {@link UsageError} if a config or key file already exists at a target
 * path, naming the conflicting path(s). Writes nothing and opens no connection,
 * so a command can call this up front -- before any network activity -- to abort
 * a bootstrap that would otherwise clobber an existing configuration partway
 * through an exchange.
 */
export function assertNoProvisionConflicts(
  targets: ProvisionTargets = {},
): void {
  const { configPath, keyPath } = resolveTargets(targets);
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
 * Provision a config and key pair, refusing to clobber existing files. Re-runs
 * the conflict gate (so it is safe to call even if the caller skipped the
 * up-front {@link assertNoProvisionConflicts}) and writes nothing if either
 * target exists. `keyData.expires` is written when set and omitted otherwise.
 *
 * If either write fails, both target paths are removed before the error
 * propagates: the conflict gate guaranteed neither pre-existed, so a failed
 * provision never leaves a half-written config or orphaned key behind.
 *
 * @returns the resolved paths actually written.
 */
export function provisionConfigAndKey(
  spec: ExchangeSpec,
  keyData: KeyFile,
  targets: ProvisionTargets = {},
): { configPath: string; keyPath: string } {
  const resolved = resolveTargets(targets);
  assertNoProvisionConflicts(resolved);
  try {
    saveConfig(resolved.configPath, spec);
    saveKeyFile(resolved.keyPath, keyData);
  } catch (err) {
    for (const p of [resolved.configPath, resolved.keyPath]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // Best-effort rollback; surface the original write error below.
      }
    }
    throw err;
  }
  return resolved;
}
