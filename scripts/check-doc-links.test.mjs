import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findFailures } from "./check-doc-links.mjs";

// findFailures resolves relative targets against dirname(absPath), so a fixed
// absPath inside this directory is enough -- the fixture doc never needs to
// exist on disk, but the "missing" targets must not exist here.
const here = dirname(fileURLToPath(import.meta.url));
const file = "fixture.md";
const absPath = resolve(here, file);

describe("check-doc-links inline code spans", () => {
  it("does not flag a link-shaped substring inside an inline code span", () => {
    const raw =
      "The pattern `/^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9])?$/` validates the field.\n";
    expect(findFailures(file, absPath, raw)).toEqual([]);
  });

  it("still flags a dead link", () => {
    const raw = "[broken](missing.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:1  dead path -> missing.md`]);
  });

  it("reports the correct line for a dead link positioned after a stripped span", () => {
    const raw = "line1 with code `](x)` span\nline2\n[broken](missing2.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:3  dead path -> missing2.md`]);
  });

  it("does not let a code span crossing a newline hide or shift a later dead link", () => {
    const raw =
      "para `open code\nspanning two lines` end\n[broken](missing3.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:3  dead path -> missing3.md`]);
  });

  it("closes a multi-backtick span containing a single backtick without hiding a later dead link", () => {
    const raw = "text ``a`b`` and [broken](missing4.md) after\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:1  dead path -> missing4.md`]);
  });

  it("reports the correct line for a dead link after a multi-line HTML comment", () => {
    const raw =
      "<!-- example [link](syntax.md) lives here\nacross\nseveral\nlines -->\nline5\n[broken](missing5.md)\n";
    const failures = findFailures(file, absPath, raw);
    expect(failures).toEqual([`${file}:6  dead path -> missing5.md`]);
  });
});
