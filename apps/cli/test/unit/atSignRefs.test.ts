import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { UsageError } from "@psilink/core";
import type { SFTPConnectionConfig } from "@psilink/core";

import {
  resolveAtSignRef,
  resolveAtSignRefs,
  resolveConnectionCredentials,
} from "../../src/util/atSignRefs";

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-atsign-"));
  // Saved/restored around every test so the ~-expansion case can repoint HOME
  // without leaking into other tests.
  prevHome = process.env.HOME;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("returns a literal (non-@) value unchanged", () => {
  expect(resolveAtSignRefs("plain")).toBe("plain");
});

test("reads an @file reference and trims surrounding whitespace", () => {
  const p = path.join(dir, "secret.txt");
  fs.writeFileSync(p, "  s3cret\n");
  expect(resolveAtSignRefs(`@${p}`)).toBe("s3cret");
});

test("expands a leading ~ in an @file reference", () => {
  if (process.platform === "win32") return; // os.homedir() ignores $HOME here
  process.env.HOME = dir;
  fs.writeFileSync(path.join(dir, "id_rsa"), "KEYDATA\n");
  expect(resolveAtSignRefs("@~/id_rsa")).toBe("KEYDATA");
});

test("recurses into objects and arrays", () => {
  const p = path.join(dir, "v.txt");
  fs.writeFileSync(p, "V");
  expect(resolveAtSignRefs({ a: `@${p}`, b: ["x", `@${p}`] })).toEqual({
    a: "V",
    b: ["x", "V"],
  });
});

test("a missing @file reference is a UsageError naming the reference", () => {
  const missing = `@${path.join(dir, "absent")}`;
  expect(() => resolveAtSignRef(missing)).toThrow(UsageError);
  expect(() => resolveAtSignRef(missing)).toThrow(missing);
});

// --- resolveConnectionCredentials --------------------------------------------

function sftpConn(
  server: SFTPConnectionConfig["server"],
): SFTPConnectionConfig {
  return { channel: "sftp", server };
}

test("resolveConnectionCredentials resolves an @path password and private key", () => {
  const pwFile = path.join(dir, "pw");
  const keyFile = path.join(dir, "id_rsa");
  fs.writeFileSync(pwFile, "s3cret\n");
  fs.writeFileSync(keyFile, "KEYDATA\n");
  const resolved = resolveConnectionCredentials(
    sftpConn({
      host: "h",
      password: `@${pwFile}`,
      privateKey: `@${keyFile}`,
    }),
  ) as SFTPConnectionConfig;
  expect(resolved.server.password).toBe("s3cret");
  expect(resolved.server.privateKey).toBe("KEYDATA");
});

test("resolveConnectionCredentials leaves a literal credential unchanged", () => {
  const resolved = resolveConnectionCredentials(
    sftpConn({ host: "h", password: "literal-pw" }),
  ) as SFTPConnectionConfig;
  expect(resolved.server.password).toBe("literal-pw");
});

test("resolveConnectionCredentials does not mutate its input (the @path survives for persistence)", () => {
  const pwFile = path.join(dir, "pw2");
  fs.writeFileSync(pwFile, "s3cret\n");
  const original = sftpConn({ host: "h", password: `@${pwFile}` });
  const resolved = resolveConnectionCredentials(
    original,
  ) as SFTPConnectionConfig;
  expect(original.server.password).toBe(`@${pwFile}`);
  expect(resolved.server.password).toBe("s3cret");
});

test("resolveConnectionCredentials is a no-op on a filedrop connection", () => {
  const conn = { channel: "filedrop", path: "/mnt/share" } as const;
  expect(resolveConnectionCredentials(conn)).toBe(conn);
});

test("resolveConnectionCredentials surfaces a missing @path file as a UsageError", () => {
  const conn = sftpConn({ host: "h", password: `@${path.join(dir, "gone")}` });
  expect(() => resolveConnectionCredentials(conn)).toThrow(UsageError);
});
