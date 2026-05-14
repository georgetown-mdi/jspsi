import fs from "node:fs";

export function resolveAtSignRefs(obj: unknown): unknown {
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
