import fs from "node:fs";
import path from "node:path";

export function loadSharedSecret(configDir: string): string | undefined {
  const keyPath = path.join(configDir, "secret.key");
  if (!fs.existsSync(keyPath)) return undefined;
  return fs.readFileSync(keyPath, "utf8").trim();
}
