import fs from "node:fs";

import { expandTilde } from "../fileUtils";

export function resolveAtSignRefs(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("@"))
    // The text after `@` is a local path, so a leading `~` is expanded to the
    // home directory (e.g. `@~/secrets/id_rsa`).
    return fs.readFileSync(expandTilde(obj.slice(1)), "utf8").trim();
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
