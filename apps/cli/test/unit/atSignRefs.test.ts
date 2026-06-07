import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { resolveAtSignRefs } from "../../src/util/atSignRefs";

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
