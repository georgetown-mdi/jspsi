import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Contents of a `.psilink.key` file. */
export interface KeyFile {
  /** Shared SPAKE2 token; injected into the connection config at runtime. */
  pakeToken: string;
  /** ISO 8601 datetime after which the token should be considered expired. */
  expires?: string;
}

const KeyFileSchema: z.ZodType<KeyFile> = z.object({
  pakeToken: z.string().min(1),
  expires: z.iso.datetime().optional(),
});

/** Load and parse a `.psilink.key` file; returns `undefined` if absent. */
export function loadKeyFile(keyFilePath: string): KeyFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(keyFilePath, "utf8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return KeyFileSchema.parse(raw);
}

/** Serialize and write a {@link KeyFile} to disk. */
export function saveKeyFile(keyFilePath: string, data: KeyFile): void {
  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
  fs.writeFileSync(keyFilePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
