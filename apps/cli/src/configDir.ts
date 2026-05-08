import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { parseExchangeSpec } from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

function resolveAtSignRefs(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("@"))
    return fs.readFileSync(obj.slice(1), "utf8").trim();
  if (Array.isArray(obj)) return obj.map(resolveAtSignRefs);
  if (obj !== null && typeof obj === "object")
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveAtSignRefs(v),
      ]),
    );
  return obj;
}

export function loadExchangeSpec(configDir: string): ExchangeSpec {
  const configPath = path.join(configDir, "config.yaml");
  if (!fs.existsSync(configPath))
    throw new Error(
      `no config file found at ${configPath}; run \`psilink invite\` to set ` +
        `up a new exchange, or specify an existing config directory with --config-dir`,
    );
  const content = fs.readFileSync(configPath, "utf8");
  const raw = YAML.parse(content) as unknown;
  return parseExchangeSpec(resolveAtSignRefs(raw));
}

export function loadPakeToken(configDir: string): string | undefined {
  const keyPath = path.join(configDir, "secret.key");
  if (!fs.existsSync(keyPath)) return undefined;
  return fs.readFileSync(keyPath, "utf8").trim();
}
